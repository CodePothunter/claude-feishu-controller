/**
 * Claude Code + Discord 桥接服务 - 主入口
 * Author: CodePothunter
 * Version: 1.0.0
 * License: MIT
 */

import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config, validateDiscordConfig, getConfigSummary } from './config/index.js';
import { DiscordAdapter } from './messenger/discord.js';
import { TmuxCommander } from './tmux/commander.js';
import { StateDetector } from './monitor/detector.js';
import { MessageRouter } from './handlers/router.js';
import { SessionManager } from './session-manager.js';
import { MessageDeduplicator } from './utils/deduplicator.js';
import { MessageHistory } from './utils/message-history.js';
import { TranscriptMonitor } from './transcript-monitor.js';
import { ProcessManager } from './utils/process-manager.js';
import { registerCommands } from './discord-commands.js';
import * as commands from './handlers/command.js';
import Logger from './utils/logger.js';

// 代理由 discord-proxy-bootstrap.mjs 通过 --import 配置
// 在 discord.js 加载前自动处理 REST API 和 WebSocket 代理

// 全局变量
let messenger = null;
let commander = null;
let detector = null;
let router = null;
let sessionManager = null;
let deduplicator = null;
let messageHistory = null;
let discordClient = null;
let transcriptMonitor = null;
let monitorTimeout = null;
let processManager = null;

// Discord 连接状态
let isDiscordConnected = false;

/**
 * 打印启动信息
 */
function printStartupInfo() {
  const summary = getConfigSummary();

  Logger.blank();
  Logger.info('╔════════════════════════════════════════════════════════════╗');
  Logger.info('║       Claude Code + Discord 桥接服务                      ║');
  Logger.info('╚════════════════════════════════════════════════════════════╝');
  Logger.blank();
  Logger.info(`💬 Discord 频道: ${config.discord.channelId}`);
  Logger.info(`🖥️  当前会话: ${sessionManager.getCurrentSession()}`);
  Logger.info(`⏱️  轮询间隔: ${summary.pollInterval}ms`);
  Logger.info(`📝 Session 文件: ${summary.sessionFile}`);
  Logger.blank();
  Logger.info('📖 使用帮助:');
  Logger.info('   普通文本    → 发送给 Claude Code');
  Logger.info('   yes/no      → 确认/取消操作');
  Logger.info('   !命令       → 执行命令并返回结果');
  Logger.info('   /switch     → 切换 tmux 会话');
  Logger.info('   /help       → 显示帮助信息');
  Logger.blank();
}

/**
 * 启动监控轮询
 */
function startMonitorPolling() {
  const sessionName = sessionManager.getCurrentSession();
  Logger.monitor(`启动监控轮询 (会话: ${sessionName})`);

  function scheduleNextPoll() {
    // Discord 断开时暂停轮询
    if (!isDiscordConnected) {
      Logger.debug('Discord 未连接，跳过监控轮询');
      return;
    }

    const currentSession = sessionManager.getCurrentSession();

    // 启动临时进程捕获内容
    const refreshMonitor = processManager.spawn('tmux', ['capture-pane', '-p', '-t', currentSession, '-S', '-500'], {
      timeout: 10000,
      onExit: (code, signal) => {
        if (code !== 0 && signal !== null) {
          Logger.debug(`capture-pane 进程异常退出 (code: ${code}, signal: ${signal})`);
        }
      },
      onError: (err) => {
        Logger.error(`tmux capture-pane 错误: ${err.message}`);
      },
    });

    let newBuffer = '';

    refreshMonitor.stdout.on('data', (data) => {
      newBuffer += data.toString();
    });

    refreshMonitor.on('close', () => {
      if (newBuffer) {
        sessionManager.buffer.update(newBuffer);

        // 执行状态检测
        detector.detect(newBuffer).then(stateResult => {
          if (stateResult) {
            handleStateChange(stateResult);
          }

          // 更新路由器的监控状态
          if (router) {
            router.setMonitorState(detector.getCurrentState());
          }
        }).catch(error => {
          Logger.error(`状态检测失败: ${error.message}`);
        });
      }

      // Discord 仍连接时才调度下次轮询
      if (isDiscordConnected) {
        const nextInterval = detector.getPollInterval();
        monitorTimeout = setTimeout(scheduleNextPoll, nextInterval);
      }
    });

    refreshMonitor.on('error', (err) => {
      Logger.error(`tmux capture-pane 错误: ${err.message}`);
      const nextInterval = detector.getPollInterval();
      monitorTimeout = setTimeout(scheduleNextPoll, nextInterval);
    });
  }

  // 启动第一次轮询
  monitorTimeout = setTimeout(scheduleNextPoll, config.monitor.pollInterval);
}

/**
 * 处理状态变化
 * @param {Object} stateResult - 状态检测结果
 */
async function handleStateChange(stateResult) {
  Logger.debug(`状态变化: ${stateResult.type}`);

  try {
    const cleanContent = (content) => {
      if (!content || typeof content !== 'string') return content;
      return sessionManager.buffer.cleanForNotification(content, 30);
    };

    switch (stateResult.type) {
      case 'error':
        break;

      case 'plan_mode':
      case 'testing':
      case 'git_operation':
      case 'warning':
      case 'idle_input':
        Logger.debug(`[${stateResult.type}] 状态已检测，不发送通知`);
        break;

      case 'input_prompt':
        await messenger.sendText(`🔔 Claude Code 正在等待输入\n\n当前提示：${cleanContent(stateResult.content)}`);
        break;

      case 'completed':
        await messenger.sendText(`✅ **Claude Code 任务已完成**\n\n正在等待新的输入...`);
        break;

      default:
        Logger.debug(`[未处理状态: ${stateResult.type}]`);
        break;
    }
  } catch (error) {
    Logger.error(`处理状态变化失败: ${error.message}`);
  }
}

/**
 * 处理 Discord 消息
 * @param {Object} message - discord.js Message 对象
 */
async function handleDiscordMessage(message) {
  try {
    // 过滤 bot 消息
    if (message.author.bot) {
      return;
    }

    // 过滤非目标频道
    if (message.channelId !== config.discord.channelId) {
      return;
    }

    const content = message.content;
    if (!content || content.trim().length === 0) {
      return;
    }

    // 生成事件 ID 用于去重
    const eventId = `discord_${message.id}`;

    // 消息去重检查
    if (deduplicator.isProcessed(eventId)) {
      Logger.info(`🔄 忽略重复事件: ${eventId}`);
      return;
    }

    // 标记为已处理
    deduplicator.markProcessed(eventId);
    Logger.info(`📨 处理 Discord 消息: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`);

    // 标准化消息格式并路由
    await router.route({
      _normalized: true,
      _isBot: false,
      text: content,
    });
  } catch (error) {
    Logger.error(`处理 Discord 消息时出错: ${error.message}`);
  }
}

/**
 * 处理 Discord Slash Command 交互
 * @param {Object} interaction - discord.js Interaction 对象
 */
async function handleInteraction(interaction) {
  try {
    // 只处理 Chat Input Commands
    if (!interaction.isChatInputCommand()) {
      return;
    }

    // 过滤非目标频道
    if (interaction.channelId !== config.discord.channelId) {
      return;
    }

    const commandName = interaction.commandName;
    Logger.info(`📨 处理 Slash Command: /${commandName}`);

    // 先 defer reply，给后续处理留出时间
    await interaction.deferReply();

    // 创建交互专用 context，用 interaction.editReply / followUp 替代 channel.send
    let replied = false;
    const interactionSendText = async (text, options = {}) => {
      const chunks = messenger.splitMessage(text);
      for (const chunk of chunks) {
        if (!replied) {
          await interaction.editReply(chunk);
          replied = true;
        } else {
          await interaction.followUp(chunk);
        }
      }
    };

    const interactionCtx = {
      messenger: {
        ...messenger,
        sendText: interactionSendText,
        // override sendHelp 使其通过 interaction 回复
        sendHelp: async () => {
          try {
            const { EmbedBuilder } = await import('discord.js');
            const embed = new EmbedBuilder()
              .setTitle('📖 Claude Code Discord 桥接 - 帮助')
              .setColor(0x7C3AED)
              .addFields(
                {
                  name: '🔔 监控功能',
                  value: [
                    '• 自动检测 Claude Code 等待输入',
                    '• 检测错误、警告、测试执行等状态',
                    '• Discord 消息实时通知',
                  ].join('\n'),
                },
                {
                  name: '💬 使用规则',
                  value: [
                    '**普通文本** → 直接发送给 Claude Code',
                    '**yes/y/确认** → 确认 Claude Code 请求',
                    '**no/n/取消** → 取消 Claude Code 操作',
                    '**!命令** → 在 tmux 中执行命令并返回结果',
                  ].join('\n'),
                },
                {
                  name: '🎛️ 桥接服务指令',
                  value: [
                    '`/switch` — 列出所有 tmux 会话',
                    '`/switch <名>` — 切换监控到指定会话',
                    '`/tab <数字>` — 选中指定 tab',
                    '`/show` — 显示当前 tmux 会话内容',
                    '`/new <名字>` — 创建新的 tmux 会话',
                    '`/kill` — 杀掉当前 tmux 会话',
                    '`/reset` — 清除 Claude Code context',
                    '`/history` — 查看命令历史',
                    '`/status` — 显示详细状态信息',
                    '`/help` — 显示此帮助信息',
                  ].join('\n'),
                },
                {
                  name: '💡 示例',
                  value: '`!pwd` — 显示当前目录\n`!ls -la` — 列出文件\n`!git status` — 查看 git 状态',
                }
              );

            if (!replied) {
              await interaction.editReply({ embeds: [embed] });
              replied = true;
            } else {
              await interaction.followUp({ embeds: [embed] });
            }
            return { success: true };
          } catch (error) {
            // 降级为纯文本
            await interactionSendText(
              '📖 **Claude Code Discord 桥接 - 帮助**\n\n' +
              '**普通文本** → 发送给 Claude Code\n' +
              '**yes/no** → 确认/取消操作\n' +
              '**!命令** → 执行命令并返回结果\n' +
              '`/switch` `/show` `/new` `/kill` `/reset` `/status` `/help`'
            );
            return { success: false, error: error.message };
          }
        },
      },
      commander,
      currentSession: sessionManager.getSessionRef(),
      sessionManager,
      monitorState: router ? router.context.monitorState : 'idle',
      sendText: interactionSendText,
      deduplicator,
      transcriptMonitor,
    };

    // 根据 commandName 分发到对应的 command handler
    switch (commandName) {
      case 'switch': {
        const name = interaction.options.getString('name');
        if (name) {
          await commands.handleSwitchTo(interactionCtx, name);
        } else {
          await commands.handleSwitchList(interactionCtx);
        }
        break;
      }
      case 'tab': {
        const numbers = interaction.options.getString('numbers');
        await commands.handleTab(interactionCtx, numbers);
        break;
      }
      case 'show':
        await commands.handleShow(interactionCtx);
        break;
      case 'new': {
        const name = interaction.options.getString('name');
        await commands.handleNew(interactionCtx, name);
        break;
      }
      case 'kill':
        await commands.handleKill(interactionCtx);
        break;
      case 'help':
        await commands.handleHelp(interactionCtx);
        break;
      case 'history':
        await commands.handleHistory(interactionCtx);
        break;
      case 'status':
        await commands.handleStatus(interactionCtx, interactionCtx.monitorState);
        break;
      case 'config':
        await commands.handleConfig(interactionCtx);
        break;
      case 'watch':
        await commands.handleWatch(interactionCtx);
        break;
      case 'clear':
        await commands.handleClear(interactionCtx);
        break;
      case 'dedupstats':
        await commands.handleDedupStats(interactionCtx);
        break;
      case 'reset':
        await commands.handleReset(interactionCtx);
        break;
      default:
        await interactionSendText(`❓ 未知指令: /${commandName}`);
        break;
    }
  } catch (error) {
    Logger.error(`处理 Slash Command 交互时出错: ${error.message}`);
    try {
      // 尝试回复错误信息
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(`❌ 命令执行失败: ${error.message}`);
      } else {
        await interaction.reply(`❌ 命令执行失败: ${error.message}`);
      }
    } catch (replyError) {
      Logger.error(`回复错误信息失败: ${replyError.message}`);
    }
  }
}

/**
 * 优雅关闭
 */
async function shutdown() {
  Logger.blank();
  Logger.info('🛑 正在关闭服务...');

  try {
    // 停止监控轮询
    if (monitorTimeout) {
      clearTimeout(monitorTimeout);
      Logger.debug('监控轮询已停止');
    }

    // 停止所有管理的进程
    if (processManager) {
      await processManager.stop();
      Logger.debug('进程管理器已停止');
    }

    // 销毁去重器
    if (deduplicator) {
      deduplicator.destroy();
      Logger.info('✅ 去重器已销毁');
    }

    // 销毁消息历史去重器
    if (messageHistory) {
      messageHistory.destroy();
      Logger.info('✅ 消息历史去重器已销毁');
    }

    // 停止 transcript 监控
    if (transcriptMonitor) {
      transcriptMonitor.stop();
    }

    // 关闭 Discord 客户端
    if (discordClient) {
      discordClient.destroy();
      Logger.success('Discord 连接已关闭');
    }
  } catch (error) {
    Logger.error(`关闭时出错: ${error.message}`);
  }

  Logger.success('服务已优雅关闭');
  process.exit(0);
}

/**
 * 主启动函数
 */
async function main() {
  try {
    // 验证 Discord 配置
    validateDiscordConfig();

    // 初始化进程管理器
    processManager = new ProcessManager();
    processManager.start();

    // 初始化会话管理器
    sessionManager = new SessionManager();

    // 初始化去重器
    deduplicator = new MessageDeduplicator({
      ttl: config.deduplication.ttl,
      maxSize: config.deduplication.maxSize,
      cleanupInterval: config.deduplication.cleanupInterval,
      storageFile: '/tmp/claude-discord-dedup.json',
    });

    // 初始化消息历史去重器
    messageHistory = new MessageHistory({
      storageFile: '/tmp/claude-discord-sent-messages.json',
    });

    // 初始化 Discord 客户端
    discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // 初始化消息适配器
    messenger = new DiscordAdapter({
      client: discordClient,
      channelId: config.discord.channelId,
      messageHistory,
    });

    // 初始化 transcript 监控器（连接成功后再 start）
    transcriptMonitor = new TranscriptMonitor({
      projectPath: process.cwd(),
      messenger: messenger,
      checkInterval: 500,
    });

    // 初始化命令执行器
    commander = new TmuxCommander(sessionManager.getCurrentSession());

    // 初始化状态检测器
    detector = new StateDetector();

    // 初始化消息路由器
    const context = {
      messenger,
      commander,
      currentSession: sessionManager.getSessionRef(),
      sessionManager,
      monitorState: 'idle',
      sendText: (text) => messenger.sendText(text),
      deduplicator,
      transcriptMonitor,
    };
    router = new MessageRouter(context);

    // 打印启动信息
    printStartupInfo();

    // 自动检测并使用第一个可用会话
    await sessionManager.autoSelectSession();

    // 如果有可用会话，更新 commander 并启动监控
    if (sessionManager.getCurrentSession()) {
      const sessionName = sessionManager.getCurrentSession();
      commander = new TmuxCommander(sessionName);
      if (transcriptMonitor) {
        transcriptMonitor.setTmuxSession(sessionName);
        transcriptMonitor.setTmuxCommander(commander);
        Logger.info(`📝 Transcript 监控将跟踪 tmux 会话: ${sessionName}`);
      }
      // 监控轮询在 Discord ready 后启动
    } else {
      Logger.warn('⚠️  没有可用会话，监控未启动，请使用 /new 命令创建会话');
    }

    // 注册 Discord 事件
    discordClient.once(Events.ClientReady, async (client) => {
      Logger.success(`Discord Bot 已登录: ${client.user.tag}`);
      isDiscordConnected = true;

      // 注册 Guild Slash Commands（从频道获取 guildId，秒级生效）
      try {
        const channel = await client.channels.fetch(config.discord.channelId);
        if (channel && channel.guildId) {
          await registerCommands(client.user.id, channel.guildId, config.discord.botToken);
        } else {
          Logger.error('无法从频道获取 guildId，Slash Commands 未注册');
        }
      } catch (error) {
        Logger.error(`Slash Commands 注册失败，交互命令将不可用: ${error.message}`);
      }

      // Discord 已就绪，启动 transcript 监控
      transcriptMonitor.start();

      // 启动监控轮询
      if (sessionManager.getCurrentSession()) {
        startMonitorPolling();
      }
    });

    discordClient.on(Events.MessageCreate, handleDiscordMessage);
    discordClient.on(Events.InteractionCreate, handleInteraction);

    discordClient.on(Events.Error, (error) => {
      Logger.error(`Discord 客户端错误: ${error.message}`);
    });

    discordClient.on(Events.Warn, (warning) => {
      Logger.warn(`Discord 警告: ${warning}`);
    });

    // 登录 Discord
    Logger.info('正在连接 Discord...');
    await discordClient.login(config.discord.botToken);

    Logger.success('服务已启动，等待 Discord 消息...');

    // 注册信号处理器
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // 处理未捕获的异常
    process.on('uncaughtException', async (error) => {
      Logger.error(`未捕获的异常: ${error.message}`);
      Logger.error(error.stack);
      await shutdown();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      Logger.error(`未处理的 Promise 拒绝: ${reason}`);

      const isProduction = process.env.NODE_ENV === 'production';
      if (isProduction) {
        Logger.error('生产环境中未处理的 Promise 拒绝，将退出服务');
        await shutdown();
        process.exit(1);
      } else {
        Logger.warn('开发环境：继续运行，但这可能是代码问题');
      }
    });

  } catch (error) {
    Logger.error(`服务启动失败: ${error.message || error}`);
    if (error.stack) Logger.error(error.stack);
    process.exit(1);
  }
}

// 启动服务
main();

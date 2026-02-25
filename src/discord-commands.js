/**
 * Discord Slash Command 定义与注册
 * Author: CodePothunter
 * Version: 1.0.0
 */

import { SlashCommandBuilder } from '@discordjs/builders';
import { REST, Routes } from 'discord.js';
import Logger from './utils/logger.js';

/**
 * 定义所有桥接命令的 SlashCommandBuilder
 */
const commands = [
  new SlashCommandBuilder()
    .setName('switch')
    .setDescription('列出或切换 tmux 会话')
    .addStringOption(option =>
      option.setName('name').setDescription('要切换到的会话名称').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('tab')
    .setDescription('选中指定 tab')
    .addStringOption(option =>
      option.setName('numbers').setDescription('要选中的 tab 编号，如 1 或 1,2').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('show')
    .setDescription('显示当前 tmux 会话输出'),

  new SlashCommandBuilder()
    .setName('new')
    .setDescription('创建新项目会话')
    .addStringOption(option =>
      option.setName('name').setDescription('新项目/会话名称').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('kill')
    .setDescription('杀掉当前 tmux 会话'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('显示帮助信息'),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('查看命令历史'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('显示系统状态'),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('查看当前配置'),

  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('实时跟随输出'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('清空缓冲区'),

  new SlashCommandBuilder()
    .setName('dedupstats')
    .setDescription('显示去重器统计信息'),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('清除 Claude Code context'),
];

/**
 * 注册 Slash Commands 到指定 Guild（秒级生效）
 * @param {string} clientId - Bot 的 Client ID
 * @param {string} guildId - Guild ID
 * @param {string} token - Bot Token
 */
export async function registerCommands(clientId, guildId, token) {
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    // 清空全局 Application Commands（避免与 Guild Commands 重复）
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    Logger.info('已清空全局 Application Commands');

    Logger.info(`正在注册 ${commands.length} 个 Guild Slash Commands (guild: ${guildId})...`);

    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands.map(cmd => cmd.toJSON()),
    });

    Logger.success(`✅ 已成功注册 ${commands.length} 个 Guild Slash Commands`);
  } catch (error) {
    Logger.error(`Slash Commands 注册失败: ${error.message}`);
    throw error;
  }
}

export default { registerCommands };

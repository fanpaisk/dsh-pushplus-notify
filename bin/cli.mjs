#!/usr/bin/env node
/**
 * Small onboarding CLI. No installer, no GUI:
 *   npx @fanpaisk/dsh-pushplus-notify setup
 *   npx @fanpaisk/dsh-pushplus-notify test
 *   npx @fanpaisk/dsh-pushplus-notify status
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import readline from 'node:readline';

import { normalizeSettings, settingsFilePath } from '../lib/config.js';
import { maskToken } from '../lib/text.js';

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args[0] : 'help';
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const has = (name) => args.includes(name);

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function askHidden(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const original = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (text) => {
    if (!muted) original(text);
  };
  process.stdout.write(prompt);
  muted = true;
  return new Promise((resolve) => rl.question('', (answer) => {
    muted = false;
    rl.close();
    process.stdout.write('\n');
    resolve(answer.trim());
  }));
}

function readSettingsFile() {
  const file = settingsFilePath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读取设置失败 (${file}): ${error.message}`);
  }
}

function writeSettingsFile(value) {
  const file = settingsFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function currentToken(settings) {
  return String(settings?.token ?? process.env.PUSHPLUS_TOKEN ?? '').trim();
}

async function sendTest(token, settings) {
  const endpoint = settings.endpoint || 'https://www.pushplus.plus/send';
  const fallback = settings.fallbackEndpoint || 'http://www.pushplus.plus/send';
  const payload = {
    token,
    title: '[DSH] 测试通知',
    content: [
      '这是一条来自 DSH PushPlus Notify 的测试消息。',
      `时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      '收到说明 token 和网络正常。',
    ].join('\n'),
    template: 'txt',
  };

  for (const url of [endpoint, fallback]) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      if (response.ok && data?.code === 200) {
        console.log(`✓ 测试消息已发送 (${url})`);
        return true;
      }
      console.error(`✗ 发送失败 (${url}): ${data?.msg || `HTTP ${response.status}`}`);
    } catch (error) {
      console.error(`✗ 发送失败 (${url}): ${error?.name === 'AbortError' ? '请求超时' : error.message}`);
    }
  }
  return false;
}

async function setup() {
  const settings = normalizeSettings(readSettingsFile());
  const existing = currentToken(settings);

  console.log(`
DSH PushPlus 微信提醒

没有 PushPlus Token？按下面步骤获取：
  1. 打开 https://www.pushplus.plus/
  2. 用微信扫码登录
  3. 在首页复制你的 token
  4. 把 token 粘贴到下面
`);
  console.log(`配置文件: ${settingsFilePath()}`);
  console.log(`当前 token: ${existing ? maskToken(existing) : '(未配置)'}`);
  const tokenArg = option('--token');
  const token = tokenArg || await askHidden('PushPlus Token（回车保留当前值）: ') || existing;
  if (!token) {
    console.error('未提供 token，已取消。');
    process.exitCode = 1;
    return;
  }

  settings.token = token;
  const saved = writeSettingsFile(settings);
  console.log(`✓ 已保存: ${saved}`);
  console.log('提示: 之后 DSH 每次启动都会自动加载这个插件，不需要单独开机自启。');

  if (!has('--no-test')) {
    const answer = (await ask('现在发送一条测试消息？(Y/n): ')) || 'y';
    if (answer.toLowerCase() !== 'n') {
      const ok = await sendTest(token, settings);
      if (!ok) process.exitCode = 1;
    }
  }
}

async function test() {
  const settings = normalizeSettings(readSettingsFile());
  const token = option('--token') || currentToken(settings);
  if (!token) {
    console.error(`未配置 token，请先运行 setup，或设置 PUSHPLUS_TOKEN。`);
    process.exitCode = 1;
    return;
  }
  const ok = await sendTest(token, settings);
  if (!ok) process.exitCode = 1;
}

function status() {
  const file = settingsFilePath();
  const settings = normalizeSettings(readSettingsFile());
  const token = currentToken(settings);
  console.log(`配置文件: ${file}`);
  console.log(`token   : ${token ? maskToken(token) : '(未配置)'}`);
  console.log(`enabled : ${settings.enabled}`);
  console.log(`日志     : ${settings.logFile}`);
  console.log(`提醒     : 完成=${settings.notifyOnComplete} 出错=${settings.notifyOnError} 权限=${settings.notifyOnPermission} 选择=${settings.notifyOnQuestion}`);
  if (existsSync(settings.logFile)) {
    const lines = readFileSync(settings.logFile, 'utf8').trim().split(/\r?\n/).slice(-8);
    console.log('\n最近日志:');
    console.log(lines.join('\n'));
  }
}

function help() {
  console.log(`用法:
  npx @fanpaisk/dsh-pushplus-notify setup [--token <token>] [--no-test]
  npx @fanpaisk/dsh-pushplus-notify test  [--token <token>]
  npx @fanpaisk/dsh-pushplus-notify status

获取 PushPlus Token: https://www.pushplus.plus/ （微信扫码登录后复制）
设置文件: ${settingsFilePath()}`);
}

try {
  if (command === 'setup') await setup();
  else if (command === 'test') await test();
  else if (command === 'status') status();
  else help();
} catch (error) {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
}

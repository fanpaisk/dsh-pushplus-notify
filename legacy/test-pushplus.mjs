/**
 * PushPlus 链路测试：发送一条测试微信消息后退出。
 * 用法：
 *   node test-pushplus.mjs            # 真正发送
 *   node test-pushplus.mjs --dry-run  # 只打印请求内容
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes('--dry-run');

let token = '';
try {
  const config = JSON.parse(await readFile(path.join(here, 'config.json'), 'utf8'));
  token = String(config?.wechat_notify?.token ?? '').trim();
} catch (error) {
  console.error(`读取 config.json 失败: ${error.message}`);
  process.exit(1);
}
if (!token) {
  console.error('config.json 里没有 wechat_notify.token');
  process.exit(1);
}

const payload = {
  token,
  title: '[DSH] 测试通知',
  content: [
    '这是一条来自 DSH PushPlus Notifier 的测试消息。',
    `时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '收到说明 PushPlus 链路正常，之后每个任务结束都会收到提醒。',
  ].join('\n'),
  template: 'txt',
};

if (dryRun) {
  console.log(JSON.stringify({ ...payload, token: `${token.slice(0, 4)}****${token.slice(-4)}` }, null, 2));
  process.exit(0);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
try {
  const response = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (response.ok && data?.code === 200) {
    console.log('✓ 测试消息已发送，请查看微信。');
    process.exit(0);
  }
  console.error(`✗ 发送失败: HTTP ${response.status} ${data?.msg ?? text}`);
  process.exit(1);
} catch (error) {
  console.error(`✗ 发送失败: ${error?.name === 'AbortError' ? '请求超时' : error.message}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

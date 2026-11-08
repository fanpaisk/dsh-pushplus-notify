/**
 * 插件离线自测：用 mock ctx + mock fetch 验证事件解析和推送内容。
 * 运行：node packages/plugin/test/plugin.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { normalizeSettings } from '../lib/config.js';
import { extractMessageText } from '../lib/text.js';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-pushplus-notify-test-'));

const TOKEN = 'test-token-12345678';

function makeCtx() {
  const listeners = new Map();
  return {
    logger: { info() {}, warn() {} },
    sessions: { list: () => [] },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    emit(type, ...args) {
      for (const fn of listeners.get(type) ?? []) fn(...args);
    },
  };
}

function makeSession({ id = 'session-abc123456789', cwd = 'C:\\work\\demo', origin, depth } = {}) {
  const events = [];
  return {
    id,
    header: { cwd, origin, delegationDepth: depth },
    events,
    get seq() {
      return events.length;
    },
    eventAt(index) {
      return events[index];
    },
    push(type, data, time = Date.now()) {
      const event = { type, data, seq: events.length, time };
      events.push(event);
      return event;
    },
  };
}

function emit(ctx, session, type, data, time = Date.now()) {
  const event = session.push(type, data, time);
  ctx.emit('session/event', session, event);
  return event;
}

function captureFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 200, msg: 'ok' }),
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

const baseConfig = {
  token: TOKEN,
  logFile: '',
  permissionCooldownSeconds: 0,
  notifyOnStartup: false,
};

test('normalizeSettings 支持 snake_case 并填默认值', () => {
  const config = normalizeSettings({
    token: ' abc ',
    notify_on_complete: 'false',
    permission_cooldown_seconds: 30,
    max_summary_chars: 80,
    include_summary: 'no',
  });
  assert.equal(config.token, 'abc');
  assert.equal(config.notifyOnComplete, false);
  assert.equal(config.permissionCooldownSeconds, 30);
  assert.equal(config.maxSummaryChars, 80);
  assert.equal(config.includeSummary, false);
  assert.equal(config.endpoint, 'https://www.pushplus.plus/send');
  assert.equal(config.fallbackEndpoint, 'http://www.pushplus.plus/send');
  assert.equal(config.timeoutMs, 10000);
  assert.equal(config.maxAttempts, 2);
  assert.equal(config.notifyOnStartup, true);
  assert.equal(config.notifyOnQuestion, true);
});

test('未配置的数值项使用默认值而不是被当成 0', () => {
  const config = normalizeSettings({ token: 'x' });
  assert.equal(config.timeoutMs, 10000);
  assert.equal(config.permissionCooldownSeconds, 60);
  assert.equal(config.maxSummaryChars, 160);
  assert.equal(config.completeCooldownSeconds, 0);

  const empty = normalizeSettings({ token: 'x', timeoutMs: '', maxSummaryChars: ' ' });
  assert.equal(empty.timeoutMs, 10000);
  assert.equal(empty.maxSummaryChars, 160);

  const user = normalizeSettings({ token: 'user-token' });
  assert.equal(normalizeSettings({}, user).token, 'user-token');
});

test('extractMessageText 只拼接 text block', () => {
  const text = extractMessageText({
    content: [
      { type: 'reasoning', text: '不要' },
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
      { type: 'image' },
    ],
  });
  assert.equal(text, '第一段\n第二段');
});

test('completed 回合发送完成提醒（含标题、摘要、工作区、用时）', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, baseConfig);

  const session = makeSession({ cwd: 'C:\\work\\demo' });
  const started = Date.now() - 65_000;
  emit(ctx, session, 'turn/start', { turn: 1 }, started);
  emit(ctx, session, 'session/title', { title: '修复登录问题' });
  emit(ctx, session, 'user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '帮我修一下登录' }],
  });
  emit(ctx, session, 'assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '已经修复并通过测试。' }] },
  });
  emit(ctx, session, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, Date.now());

  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 1);
  const { url, body } = fetchMock.calls[0];
  assert.equal(url, 'https://www.pushplus.plus/send');
  assert.equal(body.token, TOKEN);
  assert.equal(body.title, '[DSH] 任务已完成');
  assert.match(body.content, /「修复登录问题」 已完成/);
  assert.match(body.content, /结果摘要: 已经修复并通过测试/);
  assert.match(body.content, /工作区: C:\\work\\demo/);
  assert.match(body.content, /用时: 1 分 5 秒/);
  assert.equal(body.template, 'txt');
});

test('subagent 子会话默认不提醒', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, baseConfig);

  const child = makeSession({ id: 'session-child-0001', origin: 'subagent', depth: 1 });
  emit(ctx, child, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 0);
});

test('error 回合发送错误提醒并带错误原因', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, baseConfig);

  const session = makeSession();
  emit(ctx, session, 'turn/end', {
    turn: 2,
    reason: { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } },
  });
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].body.title, '[DSH] 任务出错');
  assert.match(fetchMock.calls[0].body.content, /RATE_LIMIT: rate limited/);
});

test('权限请求只提醒一次（冷却）', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, {
    ...baseConfig,
    permissionCooldownSeconds: 60,
  });

  const session = makeSession();
  emit(ctx, session, 'approval/policy', { policy: 'ask' });
  emit(ctx, session, 'approval/asked', { id: 'req-1', toolName: 'pwsh', reason: '需要写文件' });
  emit(ctx, session, 'approval/asked', { id: 'req-2', toolName: 'pwsh', reason: '需要写文件' });
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].body.title, '[DSH] 等待权限确认');
  assert.match(fetchMock.calls[0].body.content, /操作: pwsh/);
  assert.match(fetchMock.calls[0].body.content, /原因: 需要写文件/);
});

test('approval policy = never 时不提醒', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, baseConfig);

  const session = makeSession();
  emit(ctx, session, 'approval/policy', { policy: 'never' });
  emit(ctx, session, 'approval/asked', { id: 'req-3', toolName: 'pwsh' });
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 0);
});

test('未配置 token 时不发送', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, { token: '' });

  const session = makeSession();
  emit(ctx, session, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 0);
});

test('forked / interrupted 标记不提醒', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, baseConfig);

  const session = makeSession();
  emit(ctx, session, 'turn/end', { turn: 1, reason: { kind: 'forked' } });
  emit(ctx, session, 'turn/end', { turn: 2, reason: { kind: 'interrupted' } });
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 0);
});

test('PushPlus 返回业务错误时不会抛异常', async () => {
  const logs = [];
  const ctx = makeCtx();
  ctx.logger.warn = (message) => logs.push(String(message));
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 500, msg: 'token 无效' }),
  });

  const session = makeSession();
  apply(ctx, baseConfig);
  emit(ctx, session, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await tick();
  globalThis.fetch = undefined;

  assert.ok(logs.some((line) => line.includes('token 无效')));
});

test('ask_user_question 会发送「需要你做出选择」提醒，同一 callId 只发一次', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, baseConfig);

  const session = makeSession();
  const data = {
    turn: 1,
    step: 2,
    callId: 'call-question-1',
    name: 'ask_user_question',
    arguments: JSON.stringify({
      questions: [{
        id: 'seat',
        header: '座位号',
        question: '你的座位号是多少？',
        options: [{ label: 'A 5' }, { label: 'B 6' }],
      }],
    }),
  };
  emit(ctx, session, 'tool/call', data);
  emit(ctx, session, 'tool/call', { ...data });
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].body.title, '[DSH] 需要你做出选择');
  assert.match(fetchMock.calls[0].body.content, /座位号/);
  assert.match(fetchMock.calls[0].body.content, /你的座位号是多少/);
  assert.match(fetchMock.calls[0].body.content, /选项: A 5 \/ B 6/);
});

test('普通工具调用不会触发选择提醒', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, baseConfig);

  const session = makeSession();
  emit(ctx, session, 'tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-pwsh-1',
    name: 'pwsh',
    arguments: '{"command":"dir"}',
  });
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 0);
});

test('notifyOnQuestion=false 时不提醒选择', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, { ...baseConfig, notifyOnQuestion: false });

  const session = makeSession();
  emit(ctx, session, 'tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-question-disabled',
    name: 'ask_user_question',
    arguments: '{"questions":[{"id":"q","question":"选哪个？"}]}',
  });
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 0);
});

test('插件加载时补扫仍然挂起的 ask_user_question', async () => {
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  const session = makeSession({ id: 'session-pending-question-1' });
  emit(ctx, session, 'turn/start', { turn: 1 });
  emit(ctx, session, 'tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-question-pending-1',
    name: 'ask_user_question',
    arguments: JSON.stringify({
      questions: [{ id: 'q', header: '确认', question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }],
    }),
  });
  ctx.sessions = { list: () => [session] };

  apply(ctx, baseConfig);
  await tick();
  fetchMock.restore();

  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].body.title, '[DSH] 需要你做出选择');
  assert.match(fetchMock.calls[0].body.content, /继续吗/);
});

test('网络失败会自动重试，第二次成功', async () => {
  const attempts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts.push(Date.now());
    if (attempts.length === 1) throw new TypeError('fetch failed');
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200 }) };
  };

  const ctx = makeCtx();
  apply(ctx, {
    ...baseConfig,
    maxAttempts: 2,
    retryDelayMs: 1,
    fallbackEndpoint: '',
  });

  const session = makeSession();
  emit(ctx, session, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  globalThis.fetch = original;

  assert.equal(attempts.length, 2);
});

test('主地址网络失败时改用 http 备用地址', async () => {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (String(url).startsWith('https://')) throw new TypeError('fetch failed');
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200 }) };
  };

  const ctx = makeCtx();
  apply(ctx, { ...baseConfig, maxAttempts: 1 });
  const session = makeSession();
  emit(ctx, session, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  globalThis.fetch = original;

  assert.deepEqual(urls, [
    'https://www.pushplus.plus/send',
    'http://www.pushplus.plus/send',
  ]);
});

test('DSH 启动时发送一次启动提醒，HMR 重载不重复发送', async () => {
  const flag = Symbol.for('dsh-pushplus-notify.startup-notified');
  delete globalThis[flag];

  const fetchMock = captureFetch();
  const ctx = makeCtx();
  apply(ctx, { ...baseConfig, notifyOnStartup: true });
  await tick();

  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].body.title, '[DSH] 提醒服务已启动');
  assert.match(fetchMock.calls[0].body.content, /已随 DSH 启动/);

  // 模拟 HMR 重新 apply，不应再发一条启动消息。
  apply(ctx, { ...baseConfig, notifyOnStartup: true });
  await tick();
  assert.equal(fetchMock.calls.length, 1);

  fetchMock.restore();
});

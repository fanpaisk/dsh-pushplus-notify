/**
 * DSH PushPlus 微信提醒插件
 * ---------------------------------------------------------------------------
 * 给 DeepSeek Harness（DSH）加一个「任务完成 → PushPlus → 微信」提醒。
 * 原生 Cordis 插件，零第三方依赖，直接挂在 DSH 的 session/event 事件流上。
 *
 * 触发事件：
 *   - turn/end（reason.kind = completed / error / aborted / blocked / max-tokens）
 *       一个用户任务回合结束 => 任务完成 / 出错 / 中断提醒
 *   - approval/asked
 *       某个工具调用正在等待权限审批 => 权限请求提醒（可选，带冷却）
 *
 * 安装方式见同目录 install.ps1 / README.zh.md。
 * 插件由 DSH 的 loader 从 profile 目录加载，配置写在 cordis.patch.yml 里。
 *
 * 兼容：DSH 0.2.1-rc.2（Node >= 22）。
 */

import { appendFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** Cordis loader 的稳定插件 id。 */
export const name = 'pushplus-notify';

/** 需要 session store 就绪后再启动。 */
export const inject = ['sessions'];

const DEFAULT_ENDPOINT = 'https://www.pushplus.plus/send';

/**
 * 默认配置。插件没有引用 schemastery，配置在 apply 里手工归一化，
 * 因此可以放在任意 profile 目录中运行而不需要安装依赖。
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  token: '',
  endpoint: DEFAULT_ENDPOINT,
  /** 主地址网络失败时改用的备用地址（PushPlus 同时支持 http/https）。 */
  fallbackEndpoint: 'http://www.pushplus.plus/send',
  template: 'txt',
  channel: '',
  to: '',
  timeoutMs: 10000,
  maxAttempts: 2,
  retryDelayMs: 1500,
  notifyOnStartup: true,
  notifyOnComplete: true,
  notifyOnError: true,
  notifyOnAbort: true,
  notifyOnBlocked: true,
  notifyOnMaxTokens: true,
  notifyOnPermission: true,
  notifyOnQuestion: true,
  notifyOnSubagent: false,
  includeSummary: true,
  maxSummaryChars: 160,
  completeCooldownSeconds: 0,
  permissionCooldownSeconds: 60,
  logFile: '',
});

// ---------------------------------------------------------------------------
// 配置归一化（同时接受 camelCase 与 snake_case，方便手写 YAML）
// ---------------------------------------------------------------------------

function pick(raw, ...keys) {
  for (const key of keys) {
    if (raw && Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined) {
      return raw[key];
    }
  }
  return undefined;
}

function asBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
  }
  return fallback;
}

function asNumber(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return fallback;
  }
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) return fallback;
  let result = Math.min(max, Math.max(min, number));
  if (integer) result = Math.round(result);
  return result;
}

function asString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text === '' ? fallback : text;
}

/**
 * 把原始 YAML config 归一化为完整配置。
 * @param {unknown} raw 插件配置（可能为 undefined）。
 * @returns {typeof DEFAULT_CONFIG} 完整配置。
 */
export function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return config;

  config.enabled = asBool(pick(raw, 'enabled'), config.enabled);
  config.token = asString(pick(raw, 'token', 'pushplusToken', 'pushplus_token'), '');
  config.endpoint = asString(pick(raw, 'endpoint', 'url'), DEFAULT_ENDPOINT);
  config.fallbackEndpoint = asString(
    pick(raw, 'fallbackEndpoint', 'fallback_endpoint'),
    'http://www.pushplus.plus/send',
  );
  if (config.fallbackEndpoint === config.endpoint) config.fallbackEndpoint = '';
  config.template = asString(pick(raw, 'template'), 'txt');
  config.channel = asString(pick(raw, 'channel'), '');
  config.to = asString(pick(raw, 'to'), '');
  config.timeoutMs = asNumber(pick(raw, 'timeoutMs', 'timeout_ms', 'timeout'), 10000, {
    min: 1000,
    max: 60000,
    integer: true,
  });
  config.maxAttempts = asNumber(pick(raw, 'maxAttempts', 'max_attempts'), 2, {
    min: 1,
    max: 5,
    integer: true,
  });
  config.retryDelayMs = asNumber(pick(raw, 'retryDelayMs', 'retry_delay_ms'), 1500, {
    min: 0,
    max: 30000,
    integer: true,
  });
  config.notifyOnStartup = asBool(
    pick(raw, 'notifyOnStartup', 'notify_on_startup'),
    config.notifyOnStartup,
  );

  config.notifyOnComplete = asBool(
    pick(raw, 'notifyOnComplete', 'notify_on_complete'),
    config.notifyOnComplete,
  );
  config.notifyOnError = asBool(pick(raw, 'notifyOnError', 'notify_on_error'), config.notifyOnError);
  config.notifyOnAbort = asBool(pick(raw, 'notifyOnAbort', 'notify_on_abort'), config.notifyOnAbort);
  config.notifyOnBlocked = asBool(
    pick(raw, 'notifyOnBlocked', 'notify_on_blocked'),
    config.notifyOnBlocked,
  );
  config.notifyOnMaxTokens = asBool(
    pick(raw, 'notifyOnMaxTokens', 'notify_on_max_tokens'),
    config.notifyOnMaxTokens,
  );
  config.notifyOnPermission = asBool(
    pick(raw, 'notifyOnPermission', 'notify_on_permission'),
    config.notifyOnPermission,
  );
  config.notifyOnQuestion = asBool(
    pick(raw, 'notifyOnQuestion', 'notify_on_question'),
    config.notifyOnQuestion,
  );
  config.notifyOnSubagent = asBool(
    pick(raw, 'notifyOnSubagent', 'notify_on_subagent'),
    config.notifyOnSubagent,
  );
  config.includeSummary = asBool(
    pick(raw, 'includeSummary', 'include_summary'),
    config.includeSummary,
  );
  config.maxSummaryChars = asNumber(
    pick(raw, 'maxSummaryChars', 'max_summary_chars'),
    160,
    { min: 20, max: 1000, integer: true },
  );
  config.completeCooldownSeconds = asNumber(
    pick(raw, 'completeCooldownSeconds', 'complete_cooldown_seconds', 'cooldownSeconds', 'cooldown_seconds'),
    0,
    { min: 0, max: 86400 },
  );
  config.permissionCooldownSeconds = asNumber(
    pick(raw, 'permissionCooldownSeconds', 'permission_cooldown_seconds'),
    60,
    { min: 0, max: 86400 },
  );
  config.logFile = asString(pick(raw, 'logFile', 'log_file'), '');

  return config;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地时区的 `YYYY-MM-DD HH:mm:ss`。 */
export function formatTime(ms = Date.now()) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function maskToken(token) {
  if (!token) return '(未配置)';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

/** 取消息里的可见文本（忽略 reasoning / image / 工具块）。 */
export function extractMessageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 挂载提醒插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文。
 * @param {unknown} rawConfig cordis.patch.yml 中该条目的 config。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  let fileLogBroken = false;
  const fileLog = (line) => {
    if (!config.logFile || fileLogBroken) return;
    const text = `[${formatTime()}] ${line}\n`;
    void appendFile(config.logFile, text, 'utf8').catch((error) => {
      fileLogBroken = true;
      try {
        ctx.logger?.warn?.(`pushplus-notify: 写入日志失败 (${config.logFile}): ${String(error)}`);
      } catch {
        /* 日志失败不影响提醒 */
      }
    });
  };

  const logInfo = (message) => {
    try {
      ctx.logger?.info?.(`pushplus-notify: ${message}`);
    } catch {
      /* ignore */
    }
    fileLog(`INFO  ${message}`);
  };
  const logWarn = (message) => {
    try {
      ctx.logger?.warn?.(`pushplus-notify: ${message}`);
    } catch {
      /* ignore */
    }
    fileLog(`WARN  ${message}`);
  };

  if (!config.enabled) {
    logInfo('已禁用（config.enabled = false），不注册任何监听');
    return;
  }
  if (!config.token) {
    logWarn('未配置 PushPlus token，提醒不会发送；请在 cordis.patch.yml 的 pushplus-notify 条目里填入 token');
    return;
  }

  /** 每个 session 的轻量状态。 */
  const state = {
    titles: new WeakMap(),
    lastAssistant: new WeakMap(),
    turnStartedAt: new WeakMap(),
    approvalPolicy: new WeakMap(),
    lastCompleteAt: new Map(),
    lastPermissionAt: new Map(),
    seenApprovalIds: new Set(),
    approvalIdOrder: [],
    seenTurnEnds: new Set(),
    turnEndOrder: [],
  };

  const remember = (set, order, value, limit = 500) => {
    if (set.has(value)) return false;
    set.add(value);
    order.push(value);
    while (order.length > limit) {
      const oldest = order.shift();
      set.delete(oldest);
    }
    return true;
  };

  // ask_user_question 的 callId 去重表放在 globalThis，HMR 重载插件后仍然有效，
  // 避免「启动时补扫待回答问题」把已经提醒过的问题再发一遍。
  const QUESTION_SEEN_KEY = Symbol.for('dsh-pushplus-notify.question-seen');
  const questionSeen = globalThis[QUESTION_SEEN_KEY] ??= new Set();

  // -------------------------------------------------------------------
  // 读取 session 元信息
  // -------------------------------------------------------------------

  const latestEvent = (session, type, maxBack = 400) => {
    try {
      const end = Number(session?.seq ?? 0);
      const floor = Math.max(0, end - maxBack);
      for (let seq = end - 1; seq >= floor; seq -= 1) {
        const event = session.eventAt?.(seq);
        if (event?.type === type) return event;
      }
    } catch {
      /* 读取失败时走内存状态 */
    }
    return undefined;
  };

  const latestHumanPrompt = (session, maxBack = 400) => {
    try {
      const end = Number(session?.seq ?? 0);
      const floor = Math.max(0, end - maxBack);
      for (let seq = end - 1; seq >= floor; seq -= 1) {
        const event = session.eventAt?.(seq);
        if (event?.type !== 'user/message') continue;
        if (event.data?.source?.kind !== 'user') continue;
        const text = collapse(extractMessageText(event.data));
        if (text) return text;
      }
    } catch {
      /* ignore */
    }
    return '';
  };

  const resolveTitle = (session) => {
    const tracked = state.titles.get(session);
    if (tracked) return tracked;
    try {
      const snapshot = ctx.sessionTitle?.get?.(session);
      if (snapshot?.title) return snapshot.title;
    } catch {
      /* session-title 服务可能未加载 */
    }
    const titleEvent = latestEvent(session, 'session/title');
    if (titleEvent?.data?.title) return titleEvent.data.title;
    return truncate(collapse(latestHumanPrompt(session)), 40);
  };

  const describe = (session) => {
    const title = resolveTitle(session);
    const cwd = session?.header?.cwd;
    const label = title
      ? `「${title}」`
      : cwd
        ? `「${basename(cwd)}」`
        : `(${String(session?.id ?? '').slice(-6)})`;
    return { title, cwd, label };
  };

  const isSubagent = (session) => {
    const header = session?.header ?? {};
    return header.origin === 'subagent' ||
      (typeof header.delegationDepth === 'number' && header.delegationDepth > 0);
  };

  const summaryFor = (session, turn) => {
    const cached = state.lastAssistant.get(session);
    if (cached && cached.turn === turn && cached.text) return cached.text;

    // 插件在回合中途加载时，内存里没有缓存：从事件日志回看最后一条 assistant 消息。
    try {
      const end = Number(session?.seq ?? 0);
      const floor = Math.max(0, end - 600);
      for (let seq = end - 1; seq >= floor; seq -= 1) {
        const event = session.eventAt?.(seq);
        if (event?.type !== 'assistant/message') continue;
        if (event.data?.turn !== turn) continue;
        const text = extractMessageText(event.data.message);
        if (text) return text;
      }
    } catch {
      /* ignore */
    }
    return '';
  };

  // -------------------------------------------------------------------
  // PushPlus
  // -------------------------------------------------------------------

  const postOnce = async (endpoint, title, content) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const body = {
        token: config.token,
        title,
        content,
        template: config.template,
      };
      if (config.channel) body.channel = config.channel;
      if (config.to) body.to = config.to;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (response.ok && data?.code === 200) return { ok: true };
      const reason = data?.msg || data?.message || `HTTP ${response.status}`;
      // 5xx/429 值得重试；token 无效、参数错误等业务失败重试也没用。
      const retryable = !response.ok || response.status === 429 || response.status >= 500;
      return { ok: false, error: reason, retryable };
    } catch (error) {
      const message = error?.name === 'AbortError'
        ? `请求超时 (${config.timeoutMs} ms)`
        : String(error?.message ?? error);
      return { ok: false, error: message, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 先走主地址，网络类失败再走备用地址；每轮之间退避重试。
   * PushPlus 偶尔会 `fetch failed`（连接被重置/DNS 抖动），重试能自愈。
   */
  const sendPushPlus = async (title, content) => {
    const endpoints = [config.endpoint];
    if (config.fallbackEndpoint) endpoints.push(config.fallbackEndpoint);

    let lastError = '';
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      for (const endpoint of endpoints) {
        const result = await postOnce(endpoint, title, content);
        if (result.ok) {
          return { ok: true, attempt, endpoint };
        }
        lastError = `${result.error} (${endpoint})`;
        logWarn(`第 ${attempt}/${config.maxAttempts} 次尝试失败: ${result.error} (${endpoint})`);
        if (!result.retryable) {
          return { ok: false, error: result.error };
        }
      }
      if (attempt < config.maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, config.retryDelayMs * attempt));
      }
    }
    return { ok: false, error: lastError };
  };

  const pendingSends = new Set();
  const deliver = (title, content, tag) => {
    const task = sendPushPlus(title, content)
      .then((result) => {
        if (result.ok) {
          logInfo(`已发送 ${tag}: ${title}`);
        } else {
          logWarn(`发送失败 ${tag}: ${title} - ${result.error}`);
        }
      })
      .catch((error) => {
        logWarn(`发送异常 ${tag}: ${String(error?.message ?? error)}`);
      })
      .finally(() => {
        pendingSends.delete(task);
      });
    pendingSends.add(task);
  };

  // headless 等一次性进程在回合结束后就会退出，销毁时等待尚未完成的推送，
  // 避免「任务完成提醒还没来得及发出去，进程就没了」。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      if (pendingSends.size === 0) return;
      logInfo(`插件卸载，等待 ${pendingSends.size} 条未完成的推送...`);
      await Promise.allSettled([...pendingSends]);
    }, 'pushplus-notify pending sends');
  }

  // -------------------------------------------------------------------
  // 消息构造
  // -------------------------------------------------------------------

  const commonLines = (session, startedAt) => {
    const lines = [];
    const cwd = session?.header?.cwd;
    if (cwd) lines.push(`工作区: ${cwd}`);
    if (Number.isFinite(startedAt)) {
      const duration = formatDuration(Date.now() - startedAt);
      if (duration) lines.push(`用时: ${duration}`);
    }
    lines.push(`时间: ${formatTime()}`);
    lines.push(`会话: ${String(session?.id ?? '').slice(-12)}`);
    return lines;
  };

  const buildTurnMessage = (session, event) => {
    const reason = event?.data?.reason ?? {};
    const kind = reason.kind ?? 'unknown';
    const turn = event?.data?.turn;
    const info = describe(session);
    const startedAt = state.turnStartedAt.get(session);
    const lines = [];
    let title = '';

    switch (kind) {
      case 'completed': {
        if (!config.notifyOnComplete) return null;
        title = '[DSH] 任务已完成';
        lines.push(`任务 ${info.label} 已完成 ✅`);
        if (config.includeSummary) {
          const summary = truncate(collapse(summaryFor(session, turn)), config.maxSummaryChars);
          if (summary) lines.push(`结果摘要: ${summary}`);
        }
        break;
      }
      case 'error': {
        if (!config.notifyOnError) return null;
        title = '[DSH] 任务出错';
        lines.push(`任务 ${info.label} 执行出错 ❌`);
        const failure = reason.error ?? {};
        const detail = truncate(
          collapse([failure.code, failure.message].filter(Boolean).join(': ')),
          240,
        );
        if (detail) lines.push(`错误: ${detail}`);
        break;
      }
      case 'aborted': {
        if (!config.notifyOnAbort) return null;
        title = '[DSH] 任务已中断';
        const cause = reason.reason?.kind;
        const causeLabel = {
          user: '用户取消',
          parent: '父任务取消',
          hook: `hook: ${reason.reason?.reason ?? ''}`.trim(),
          disposed: '服务关闭',
          legacy: '旧记录',
        }[cause] ?? cause ?? 'unknown';
        lines.push(`任务 ${info.label} 已中断 ⏹`);
        lines.push(`原因: ${causeLabel}`);
        break;
      }
      case 'blocked': {
        if (!config.notifyOnBlocked) return null;
        title = '[DSH] 任务等待处理';
        lines.push(`任务 ${info.label} 被阻塞 ⏸`);
        lines.push('说明: 等待你的输入、确认或外部条件');
        break;
      }
      case 'max-tokens': {
        if (!config.notifyOnMaxTokens) return null;
        title = '[DSH] 输出达到上限';
        lines.push(`任务 ${info.label} 达到输出上限 ⚠`);
        lines.push('说明: 回合因 token 上限结束，可以继续发消息让它接着做');
        break;
      }
      default:
        // forked / interrupted 是重放或崩溃恢复标记，不提醒。
        return null;
    }

    lines.push(...commonLines(session, startedAt));
    return { title, content: lines.join('\n'), kind };
  };

  const buildApprovalMessage = (session, event) => {
    const info = describe(session);
    const data = event?.data ?? {};
    const lines = [`任务 ${info.label} 正在等待权限确认 🔐`];
    if (data.toolName) lines.push(`操作: ${data.toolName}`);
    const reason = truncate(collapse(data.reason), 200);
    if (reason) lines.push(`原因: ${reason}`);
    const cwd = session?.header?.cwd;
    if (cwd) lines.push(`工作区: ${cwd}`);
    lines.push(`时间: ${formatTime()}`);
    return { title: '[DSH] 等待权限确认', content: lines.join('\n') };
  };

  /** 把 ask_user_question 的参数整理成一条可读的微信消息。 */
  const buildQuestionMessage = (session, data) => {
    const info = describe(session);
    const lines = [`任务 ${info.label} 正在等你选择/回答 ❓`];

    let parsed = null;
    try {
      parsed = typeof data?.arguments === 'string' ? JSON.parse(data.arguments) : data?.arguments;
    } catch {
      parsed = null;
    }
    const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];

    if (questions.length === 0) {
      const raw = truncate(collapse(data?.arguments), 300);
      if (raw) lines.push(raw);
    } else {
      questions.slice(0, 5).forEach((question, index) => {
        const header = question?.header ? `[${collapse(question.header)}] ` : '';
        lines.push(`${index + 1}. ${header}${truncate(collapse(question?.question), 200)}`);
        const options = Array.isArray(question?.options) ? question.options : [];
        if (options.length > 0) {
          const labels = options
            .slice(0, 5)
            .map((option) => truncate(collapse(option?.label), 60))
            .filter(Boolean);
          if (labels.length > 0) lines.push(`   选项: ${labels.join(' / ')}`);
        }
      });
      if (questions.length > 5) lines.push(`… 还有 ${questions.length - 5} 个问题，请在 DSH 中查看`);
    }

    const cwd = session?.header?.cwd;
    if (cwd) lines.push(`工作区: ${cwd}`);
    lines.push(`时间: ${formatTime()}`);
    lines.push(`会话: ${String(session?.id ?? '').slice(-12)}`);
    return { title: '[DSH] 需要你做出选择', content: lines.join('\n') };
  };

  // -------------------------------------------------------------------
  // 事件处理
  // -------------------------------------------------------------------

  const onTurnEnd = (session, event) => {
    if (!config.notifyOnSubagent && isSubagent(session)) return;

    const turn = event?.data?.turn;
    const dedupeKey = `${String(session?.id ?? '')}#${turn}#${event?.seq ?? 0}`;
    if (!remember(state.seenTurnEnds, state.turnEndOrder, dedupeKey)) return;

    const message = buildTurnMessage(session, event);
    if (!message) return;

    const sessionId = String(session?.id ?? '');
    const last = state.lastCompleteAt.get(sessionId) ?? 0;
    if (config.completeCooldownSeconds > 0 &&
        Date.now() - last < config.completeCooldownSeconds * 1000) {
      logInfo(`完成提醒处于冷却期，跳过 (${message.kind}) ${sessionId.slice(-12)}`);
      return;
    }
    state.lastCompleteAt.set(sessionId, Date.now());
    state.turnStartedAt.delete(session);

    logInfo(`[${message.kind}] ${message.title} ${sessionId.slice(-12)}`);
    deliver(message.title, message.content, message.kind);
  };

  const onApprovalAsked = (session, event) => {
    if (!config.notifyOnPermission) return;
    if (!config.notifyOnSubagent && isSubagent(session)) return;
    if (state.approvalPolicy.get(session) === 'never') return;

    const id = String(event?.data?.id ?? '');
    if (id && !remember(state.seenApprovalIds, state.approvalIdOrder, id)) return;

    const sessionId = String(session?.id ?? '');
    const last = state.lastPermissionAt.get(sessionId) ?? 0;
    if (config.permissionCooldownSeconds > 0 &&
        Date.now() - last < config.permissionCooldownSeconds * 1000) {
      logInfo(`权限提醒处于冷却期，跳过 ${sessionId.slice(-12)}`);
      return;
    }
    state.lastPermissionAt.set(sessionId, Date.now());

    const message = buildApprovalMessage(session, event);
    logInfo(`[permission] ${event?.data?.toolName ?? '未知操作'} ${sessionId.slice(-12)}`);
    deliver(message.title, message.content, 'permission');
  };

  /**
   * ask_user_question 的 tool/call 就是「任务停下来等用户做选择」的信号。
   * 它不会产生 turn/end，所以必须单独提醒。
   */
  const notifyQuestion = (session, data, source) => {
    if (!config.notifyOnQuestion) return;
    if (!config.notifyOnSubagent && isSubagent(session)) return;
    if (!data || data.name !== 'ask_user_question') return;

    const callId = String(data.callId ?? '');
    const key = callId || `${String(session?.id ?? '')}:${String(data.arguments ?? '').slice(0, 160)}`;
    if (questionSeen.has(key)) return;
    questionSeen.add(key);
    while (questionSeen.size > 500) {
      const oldest = questionSeen.values().next().value;
      questionSeen.delete(oldest);
    }

    const message = buildQuestionMessage(session, data);
    logInfo(`[question] ${callId || '(no-call-id)'} ${String(session?.id ?? '').slice(-12)} (${source})`);
    deliver(message.title, message.content, 'question');
  };

  /** 在事件日志里找「还没有 result / reply」的 ask_user_question。 */
  const findPendingQuestion = (session) => {
    const end = Number(session?.seq ?? 0);
    if (end <= 0) return null;

    const lastStart = latestEvent(session, 'turn/start', 600);
    const lastEnd = latestEvent(session, 'turn/end', 600);
    if (!lastStart || (lastEnd && lastEnd.seq > lastStart.seq)) return null;

    const floor = Math.max(0, end - 600);
    for (let seq = end - 1; seq >= floor; seq -= 1) {
      const event = session.eventAt?.(seq);
      if (event?.type !== 'tool/call' || event.data?.name !== 'ask_user_question') continue;

      const callId = String(event.data.callId ?? '');
      let settled = false;
      for (let later = seq + 1; later < end; later += 1) {
        const next = session.eventAt?.(later);
        if (!next) continue;
        if (next.type === 'tool/result') {
          const resultId = String(
            next.data?.toolCallId ??
            next.data?.message?.toolCallId ??
            next.data?.message?.source?.callId ??
            '',
          );
          if (!callId || !resultId || resultId === callId) {
            settled = true;
            break;
          }
        }
        if (next.type === 'user/message' && String(next.data?.source?.callId ?? '') === callId) {
          settled = true;
          break;
        }
      }
      if (!settled) return event.data;
    }
    return null;
  };

  const onSessionEvent = (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return;

      switch (event.type) {
        case 'turn/start':
          state.turnStartedAt.set(session, event.time ?? Date.now());
          break;
        case 'session/title':
          if (event.data?.title) state.titles.set(session, event.data.title);
          break;
        case 'assistant/message': {
          const message = event.data?.message;
          const text = extractMessageText(message);
          if (text) {
            state.lastAssistant.set(session, {
              turn: event.data?.turn,
              text,
              seq: event.seq,
            });
          }
          break;
        }
        case 'approval/policy':
          if (event.data?.policy) state.approvalPolicy.set(session, event.data.policy);
          break;
        case 'approval/asked':
          onApprovalAsked(session, event);
          break;
        case 'tool/call':
          if (event.data?.name === 'ask_user_question') {
            notifyQuestion(session, event.data, 'event');
          }
          break;
        case 'turn/end':
          onTurnEnd(session, event);
          break;
        default:
          break;
      }
    } catch (error) {
      logWarn(`处理事件 ${String(event?.type)} 失败: ${String(error?.message ?? error)}`);
    }
  };

  ctx.on('session/event', onSessionEvent);

  // 插件在回合中途热加载时，补记当前已打开回合的起始时间。
  try {
    for (const session of ctx.sessions?.list?.() ?? []) {
      const start = latestEvent(session, 'turn/start', 80);
      const end = latestEvent(session, 'turn/end', 80);
      if (start && (!end || start.seq > end.seq)) {
        state.turnStartedAt.set(session, start.time ?? Date.now());
      }
    }
  } catch {
    /* 非致命 */
  }

  // 插件热加载/重启时，把当前仍停在 ask_user_question 上的任务补提醒一次。
  try {
    for (const session of ctx.sessions?.list?.() ?? []) {
      const pending = findPendingQuestion(session);
      if (pending) notifyQuestion(session, pending, 'pending-scan');
    }
  } catch {
    /* 非致命 */
  }

  logInfo(
    `已就绪: token=${maskToken(config.token)}, 任务完成=${config.notifyOnComplete ? '开' : '关'}, ` +
    `权限请求=${config.notifyOnPermission ? '开' : '关'}, 问题选择=${config.notifyOnQuestion ? '开' : '关'}, ` +
    `权限冷却=${config.permissionCooldownSeconds}s, ` +
    `超时=${config.timeoutMs}ms, 重试=${config.maxAttempts}次, ` +
    `备用=${config.fallbackEndpoint || '无'}, 日志=${config.logFile || '(仅 DSH 日志)'}`,
  );
  logInfo(`监听 session/event，等待 turn/end / approval/asked / ask_user_question`);

  // DSH 每次启动都会重新加载 profile 里的插件；这里发一条启动消息，
  // 既能确认「提醒服务已自启」，也能顺便验证 token/网络。
  // 用 globalThis 标记避免 HMR 重载插件时重复发送；DSH 进程重启后标记自然重置。
  const STARTUP_FLAG = Symbol.for('dsh-pushplus-notify.startup-notified');
  if (config.notifyOnStartup && globalThis[STARTUP_FLAG] !== true) {
    globalThis[STARTUP_FLAG] = true;
    deliver(
      '[DSH] 提醒服务已启动',
      [
        'DSH PushPlus 提醒服务已随 DSH 启动 ✅',
        '提醒范围: 任务完成 / 出错 / 中断 / 阻塞 / 权限请求 / 需要你做选择',
        `时间: ${formatTime()}`,
        `进程: ${process.pid}`,
      ].join('\n'),
      'startup',
    );
  }
}

/**
 * User-facing settings. Layering (lowest to highest):
 *   DEFAULTS < $DSH_HOME/pushplus-notify.json < plugin config < env token
 *
 * Keeping user values out of the profile patch and the package makes the
 * settings file the stable contract for a future settings UI.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_ENDPOINT = 'https://www.pushplus.plus/send';

export const DEFAULTS = Object.freeze({
  enabled: true,
  token: '',
  endpoint: DEFAULT_ENDPOINT,
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

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function settingsFilePath() {
  return process.env.DSH_PUSHPLUS_NOTIFY_SETTINGS || join(dshHome(), 'pushplus-notify.json');
}

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

export function normalizeSettings(raw, base = DEFAULTS) {
  const config = { ...base };
  if (!raw || typeof raw !== 'object') return config;

  config.enabled = asBool(pick(raw, 'enabled'), config.enabled);
  config.token = asString(pick(raw, 'token', 'pushplusToken', 'pushplus_token'), config.token);
  config.endpoint = asString(pick(raw, 'endpoint', 'url'), config.endpoint);
  config.fallbackEndpoint = asString(
    pick(raw, 'fallbackEndpoint', 'fallback_endpoint'),
    config.fallbackEndpoint,
  );
  if (config.fallbackEndpoint === config.endpoint) config.fallbackEndpoint = '';
  config.template = asString(pick(raw, 'template'), config.template);
  config.channel = asString(pick(raw, 'channel'), config.channel);
  config.to = asString(pick(raw, 'to'), config.to);  config.timeoutMs = asNumber(pick(raw, 'timeoutMs', 'timeout_ms', 'timeout'), config.timeoutMs, {
    min: 1000,
    max: 60000,
    integer: true,
  });
  config.maxAttempts = asNumber(pick(raw, 'maxAttempts', 'max_attempts'), config.maxAttempts, {
    min: 1,
    max: 5,
    integer: true,
  });
  config.retryDelayMs = asNumber(pick(raw, 'retryDelayMs', 'retry_delay_ms'), config.retryDelayMs, {
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
    config.maxSummaryChars,
    { min: 20, max: 1000, integer: true },
  );
  config.completeCooldownSeconds = asNumber(
    pick(raw, 'completeCooldownSeconds', 'complete_cooldown_seconds', 'cooldownSeconds', 'cooldown_seconds'),
    config.completeCooldownSeconds,
    { min: 0, max: 86400 },
  );
  config.permissionCooldownSeconds = asNumber(
    pick(raw, 'permissionCooldownSeconds', 'permission_cooldown_seconds'),
    config.permissionCooldownSeconds,
    { min: 0, max: 86400 },
  );
  config.logFile = asString(pick(raw, 'logFile', 'log_file'), config.logFile);
  return config;}

function readUserSettings(ctx) {
  const file = settingsFilePath();
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try {
        ctx?.logger?.warn?.(`pushplus-notify: 读取设置失败 (${file}): ${String(error?.message ?? error)}`);
      } catch {
        /* ignore */
      }
    }
    return {};
  }
}

export function loadSettings(pluginConfig, ctx) {
  let user = readUserSettings(ctx);
  if (user?.wechat_notify && typeof user.wechat_notify === 'object') {
    user = { ...user, ...user.wechat_notify };
  }
  if (user?.pushplus && typeof user.pushplus === 'object') {
    user = { ...user, ...user.pushplus };
  }

  const config = normalizeSettings(pluginConfig, normalizeSettings(user, DEFAULTS));
  const envToken = process.env.PUSHPLUS_TOKEN || process.env.DSH_PUSHPLUS_TOKEN;
  if (envToken) config.token = envToken.trim();
  if (!config.logFile) config.logFile = join(dshHome(), 'logs', 'pushplus-notify.log');
  return config;
}

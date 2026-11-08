/**
 * Bundle entry. This file is intentionally only wiring: settings -> logger ->
 * transport -> event router. Feature work belongs in the small lib modules.
 */
import { readFileSync } from 'node:fs';

import { loadSettings, settingsFilePath } from './config.js';
import { createRouter } from './events.js';
import { buildStartupNotification } from './format.js';
import { createLogger } from './log.js';
import { createTransport } from './pushplus.js';
import { createSessionTools } from './session.js';
import { createState } from './state.js';
import { maskToken } from './text.js';

export const name = 'pushplus-notify';
export const inject = ['sessions'];

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = pkg.version;

export function apply(ctx, rawConfig) {
  const settings = loadSettings(rawConfig, ctx);
  const logger = createLogger(ctx, settings);

  if (!settings.enabled) {
    logger.info('已禁用（settings.enabled = false），不注册任何监听');
    return;
  }
  if (!settings.token) {
    logger.warn(
      `未配置 PushPlus token；运行 npx @fanpaisk/dsh-pushplus-notify setup，` +
      `或写入 ${settingsFilePath()}（token 获取: https://www.pushplus.plus/）`,
    );
    return;
  }

  const state = createState();
  const sessionTools = createSessionTools(ctx, settings, state);
  const transport = createTransport(settings, logger);
  const pending = new Set();

  const deliver = (notification) => {
    const task = transport.send(notification)
      .then((result) => {
        if (result.ok) {
          logger.info(`已发送 ${notification.tag}: ${notification.title}`);
        } else {
          logger.warn(`发送失败 ${notification.tag}: ${notification.title} - ${result.error}`);
        }
      })
      .catch((error) => {
        logger.warn(`发送异常 ${notification.tag}: ${String(error?.message ?? error)}`);
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  };

  // One-shot DSH processes (headless) exit right after turn/end; wait for
  // pending sends during disposal so the notification is not dropped.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      if (pending.size === 0) return;
      logger.info(`插件卸载，等待 ${pending.size} 条未完成的推送...`);
      await Promise.allSettled([...pending]);
    }, 'pushplus-notify pending sends');
  }

  const router = createRouter({ settings, state, sessionTools, deliver, logger });
  ctx.on('session/event', router.handle);
  router.prime(ctx.sessions?.list?.() ?? []);

  logger.info(
    `v${version} 已就绪: token=${maskToken(settings.token)}, ` +
    `完成=${settings.notifyOnComplete ? '开' : '关'}, 出错=${settings.notifyOnError ? '开' : '关'}, ` +
    `权限=${settings.notifyOnPermission ? '开' : '关'}, 选择=${settings.notifyOnQuestion ? '开' : '关'}, ` +
    `超时=${settings.timeoutMs}ms, 重试=${settings.maxAttempts}次, ` +
    `备用=${settings.fallbackEndpoint || '无'}, 日志=${settings.logFile}`,
  );
  logger.info('监听 session/event: turn/end / approval/asked / ask_user_question');

  const STARTUP_FLAG = Symbol.for('dsh-pushplus-notify.startup-notified');
  if (settings.notifyOnStartup && globalThis[STARTUP_FLAG] !== true) {
    globalThis[STARTUP_FLAG] = true;
    deliver(buildStartupNotification({ version, pid: process.pid }));
  }
}

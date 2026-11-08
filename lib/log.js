/** File + DSH logger. The file path and directory are owned by settings. */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatTime } from './text.js';

export function createLogger(ctx, settings) {
  let broken = false;
  let dirReady = null;

  const writeFile = (line) => {
    if (!settings.logFile || broken) return;
    const text = `[${formatTime()}] ${line}\n`;
    dirReady ??= mkdir(dirname(settings.logFile), { recursive: true });
    void dirReady
      .then(() => appendFile(settings.logFile, text, 'utf8'))
      .catch((error) => {
        broken = true;
        try {
          ctx?.logger?.warn?.(`pushplus-notify: 写入日志失败 (${settings.logFile}): ${String(error?.message ?? error)}`);
        } catch {
          /* ignore */
        }
      });
  };

  const emit = (level, context, message) => {
    try {
      context?.[level]?.(`pushplus-notify: ${message}`);
    } catch {
      /* ignore */
    }
    writeFile(`${level.toUpperCase().padEnd(5)} ${message}`);
  };

  return {
    info: (message) => emit('info', ctx?.logger, message),
    warn: (message) => emit('warn', ctx?.logger, message),
    error: (message) => emit('error', ctx?.logger, message),
  };
}

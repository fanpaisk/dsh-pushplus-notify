/** Pure notification builders. No DSH or network dependencies. */
import { collapse, formatDuration, formatTime, truncate } from './text.js';

function commonLines(info, durationMs, time) {
  const lines = [];
  if (info?.cwd) lines.push(`工作区: ${info.cwd}`);
  const duration = formatDuration(durationMs);
  if (duration) lines.push(`用时: ${duration}`);
  lines.push(`时间: ${formatTime(time)}`);
  if (info?.sessionId) lines.push(`会话: ${String(info.sessionId).slice(-12)}`);
  return lines;
}

export function buildTurnNotification({ kind, reason = {}, info, summary = '', durationMs, time = Date.now() }) {
  const lines = [];
  let title = '';

  switch (kind) {
    case 'completed':
      title = '[DSH] 任务已完成';
      lines.push(`任务 ${info.label} 已完成 ✅`);
      if (summary) lines.push(`结果摘要: ${summary}`);
      break;
    case 'error': {
      title = '[DSH] 任务出错';
      lines.push(`任务 ${info.label} 执行出错 ❌`);
      const failure = reason.error ?? {};
      const detail = truncate(collapse([failure.code, failure.message].filter(Boolean).join(': ')), 240);
      if (detail) lines.push(`错误: ${detail}`);
      break;
    }
    case 'aborted': {
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
    case 'blocked':
      title = '[DSH] 任务等待处理';
      lines.push(`任务 ${info.label} 被阻塞 ⏸`);
      lines.push('说明: 等待你的输入、确认或外部条件');
      break;
    case 'max-tokens':
      title = '[DSH] 输出达到上限';
      lines.push(`任务 ${info.label} 达到输出上限 ⚠`);
      lines.push('说明: 回合因 token 上限结束，可以继续发消息让它接着做');
      break;
    default:
      return null;
  }

  lines.push(...commonLines(info, durationMs, time));
  return { title, content: lines.join('\n'), tag: kind };
}

export function buildApprovalNotification({ info, data = {}, time = Date.now() }) {
  const lines = [`任务 ${info.label} 正在等待权限确认 🔐`];
  if (data.toolName) lines.push(`操作: ${data.toolName}`);
  const reason = truncate(collapse(data.reason), 200);
  if (reason) lines.push(`原因: ${reason}`);
  if (info.cwd) lines.push(`工作区: ${info.cwd}`);
  lines.push(`时间: ${formatTime(time)}`);
  return { title: '[DSH] 等待权限确认', content: lines.join('\n'), tag: 'permission' };
}

export function buildQuestionNotification({ info, data = {}, time = Date.now() }) {
  const lines = [`任务 ${info.label} 正在等你选择/回答 ❓`];

  let parsed = null;
  try {
    parsed = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
  } catch {
    parsed = null;
  }
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];

  if (questions.length === 0) {
    const raw = truncate(collapse(data.arguments), 300);
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

  if (info.cwd) lines.push(`工作区: ${info.cwd}`);
  lines.push(`时间: ${formatTime(time)}`);
  if (info.sessionId) lines.push(`会话: ${String(info.sessionId).slice(-12)}`);
  return { title: '[DSH] 需要你做出选择', content: lines.join('\n'), tag: 'question' };
}

export function buildStartupNotification({ version, pid, time = Date.now() }) {
  return {
    title: '[DSH] 提醒服务已启动',
    content: [
      'DSH PushPlus 提醒服务已随 DSH 启动 ✅',
      '提醒范围: 任务完成 / 出错 / 中断 / 阻塞 / 权限请求 / 需要你做选择',
      `版本: ${version}`,
      `时间: ${formatTime(time)}`,
      `进程: ${pid}`,
    ].join('\n'),
    tag: 'startup',
  };
}

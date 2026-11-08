/**
 * Session event router: maps DSH events to notification models and delegates
 * delivery to the host. Adding a new event type or formatter does not touch
 * the transport or settings layers.
 */
import { buildApprovalNotification, buildQuestionNotification, buildTurnNotification } from './format.js';
import { remember } from './state.js';
import { collapse, extractMessageText, truncate } from './text.js';

const QUESTION_SEEN_KEY = Symbol.for('dsh-pushplus-notify.question-seen');

const TURN_TOGGLES = {
  completed: 'notifyOnComplete',
  error: 'notifyOnError',
  aborted: 'notifyOnAbort',
  blocked: 'notifyOnBlocked',
  'max-tokens': 'notifyOnMaxTokens',
};

export function createRouter({ settings, state, sessionTools, deliver, logger }) {
  const questionSeen = globalThis[QUESTION_SEEN_KEY] ??= new Set();

  const infoOf = (session) => ({
    ...sessionTools.describe(session),
    sessionId: String(session?.id ?? ''),
  });

  const onTurnEnd = (session, event) => {
    if (!settings.notifyOnSubagent && sessionTools.isSubagent(session)) return;

    const kind = event?.data?.reason?.kind;
    const toggle = TURN_TOGGLES[kind];
    if (!toggle || !settings[toggle]) return;

    const turn = event?.data?.turn;
    const dedupeKey = `${String(session?.id ?? '')}#${turn}#${event?.seq ?? 0}`;
    if (!remember(state.seenTurnEnds, state.turnEndOrder, dedupeKey)) return;

    const sessionId = String(session?.id ?? '');
    const last = state.lastCompleteAt.get(sessionId) ?? 0;
    if (settings.completeCooldownSeconds > 0 &&
        Date.now() - last < settings.completeCooldownSeconds * 1000) {
      logger.info(`完成提醒处于冷却期，跳过 (${kind}) ${sessionId.slice(-12)}`);
      return;
    }
    state.lastCompleteAt.set(sessionId, Date.now());
    const startedAt = state.turnStartedAt.get(session);
    state.turnStartedAt.delete(session);

    const summary = kind === 'completed' && settings.includeSummary
      ? truncate(collapse(sessionTools.summaryFor(session, turn)), settings.maxSummaryChars)
      : '';
    const notification = buildTurnNotification({
      kind,
      reason: event.data?.reason ?? {},
      info: infoOf(session),
      summary,
      durationMs: Number.isFinite(startedAt) ? Date.now() - startedAt : undefined,
      time: Date.now(),
    });
    if (!notification) return;

    logger.info(`[${notification.tag}] ${notification.title} ${sessionId.slice(-12)}`);
    deliver(notification);
  };

  const onApprovalAsked = (session, event) => {
    if (!settings.notifyOnPermission) return;
    if (!settings.notifyOnSubagent && sessionTools.isSubagent(session)) return;
    if (state.approvalPolicy.get(session) === 'never') return;

    const id = String(event?.data?.id ?? '');
    if (id && !remember(state.seenApprovalIds, state.approvalIdOrder, id)) return;

    const sessionId = String(session?.id ?? '');
    const last = state.lastPermissionAt.get(sessionId) ?? 0;
    if (settings.permissionCooldownSeconds > 0 &&
        Date.now() - last < settings.permissionCooldownSeconds * 1000) {
      logger.info(`权限提醒处于冷却期，跳过 ${sessionId.slice(-12)}`);
      return;
    }
    state.lastPermissionAt.set(sessionId, Date.now());

    const notification = buildApprovalNotification({
      info: infoOf(session),
      data: event?.data ?? {},
    });
    logger.info(`[permission] ${event?.data?.toolName ?? '未知操作'} ${sessionId.slice(-12)}`);
    deliver(notification);
  };

  /** ask_user_question is a tool/call; it never produces turn/end. */
  const notifyQuestion = (session, data, source) => {
    if (!settings.notifyOnQuestion) return;
    if (!settings.notifyOnSubagent && sessionTools.isSubagent(session)) return;
    if (!data || data.name !== 'ask_user_question') return;

    const callId = String(data.callId ?? '');
    const key = callId || `${String(session?.id ?? '')}:${String(data.arguments ?? '').slice(0, 160)}`;
    if (questionSeen.has(key)) return;
    questionSeen.add(key);
    while (questionSeen.size > 500) {
      questionSeen.delete(questionSeen.values().next().value);
    }

    const notification = buildQuestionNotification({
      info: infoOf(session),
      data,
    });
    logger.info(`[question] ${callId || '(no-call-id)'} ${String(session?.id ?? '').slice(-12)} (${source})`);
    deliver(notification);
  };

  const handle = (session, event) => {
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
          const text = extractMessageText(event.data?.message);
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
      logger.warn(`处理事件 ${String(event?.type)} 失败: ${String(error?.message ?? error)}`);
    }
  };

  /** Prime state and catch questions that were already pending at load time. */
  const prime = (sessions) => {
    try {
      for (const session of sessions ?? []) {
        const start = sessionTools.latestEvent(session, 'turn/start', 80);
        const end = sessionTools.latestEvent(session, 'turn/end', 80);
        if (start && (!end || start.seq > end.seq)) {
          state.turnStartedAt.set(session, start.time ?? Date.now());
        }
      }
    } catch {
      /* non-fatal */
    }

    try {
      for (const session of sessions ?? []) {
        const pending = sessionTools.findPendingQuestion(session);
        if (pending) notifyQuestion(session, pending, 'pending-scan');
      }
    } catch {
      /* non-fatal */
    }
  };

  return { handle, prime };
}

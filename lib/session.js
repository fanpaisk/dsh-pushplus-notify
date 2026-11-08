/** Read-only helpers over DSH session objects. Kept separate from event routing. */
import { basename } from 'node:path';
import { collapse, extractMessageText, truncate } from './text.js';

export function createSessionTools(ctx, settings, state) {
  const latestEvent = (session, type, maxBack = 400) => {
    try {
      const end = Number(session?.seq ?? 0);
      const floor = Math.max(0, end - maxBack);
      for (let seq = end - 1; seq >= floor; seq -= 1) {
        const event = session.eventAt?.(seq);
        if (event?.type === type) return event;
      }
    } catch {
      /* ignore */
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
      /* session-title service may not be composed */
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

  /**
   * Find an ask_user_question tool call that has no result/reply yet.
   * Used when the plugin loads mid-question (HMR/reload) to avoid missing it.
   */
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

  return {
    latestEvent,
    resolveTitle,
    describe,
    isSubagent,
    summaryFor,
    findPendingQuestion,
  };
}

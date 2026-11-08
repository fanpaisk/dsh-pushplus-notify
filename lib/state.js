/** Per-process mutable state. All session-keyed maps are WeakMaps. */
export function createState() {
  return {
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
}

/** Bounded set+order pair used for dedupe keys. */
export function remember(set, order, value, limit = 500) {
  if (set.has(value)) return false;
  set.add(value);
  order.push(value);
  while (order.length > limit) {
    const oldest = order.shift();
    set.delete(oldest);
  }
  return true;
}

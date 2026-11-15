/**
 * In-process re-entrancy guard for a long-running action: while one run of
 * `${telegramId}:${actionKey}` is still going, a second start of the SAME action
 * (for example one begun from a scheduled job or a different update path) is
 * refused instead of overlapping. A simple Set is enough — it only needs to
 * survive within one Node process's lifetime.
 *
 * It is NOT what protects against double-tapped buttons: every person's updates
 * are processed strictly one at a time (lib/userSerializer.js), so a second tap
 * only runs after the first has finished and released its lock. That job belongs
 * to lib/rapidTap.js (drops an identical tap that arrives within ~1.2s) and to
 * confirmation buttons that name the state they set, so a repeat is a no-op.
 *
 * Keyed by `${telegramId}:${actionKey}`, not just telegramId — a lock
 * scoped to the whole user would block two genuinely unrelated actions
 * from ever overlapping (e.g. Delete Repo on one repo blocking a Fork on a
 * completely different one), which isn't what this is for. Only a second
 * tap of the SAME action should be blocked. This also already made the
 * mechanism itself safe for open multi-user access (v1.1.0-multi) with no
 * changes needed here — two different people's actions were always keyed
 * separately by their own telegram_id, never sharing a lock.
 */
const locked = new Set();

function tryAcquire(key) {
  if (locked.has(key)) return false;
  locked.add(key);
  return true;
}

function release(key) {
  locked.delete(key);
}

/** Runs fn only if no matching action is already in flight for this
 * person. `actionKey` scopes the lock (e.g. 'deleteRepo', 'fork') so
 * unrelated actions never block each other. Returns { skipped: true } if
 * a duplicate tap of the SAME action was blocked. */
async function withLock(telegramId, actionKey, fn) {
  // Backward-compatible with the old 2-arg call shape (telegramId, fn) —
  // treated as one shared 'default' action key, same behavior as before.
  if (typeof actionKey === 'function') {
    fn = actionKey;
    actionKey = 'default';
  }
  const key = `${telegramId}:${actionKey}`;
  if (!tryAcquire(key)) return { skipped: true };
  try {
    await fn();
    return { skipped: false };
  } finally {
    release(key);
  }
}

module.exports = { withLock };

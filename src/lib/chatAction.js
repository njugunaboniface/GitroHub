const ACTIVE_ACTIONS = new WeakMap();

function getChatId(ctx) {
  return ctx && ctx.chat && ctx.chat.id != null ? ctx.chat.id : null;
}

async function sendChatAction(ctx, action) {
  const chatId = getChatId(ctx);
  if (chatId == null || !ctx.telegram || !action) return false;
  try {
    await ctx.telegram.sendChatAction(chatId, action);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Keep a native Telegram chat action alive for operations that may outlive
 * Telegram's short action window. A single action loop is maintained per
 * context so nested helpers do not create competing timers.
 */
function startChatAction(ctx, action, intervalMs = 4000) {
  if (!ctx || !action) return () => {};

  const previous = ACTIVE_ACTIONS.get(ctx);
  if (previous) previous();

  let stopped = false;
  const tick = () => {
    if (!stopped) sendChatAction(ctx, action).catch(() => {});
  };

  tick();
  const timer = setInterval(tick, Math.max(2500, intervalMs));
  if (typeof timer.unref === 'function') timer.unref();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (ACTIVE_ACTIONS.get(ctx) === stop) ACTIVE_ACTIONS.delete(ctx);
  };

  ACTIVE_ACTIONS.set(ctx, stop);
  return stop;
}

async function withChatAction(ctx, action, fn, intervalMs = 4000) {
  const stop = startChatAction(ctx, action, intervalMs);
  try {
    return await fn();
  } finally {
    stop();
  }
}

module.exports = {
  sendChatAction,
  startChatAction,
  withChatAction,
};

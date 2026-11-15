/**
 * Rapid duplicate-tap guard (v1.2.3-multi).
 *
 * Telegram clients happily deliver the same inline-button tap twice when a
 * finger bounces. Because every user's updates are processed strictly one at
 * a time (lib/userSerializer.js), the second tap is not "concurrent" with
 * the first — it simply runs right after it, so toggle-style buttons (pin,
 * mute, notification switches, maintenance, ...) flipped twice and ended up
 * exactly where they started.
 *
 * This guard looks at ARRIVAL time: if the same user taps the same button
 * (same chat, same message, same callback data) again within WINDOW_MS of
 * the previous tap, the repeat is dropped before it is queued. It is a
 * process-local, size-bounded map — the bot runs as one replica — and it only
 * ever drops exact repeats, so two different buttons are never affected.
 */
const WINDOW_MS = 1200;
const MAX_ENTRIES = 5000;

class RapidTapGuard {
  constructor({ windowMs = WINDOW_MS, maxEntries = MAX_ENTRIES } = {}) {
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.seen = new Map();
  }

  /** True when this exact tap already arrived within the window. Records it otherwise. */
  isDuplicate(userId, chatId, messageId, data, now = Date.now()) {
    if (data == null || messageId == null) return false;
    const key = `${userId}:${chatId}:${messageId}:${data}`;
    const last = this.seen.get(key);
    // Refresh the timestamp either way so a held-down / repeated tap keeps being ignored.
    this.seen.delete(key);
    this.seen.set(key, now);
    if (this.seen.size > this.maxEntries) this._prune(now);
    return last !== undefined && now - last < this.windowMs;
  }

  _prune(now) {
    for (const [key, at] of this.seen) {
      if (now - at >= this.windowMs) this.seen.delete(key);
      else break; // Map keeps insertion order, and we re-insert on every touch
    }
    // Still over the cap (a flood inside one window): drop the oldest.
    while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value);
  }
}

module.exports = { RapidTapGuard, WINDOW_MS };

/**
 * Status-page tiles (v1.2.5-multi) — ONE mapping from runtime health to the tiles the public status page shows,
 * used by the server-rendered page (works without JavaScript) and by /status.json (the page's live refresh).
 * Nothing sensitive: states and plain words only — no user counts, no tokens, no versions of dependencies.
 * `icon` is an icon NAME from server/icons.js (never an emoji): the page turns it into an inline SVG.
 */
function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** @param h result of runtimeMetrics.getHealth() */
function build(h, { version = '', uptimeSeconds = 0, now = new Date() } = {}) {
  const status = (h && h.status) || 'UNAVAILABLE';
  const overall = status === 'HEALTHY' ? 'ok' : status === 'DEGRADED' ? 'degraded' : 'down';
  const pg = !!(h && h.pgStatus && h.pgStatus.ok);
  const rd = !!(h && h.redisStatus && h.redisStatus.ok);
  const traffic = h && h.traffic;
  const circuit = traffic && traffic.breaker ? traffic.breaker.state : null;
  const queued = traffic ? Number(traffic.queued) || 0 : 0;
  const active = traffic ? Number(traffic.active) || 0 : 0;

  const github = circuit === 'open' ? { state: 'bad', value: 'Paused', hint: 'Waiting for GitHub to recover' }
    : circuit === 'half-open' ? { state: 'warn', value: 'Recovering', hint: 'Testing the connection' }
      : { state: 'ok', value: 'Operational', hint: 'Talking to GitHub normally' };
  const queue = queued > 50 ? { state: 'warn', value: `${queued} waiting`, hint: 'Busier than usual' }
    : queued > 0 || active > 0 ? { state: 'ok', value: 'Working', hint: queued ? `${queued} waiting` : 'Keeping up' }
      : { state: 'ok', value: 'Idle', hint: 'Nothing waiting' };

  return {
    overall,
    label: overall === 'ok' ? 'All systems operational' : overall === 'degraded' ? 'Running, but under pressure' : 'Service disruption',
    checkedAt: now.toISOString(),
    tiles: [
      { id: 'bot', icon: 'logo', label: 'Bot', state: 'ok', value: 'Online', hint: 'Answering messages' },
      { id: 'db', icon: 'database', label: 'Database', state: pg ? 'ok' : 'bad', value: pg ? 'Connected' : 'Unavailable', hint: pg ? 'Saving your data' : 'Cannot reach storage' },
      { id: 'redis', icon: 'cache', label: 'Cache', state: rd ? 'ok' : 'bad', value: rd ? 'Connected' : 'Unavailable', hint: rd ? 'Sessions and queues' : 'Cannot reach the cache' },
      { id: 'github', icon: 'github', label: 'GitHub API', ...github },
      { id: 'queue', icon: 'queue', label: 'Work queue', ...queue },
      { id: 'uptime', icon: 'clock', label: 'Uptime', state: 'info', value: formatUptime(uptimeSeconds), hint: 'Since the last restart' },
    ],
    version: String(version || ''),
  };
}

module.exports = { build, formatUptime };

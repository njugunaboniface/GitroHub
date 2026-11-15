/**
 * Quiet Hours (v1.2.3-multi): one definition, used by every unsolicited message GitroHub
 * sends on its own schedule — live-alert digests, daily/weekly rollups and the weekly
 * automation messages. Help promises that quiet hours "hold anything due" until the
 * window ends; only the webhook digest honoured that, the rest kept sending at 3am.
 *
 * The window is the person's own clock (users.timezone), start inclusive, end
 * exclusive, and may wrap past midnight (e.g. 22 -> 7). It is "unset" unless BOTH
 * ends are set.
 */
const timezone = require('./timezone');

function isQuietNow(user, now = new Date()) {
  if (!user || user.quiet_hours_start == null || user.quiet_hours_end == null) return false;
  const hour = timezone.getHourInZone(now, user.timezone || 'UTC');
  const qs = user.quiet_hours_start;
  const qe = user.quiet_hours_end;
  if (qs === qe) return false;
  return qs < qe ? (hour >= qs && hour < qe) : (hour >= qs || hour < qe);
}

module.exports = { isQuietNow };

/**
 * One-time recovery from the pre-1.1.24 false restrictions.
 *
 * Deliberately NOT part of Warden: Warden (lib/warden.js, lib/wardenBrain/*)
 * has no capability to change what anyone can do. This routine only ever LIFTS
 * a limit, once, at boot, and is invoked from index.js.
 */
const { pool } = require('../db/postgres');
const { logAction } = require('./warden');

/**
 * v1.1.24-multi. Before this version Warden restricted people (cap = 10/hour)
 * whose ONLY signal was a benign connection "anomaly", and it restricted
 * admins/the owner too. Those caps outlive the bug: the flag never expired
 * and nothing lifted the restriction, so people kept hitting the wall long
 * after the cause was fixed. This lifts exactly those cases, once:
 *   - the OWNER and every admin: any cap override is removed (they are exempt);
 *   - anyone whose live 'restrict' was caused by the anomaly signal alone.
 * Anyone restricted for real (errors, failed commits…) stays restricted.
 * Guarded by a marker row in warden_action_log so it never runs twice, and
 * it only touches the cap Warden itself set (exactly 10).
 */
async function releaseFalseRestrictions(bot) {
  const MARKER = 'release_false_restrictions_v1_1_24';
  const { rows: done } = await pool.query(
    'SELECT 1 FROM warden_action_log WHERE action_type = $1 LIMIT 1', [MARKER]
  );
  if (done.length) return { skipped: true, released: 0 };

  const { rows: freed } = await pool.query(
    `UPDATE users u SET hourly_action_cap_override = NULL
      WHERE u.hourly_action_cap_override = 10
        AND (
          u.is_admin = true
          OR EXISTS (SELECT 1 FROM admin_roles r WHERE r.telegram_id = u.telegram_id)
          OR u.telegram_id = ANY($1::bigint[])
          OR EXISTS (
            SELECT 1 FROM warden_action_log l
             WHERE l.target_id = u.telegram_id AND l.action_type = 'restrict' AND l.dry_run = false
               AND l.reason = 'Triggered by: flagged by anomaly detection.'
          )
        )
      RETURNING u.telegram_id, u.is_admin`,
    [require('../config').ADMIN_IDS]
  );

  if (freed.length) {
    const ids = freed.map((r) => r.telegram_id);
    await pool.query(
      `UPDATE warden_user_state SET escalation_level = 0, confidence_score = 0, last_action_type = NULL, last_action_at = NULL
        WHERE telegram_id = ANY($1::bigint[])`, [ids]
    );
    for (const r of freed) {
      await logAction(r.telegram_id, 'unrestrict', 'Lifted: restriction came from the pre-1.1.24 anomaly rule (false positive)', { dryRun: false });
      // Only ordinary users get told; admins were never meant to see this.
      if (bot && !r.is_admin) {
        await bot.telegram.sendMessage(
          r.telegram_id,
          `✅ Good news — the activity restriction on your account has been lifted. It was applied by mistake, sorry about that. Everything works normally again.`
        ).catch(() => {});
      }
    }
  }
  await logAction(0, MARKER, `released ${freed.length}`, { dryRun: false });
  return { skipped: false, released: freed.length };
}


module.exports = { releaseFalseRestrictions };

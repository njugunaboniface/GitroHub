/**
 * Warning Engine — every significant Warden decision carries an explanation.
 *
 *   decision ──▶ ownerCard()        technical, full diagnostics (HTML)
 *            ├─▶ userNotice()       plain language, NO scores/thresholds (plain text)
 *            └─▶ enforcementNotice() the exact, specific notice for a real action
 *
 * The user is never shown the internal score, detection thresholds or the
 * security logic — only what was observed about their own activity, what it
 * does and doesn't mean, and what they can do. And none of it is ever sent
 * automatically: userNotice() is previewed to the owner and sent only on
 * their explicit confirmation.
 */
const { STAGE_LABEL, STAGE_ICON } = require('./engine');

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const INTERPRETATION = {
  normal: 'Nothing unusual.',
  observe: 'Slightly unusual. Noted, but there is not enough evidence to conclude anything.',
  flag: "Activity is notably above this user's baseline, but the evidence is insufficient to draw conclusions.",
  enhanced_monitoring: 'Independent signals agree that this behaviour is unusual for this user. Warden is watching closely; no action is warranted yet.',
  review_candidate: 'The pattern is sustained, corroborated by independent signals, and has recurred. It is ready for your judgement — Warden itself takes no action.',
};
const DECISION = {
  normal: '🟢 Nothing to do', observe: '🔵 Keep monitoring', flag: '🚩 Continue monitoring',
  enhanced_monitoring: '🔎 Continue enhanced monitoring', review_candidate: '🧾 Ready for your review',
};

const fmtDate = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const age = (createdAt) => Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 86400000));

/** Technical version for the Owner Board. */
function ownerCard({ caseRow, user, summary, extras = {} }) {
  const s = summary || caseRow.summary || {};
  const stage = caseRow.stage;
  const handle = user && user.telegram_username ? `@${esc(user.telegram_username)}` : esc((user && user.telegram_first_name) || 'unknown');
  const p = s.persistence || {};
  const lines = [];
  lines.push(`🛡️ <b>Warden case #${caseRow.id}</b> — ${STAGE_ICON[stage]} ${esc(STAGE_LABEL[stage])}`);
  lines.push('');
  lines.push(`<b>User:</b> ${handle} (<code>${caseRow.telegram_id}</code>)`);
  lines.push(`<b>Risk:</b> ${Math.round(caseRow.risk ?? s.risk ?? 0)}/100`);
  lines.push(`<b>Confidence:</b> ${esc(s.confidenceLabel || 'n/a')} (${Number(caseRow.confidence ?? s.confidence ?? 0).toFixed(2)})`);
  lines.push('<b>Action:</b> none — Warden never acts on its own');
  lines.push('');
  lines.push('<b>Evidence</b>');
  if ((s.reasons || []).length) for (const r of s.reasons) lines.push(`• ${esc(r)}`);
  else lines.push('• (none currently above the noise floor)');
  if (p.longest_run_hours) {
    lines.push(`• Persisted up to ${p.longest_run_hours}h continuously across ${p.sessions_abnormal || 0} session${p.sessions_abnormal === 1 ? '' : 's'}, ${p.episodes || 1} separate episode${p.episodes === 1 ? '' : 's'} over ${p.distinct_days || 1} day${p.distinct_days === 1 ? '' : 's'}`);
  }
  lines.push('');
  lines.push('<b>Historical context</b>');
  lines.push(`• Account age: ${user ? age(user.created_at) : '?'} days · baseline: ${esc(s.maturity || 'n/a')}`);
  lines.push(`• Earlier cases: ${extras.priorCases ?? 0} · warnings sent: ${extras.warnings ?? 0}`);
  lines.push(`• ⭐ Trusted: ${user && user.is_trusted ? 'yes' : 'no'} · 🛡 Repos protected: ${user && user.repos_protected ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('<b>Legitimate-use check</b>');
  if ((s.benign || []).length) for (const b of s.benign) lines.push(`• ${esc(b.note)}`);
  else lines.push('• No strong innocent explanation identified.');
  if ((s.blockers || []).length) {
    lines.push('');
    lines.push('<b>Why not higher</b>');
    for (const b of s.blockers.slice(0, 4)) lines.push(`• ${esc(b)}`);
  }
  lines.push('');
  lines.push(`<b>Interpretation:</b> ${esc(INTERPRETATION[stage])}`);
  lines.push(`<b>Warden decision:</b> ${DECISION[stage]}`);
  if (extras.snoozedUntil) lines.push(`💤 Snoozed until ${esc(fmtDate(extras.snoozedUntil))}`);
  return lines.join('\n');
}

/** What the user is told — observations about THEIR OWN activity only. */
function observationsFor(classes) {
  const out = [];
  for (const c of classes || []) {
    const o = c.observed || {}; const b = c.baseline || {};
    if (c.class === 'rate' && o.actions) {
      const usual = b.source === 'personal' && b.rate_median ? ` (your usual is around ${Math.max(1, Math.round(b.rate_median))} an hour)` : '';
      out.push(`${o.actions} actions in a single hour${usual}`);
    } else if (c.class === 'failures' && o.errors) {
      out.push(`${o.errors} operations failed during that time`);
    } else if (c.class === 'repetition' && o.repeats) {
      out.push('The same button was pressed again and again within a few seconds');
    } else if (c.class === 'throttle' && o.cap_hits) {
      out.push(`${o.cap_hits} of your actions were turned away by the hourly limit`);
    }
  }
  return out;
}

function adviceFor(classes) {
  const has = (k) => (classes || []).some((c) => c.class === k);
  const tips = ['You can keep using GitroHub normally.'];
  if (has('failures') || has('repetition')) tips.push("If something keeps failing, please don't keep retrying it — give it a moment, or check Settings to see that your GitHub connection is still active.");
  if (has('rate')) tips.push("If you're running a large batch (for example a big upload or a bulk action), let it finish instead of starting it again.");
  tips.push('If anything looks wrong on your side, you can reach the admin from /help → 📞 Contact Admin.');
  return tips;
}

/** Plain-language notice for the USER. Plain text, no scores, no thresholds. */
function userNotice(classes) {
  const obs = observationsFor(classes);
  return [
    '⚠️ Unusual activity noticed',
    '',
    "GitroHub noticed that your account's activity recently looked different from your usual pattern.",
    '',
    'What we observed',
    ...(obs.length ? obs.map((o) => `• ${o}`) : ['• Activity that differed noticeably from your usual pattern']),
    '',
    'What this means',
    "This doesn't necessarily mean anything is wrong, and no restriction has been applied to your account.",
    '',
    'What you can do',
    ...adviceFor(classes).map((t) => `• ${t}`),
    '',
    'Current status: 🟢 Monitoring only',
  ].join('\n');
}

const ENFORCEMENT = {
  ban: {
    title: (o) => (o.durationText ? `🚫 Your access to GitroHub has been revoked for ${o.durationText}` : '🚫 Your access to GitroHub has been permanently revoked'),
    means: (o) => (o.durationText
      ? ['• Your GitHub connection has been disconnected \u2014 you will need to reconnect it afterwards.', `• You can\u2019t use the bot for ${o.durationText}` + (o.untilText ? ` (${o.untilText})` : '') + '; access returns automatically.']
      : ['• Your GitHub connection has been disconnected.', '• You can no longer use the bot.']),
  },
  suspend: {
    title: (o) => `⏸️ Your access to GitroHub has been paused for ${o.durationText}`,
    means: (o) => ['• You can\u2019t use the bot until the pause ends' + (o.untilText ? ` (${o.untilText})` : '') + '.', '• Your GitHub connection and your repositories are untouched.', '• Access returns automatically \u2014 you don\u2019t need to do anything.'],
  },
  restrict: {
    title: '🚧 A temporary limit has been placed on your account',
    means: (o) => [`• You can perform up to ${o.limit} actions per hour for now.`, '• Everything else works as normal.'],
  },
};

/** The exact notice for a real enforcement action — always says WHY, what was
 * observed, what it means, and how to appeal. */
function enforcementNotice({ action, reason, durationText = null, untilText = null, limit = null, priorWarning = null, observations = [] }) {
  const def = ENFORCEMENT[action];
  const o = { durationText, untilText, limit };
  const title = typeof def.title === 'function' ? def.title(o) : def.title;
  const means = typeof def.means === 'function' ? def.means(o) : def.means;
  const out = [title, '', 'Why', reason && reason.trim() ? reason.trim() : 'No specific reason was recorded by the administrator.'];
  if (observations.length) out.push('', 'What was observed', ...observations.map((x) => `• ${x}`));
  if (priorWarning) {
    const when = priorWarning.at instanceof Date ? priorWarning.at.toISOString() : String(priorWarning.at); // pg returns a Date
    out.push('', 'Earlier warning', `You were sent a warning on ${when.slice(0, 10)}${priorWarning.summary ? `: ${priorWarning.summary}` : '.'}`);
  }
  out.push('', 'What this means', ...means, '', 'If you think this was a mistake', 'Please reach out \u2014 see 📞 Contact Admin under /help. Include what you were doing so it can be reviewed.');
  return out.join('\n');
}

/** Short ping to the owner when a case reaches review (HTML). */
function ownerAlert({ caseRow, user, summary }) {
  const handle = user && user.telegram_username ? `@${esc(user.telegram_username)}` : `<code>${caseRow.telegram_id}</code>`;
  const top = ((summary && summary.reasons) || [])[0];
  return `🧾 <b>Warden: case #${caseRow.id} is ready for review</b>\n\n${handle} · risk ${Math.round(caseRow.risk)}/100 · confidence ${esc(summary.confidenceLabel || '')}\n${top ? `• ${esc(top)}\n` : ''}\nNothing has been done to the account. Open the case to decide.`;
}

module.exports = { ownerCard, userNotice, enforcementNotice, ownerAlert, observationsFor, INTERPRETATION, esc };

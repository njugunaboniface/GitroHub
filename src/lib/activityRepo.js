/**
 * Works out WHICH repo an Activity Log line is about (v1.2.3-multi), for the rollup's
 * "N repos touched". The old rule — "the last token after an arrow" — mistook
 * "(repo)" in "Edited file → path (repo)", "Public)" in "Visibility changed → repo
 * (Private→Public)" and "(mit)" in "License updated → repo (mit)" for repos, so the same
 * repo was counted under several spellings and non-repos were counted at all.
 *
 * Returns the repo name, or null when the line isn't about one of the person's repos.
 */
const NAME = '[A-Za-z0-9._-]+';

// Lines whose text after the arrow is NOT one of the person's repos.
const NOT_A_REPO = /^(Bulk |Undid bulk|Settings imported|Weekly auto-backup|Auto-backup run|Downloaded external repo|Disconnected|Connected)/;

function deriveRepoName(summary) {
  const text = String(summary || '').trim();
  if (!text.includes('→') || NOT_A_REPO.test(text)) return null;

  // "Edited file → src/app.js (my-repo)" / "Deleted file → docs/a.md (my-repo)": the repo is in the parentheses.
  let m = text.match(new RegExp(`^(?:Edited|Deleted) file → .+ \\((${NAME})\\)\\s*$`));
  if (m) return m[1];

  // "Renamed → old → new": the repo is now called `new`.
  m = text.match(new RegExp(`^Renamed → .+ → (${NAME})\\s*$`));
  if (m) return m[1];

  // "Forked → owner/repo": the fork lands in the person's account under the repo's own name.
  m = text.match(new RegExp(`^Forked → ${NAME}/(${NAME})\\s*$`));
  if (m) return m[1];

  // Everything else: the first name after the first arrow, as long as it is followed by the end of
  // the line, " (", or " —" ("Created repo → x", "Visibility changed → x (Private→Public)",
  // "Deleted repo → x — backed up to ..."). Anything else after it means it wasn't a repo name.
  m = text.match(new RegExp(`→\\s*(${NAME})(?=\\s*$|\\s+\\(|\\s+—)`));
  return m ? m[1] : null;
}

module.exports = { deriveRepoName };

-- GitroHub database schema
-- Run automatically on boot by src/db/migrate.js (safe to re-run, uses IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS users (
  telegram_id         BIGINT PRIMARY KEY,
  github_username     TEXT,
  github_token_enc    TEXT,          -- AES-256-GCM encrypted access token
  github_scope        TEXT,
  connected_at        TIMESTAMPTZ,
  disconnected_at     TIMESTAMPTZ,

  -- Notification preferences (per design: Settings -> Notifications submenu)
  notif_github_activity BOOLEAN NOT NULL DEFAULT TRUE,
  notif_system_alerts   BOOLEAN NOT NULL DEFAULT TRUE,
  notif_long_ops        BOOLEAN NOT NULL DEFAULT TRUE,
  notif_token_health     BOOLEAN NOT NULL DEFAULT TRUE,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  icon          TEXT NOT NULL,        -- e.g. '⬆️', '➕', '⚠️'
  summary       TEXT NOT NULL,        -- e.g. "Uploaded 4 files → weather-app"
  detail        TEXT,                 -- optional expanded detail / error stack
  is_error      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_telegram_id_created
  ON activity_log (telegram_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_log_errors
  ON activity_log (telegram_id, is_error, created_at DESC);

-- ── My Defaults, Storage & Access ───────────────────────────────

-- My Defaults, Storage & Data auto-cleanup, Access Log alerts
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_commit_message TEXT NOT NULL DEFAULT 'Update via GitroHub';
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_upload_path TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_sort TEXT NOT NULL DEFAULT 'updated';
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_filter TEXT NOT NULL DEFAULT 'all';
ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_suggest_defaults BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_retention_days INT NOT NULL DEFAULT 90;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_cleanup_on_delete BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_on_new_connection BOOLEAN NOT NULL DEFAULT TRUE;

-- Pinned repos, with a manual order for the reorder feature
CREATE TABLE IF NOT EXISTS pinned_repos (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  repo_name     TEXT NOT NULL,
  position      INT NOT NULL,
  pinned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, repo_name)
);
CREATE INDEX IF NOT EXISTS idx_pinned_repos_user ON pinned_repos (telegram_id, position);

-- Tags (user-defined labels) and their assignment to repos
CREATE TABLE IF NOT EXISTS tags (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  name          TEXT NOT NULL,
  emoji         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, name)
);

CREATE TABLE IF NOT EXISTS repo_tags (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  repo_name     TEXT NOT NULL,
  tag_id        BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE (telegram_id, repo_name, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_repo_tags_lookup ON repo_tags (telegram_id, repo_name);

-- Per-repo "last upload path used" memory, feeds Upload Here's smart default
CREATE TABLE IF NOT EXISTS repo_path_memory (
  telegram_id   BIGINT NOT NULL,
  repo_name     TEXT NOT NULL,
  last_path     TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, repo_name)
);

-- Security-focused connection history, separate from the general Activity Log
CREATE TABLE IF NOT EXISTS access_log (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  event         TEXT NOT NULL, -- 'connected' | 'reconnected' | 'disconnected' | 'token_rejected'
  detail        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_log_user ON access_log (telegram_id, created_at DESC);

-- ── Search History & Size Snapshots ─────────────────────────────

-- Search history — last few searches per user, shown as quick-tap suggestions
CREATE TABLE IF NOT EXISTS search_history (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  query         TEXT NOT NULL,
  searched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history (telegram_id, searched_at DESC);

-- One row per (user, total-account size) snapshot — feeds the Stats screen's
-- size trend ("grew by X this week"). Only ever keeps the single most recent
-- prior snapshot; overwritten each time Stats actually shows a trend line.
CREATE TABLE IF NOT EXISTS size_snapshots (
  telegram_id     BIGINT PRIMARY KEY,
  total_bytes     BIGINT NOT NULL,
  snapshotted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Recently Viewed ──────────────────────────────────────────────

-- Recently viewed repos — quick-tap shortcuts back to whatever you actually
-- opened recently, same shape as search_history.
CREATE TABLE IF NOT EXISTS recently_viewed (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  repo_name     TEXT NOT NULL,
  viewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recently_viewed_user ON recently_viewed (telegram_id, viewed_at DESC);

-- Per-repo notification mute — keeps GitHub Activity notifications on
-- globally (Settings) while silencing one specific noisy repo.
CREATE TABLE IF NOT EXISTS notification_mutes (
  telegram_id   BIGINT NOT NULL,
  repo_name     TEXT NOT NULL,
  muted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, repo_name)
);

-- Tracks which repos have a live GitHub webhook pointed at this bot, plus
-- the id GitHub assigned it (needed to delete it again on disconnect/mute)
-- and the per-webhook secret used to verify incoming payloads.
CREATE TABLE IF NOT EXISTS repo_webhooks (
  telegram_id   BIGINT NOT NULL,
  repo_name     TEXT NOT NULL,
  webhook_id    BIGINT NOT NULL,
  secret        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, repo_name)
);

-- ── Nested Tags & Auto-Rules ─────────────────────────────────────

-- Nested tags (self-reference; NULL parent = top-level) + color class for
-- chip rendering. Existing rows get parent_id=NULL, color_class='default'.
ALTER TABLE tags ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES tags(id) ON DELETE SET NULL;

-- v1.2.3-multi: deleting a parent tag must not silently delete its sub-tags (and every
-- repo assignment they carry). Older databases were created with ON DELETE CASCADE;
-- convert that constraint once so sub-tags move up to the top level instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_name = 'tags_parent_id_fkey' AND delete_rule = 'CASCADE'
  ) THEN
    ALTER TABLE tags DROP CONSTRAINT tags_parent_id_fkey;
    ALTER TABLE tags ADD CONSTRAINT tags_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE SET NULL;
  END IF;
END $$;
ALTER TABLE tags ADD COLUMN IF NOT EXISTS color_class TEXT NOT NULL DEFAULT 'default';
ALTER TABLE tags ADD COLUMN IF NOT EXISTS auto_rule_json TEXT; -- {"field":"language","op":"eq","value":"Python"} — NULL = manual tag

-- Per-tag default overrides (visibility, upload_path, commit_message).
-- Resolution order: repo's tag override -> global user default.
CREATE TABLE IF NOT EXISTS tag_defaults (
  tag_id        BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  key           TEXT NOT NULL, -- 'default_visibility' | 'default_upload_path' | 'default_commit_message'
  value         TEXT NOT NULL,
  PRIMARY KEY (tag_id, key)
);

-- Pin sections — optional named grouping, NULL = ungrouped ("Pinned").
ALTER TABLE pinned_repos ADD COLUMN IF NOT EXISTS pin_section TEXT;

-- Saved views ("smart folders") — reuses the same filter-clause JSON shape
-- as Bulk Actions' composable filter builder (see lib/filterClauses.js).
CREATE TABLE IF NOT EXISTS saved_views (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  name          TEXT NOT NULL,
  filter_json   TEXT NOT NULL,
  position      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, name)
);

-- Every settings/defaults change, old -> new, for the defaults audit trail.
CREATE TABLE IF NOT EXISTS defaults_changelog (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  source        TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'learned-suggestion'
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_defaults_changelog_user ON defaults_changelog (telegram_id, changed_at DESC);

-- Reversible bulk-action undo ledger. Scoped to actions that are safely
-- reversible (visibility, tag assign, archive, pin) — never delete/rename.
CREATE TABLE IF NOT EXISTS bulk_action_log (
  id                BIGSERIAL PRIMARY KEY,
  telegram_id       BIGINT NOT NULL,
  action_type       TEXT NOT NULL,
  repo_names        TEXT NOT NULL, -- JSON array
  previous_state    TEXT NOT NULL, -- JSON, shape depends on action_type
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  undone_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bulk_action_log_user ON bulk_action_log (telegram_id, created_at DESC);

-- Upload path frequency, feeds "learned defaults" suggestions.
CREATE TABLE IF NOT EXISTS upload_path_frequency (
  telegram_id   BIGINT NOT NULL,
  path          TEXT NOT NULL,
  count         INT NOT NULL DEFAULT 1,
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, path)
);

-- Rolling size history (size_snapshots stays as the fast "latest" lookup).
CREATE TABLE IF NOT EXISTS size_snapshot_history (
  id                BIGSERIAL PRIMARY KEY,
  telegram_id       BIGINT NOT NULL,
  total_bytes       BIGINT NOT NULL,
  snapshotted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_size_snapshot_history_user ON size_snapshot_history (telegram_id, snapshotted_at DESC);

-- Access Log anomaly flags.
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS is_anomalous BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS anomaly_reason TEXT;

-- v1.0.0-multi — partial index: lib/users.js's 🚩 Suspicious filter and
-- listUsers()'s per-row has_anomaly lookup both do an EXISTS/IN check
-- against is_anomalous = TRUE specifically, on every page of every
-- filter, not just the 'suspicious' one. A partial index on just the
-- flagged rows keeps that cheap as access_log grows, instead of a full
-- index (or scan) across every connect/disconnect/token_rejected row
-- most of which will never be anomalous.
CREATE INDEX IF NOT EXISTS idx_access_log_anomalous ON access_log (telegram_id) WHERE is_anomalous = TRUE;

-- New notification prefs: daily/weekly rollup opt-in + quiet hours window.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_rollup TEXT NOT NULL DEFAULT 'off'; -- 'off' | 'daily' | 'weekly'
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_hours_start INT; -- 0-23, NULL = disabled
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_hours_end INT;  -- 0-23

-- Commit message template placeholders live on the existing
-- default_commit_message column itself (e.g. "Update {filename} — {date}"),
-- expanded at commit time — no schema change needed for that piece.

-- ── Automation ───────────────────────────────────────────────────

-- Marks an activity_log row as something GitroHub did on its own (auto-tag
-- rules, applied suggestions) rather than something the person tapped
-- directly — feeds the Automation Log's separate, filtered view.
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS is_automated BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_activity_log_automated ON activity_log (telegram_id, is_automated, created_at DESC);

-- 🔕 Auto-Mute Rules — same condition shape as tags' auto_rule_json
-- (field/op/value, see lib/ruleEngine.js) but not tied to a tag: these
-- mute Live Alert notifications for any repo that already has alerts
-- enabled and matches. A user can have several active at once.
CREATE TABLE IF NOT EXISTS automation_mute_rules (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  field TEXT NOT NULL,
  op TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_mute_rules_user ON automation_mute_rules (telegram_id);

-- 💾 Auto-Backup Rules — same shape as mute rules, but matching repos get a
-- weekly zip snapshot delivered as a Telegram document (weekly scheduler in
-- index.js), or on demand via "▶️ Backup Now".
CREATE TABLE IF NOT EXISTS automation_backup_rules (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  field TEXT NOT NULL,
  op TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_backup_rules_user ON automation_backup_rules (telegram_id);

-- Weekly stale-repo nudge — opt-in, off by default. Unlike the always-available
-- passive 🗂️ Stale Repos screen, this is a proactive push the person has to
-- turn on themselves (Notifications menu).
ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_stale_nudge BOOLEAN NOT NULL DEFAULT FALSE;

-- 🌍 Timezone — IANA zone name (e.g. 'America/New_York'), used to interpret
-- and display Scheduled Commits times in the person's own local time
-- instead of raw UTC. Defaults to UTC until they set it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

-- 📅 Scheduled Commits — repo creation (with its initial commit: license/
-- gitignore) deferred to a future time. Checked every few minutes by its
-- own poller in index.js, separate from the hourly automation scheduler,
-- since a schedule implies some timing precision the hourly one doesn't give.
CREATE TABLE IF NOT EXISTS scheduled_repos (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  license TEXT,
  include_readme BOOLEAN NOT NULL DEFAULT TRUE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed | cancelled
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE scheduled_repos ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_scheduled_repos_processing ON scheduled_repos (status, processing_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_repos_due ON scheduled_repos (status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_scheduled_repos_user ON scheduled_repos (telegram_id);

-- 🗑️ Trash retention (days) — configurable in ⚙️ Defaults, used by both the
-- delete-repo backup step and the daily trash-expiry sweep.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trash_retention_days INT NOT NULL DEFAULT 30;

-- 12h vs 24h display preference (My Defaults → 🌍 Timezone). Purely
-- cosmetic — every stored time is still UTC internally either way.
ALTER TABLE users ADD COLUMN IF NOT EXISTS time_format TEXT NOT NULL DEFAULT '24h';

-- Recently Viewed quick-access is on by default — this lets someone turn it
-- off (or clear its history) from My Defaults if they'd rather not have it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recently_viewed_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- 🚫 .gitignore template chosen at repo-creation time, applied when the
-- scheduled repo is actually created (mirrors `license` above — same
-- GitHub API convenience param, just deferred).
ALTER TABLE scheduled_repos ADD COLUMN IF NOT EXISTS gitignore TEXT;

-- 📤 Scheduled Uploads — a deliberately separate queue from 🆕 Scheduled
-- Repos (see automation:scheduleduploads) even though the underlying
-- "defer an action to later" shape is similar — one creates a repo, this
-- one commits/uploads a file into an EXISTING one, and conflating them in
-- one list was confusing enough to be worth two clearly-named screens.
-- The file itself is held as a Telegram file_id (same proven approach as
-- 🗑️ Trash's backup snapshots) and re-downloaded at execution time rather
-- than stored anywhere else.
CREATE TABLE IF NOT EXISTS scheduled_uploads (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  repo_name TEXT NOT NULL,
  target_path TEXT, -- NULL = repo root, same convention as the live upload flow
  commit_message TEXT,
  file_id TEXT, -- NULL for a multi-file (extracted archive) schedule — see scheduled_upload_files
  file_name TEXT, -- NULL for a multi-file schedule; file_count below describes it instead
  file_count INT NOT NULL DEFAULT 1, -- > 1 marks a multi-file schedule (extracted archive) — see scheduled_upload_files
  is_archive BOOLEAN NOT NULL DEFAULT FALSE,
  archive_action TEXT, -- 'extract' | 'asis' | NULL (NULL when is_archive is false)
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed | cancelled
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_scheduled_uploads_processing ON scheduled_uploads (status, processing_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_uploads_due ON scheduled_uploads (status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_scheduled_uploads_user ON scheduled_uploads (telegram_id);

-- Migrating an existing deployment: the CREATE TABLE above is a no-op
-- once the table already exists, so file_id/file_name's original NOT
-- NULL constraints (from before multi-file scheduling existed) need to
-- be relaxed explicitly, and file_count needs to be added explicitly —
-- same reasoning as every other ALTER TABLE ADD COLUMN IF NOT EXISTS in
-- this file, just for a constraint change instead of a new column.
ALTER TABLE scheduled_uploads ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE scheduled_uploads ALTER COLUMN file_name DROP NOT NULL;
ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS file_count INT NOT NULL DEFAULT 1;

-- 📦 Scheduled multi-file uploads (extracted zip/tar contents) — one row
-- per file, holding its actual bytes directly rather than a reference to
-- re-fetch later. Deliberately NOT the same "re-download from Telegram
-- at execution time" pattern scheduled_uploads.file_id uses for a single
-- file: that re-derives ONE already-known-good blob; re-parsing an
-- entire archive again in a background poller, possibly hours or days
-- later, would double the extraction-bug surface (password handling,
-- zip-bomb guards, path-stripping logic, all over again) for no real
-- benefit over storing the already-validated, already-extracted bytes
-- once, right when they're already in hand at schedule-creation time.
-- Bounded by the same MAX_ZIP_UNCOMPRESSED_BYTES cap extraction already
-- enforces, so this can't grow unbounded.
CREATE TABLE IF NOT EXISTS scheduled_upload_files (
  id                  BIGSERIAL PRIMARY KEY,
  scheduled_upload_id BIGINT NOT NULL REFERENCES scheduled_uploads(id) ON DELETE CASCADE,
  path                TEXT NOT NULL,
  content             BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_upload_files_parent ON scheduled_upload_files (scheduled_upload_id);

-- 🗑️ Trash — a repo deleted through the bot gets a zip snapshot delivered
-- to the person's own chat before the real GitHub delete happens (its
-- Telegram file_id IS the storage — no blob-storage backend needed here),
-- and can be restored as a new repo until it expires. Telegram file_ids
-- are not a formally-guaranteed-permanent store, but in practice hold up
-- for long periods as long as the message isn't deleted from the chat —
-- the honest caveat for anything with a 30+ day retention window.
CREATE TABLE IF NOT EXISTS trashed_repos (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  original_name TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  backup_file_id TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  restored_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trashed_repos_user ON trashed_repos (telegram_id, restored_at);
CREATE INDEX IF NOT EXISTS idx_trashed_repos_expiry ON trashed_repos (expires_at);

-- expires_at nullable so "Never" retention (0 days = keep indefinitely,
-- see My Defaults' 🗑️ Trash Retention) can store no expiry at all instead
-- of a fake far-future date. Ordered AFTER the CREATE TABLE above —
-- this ALTER used to sit before the table existed at all, which only
-- ever worked because a live database already had the table from an
-- earlier deploy; a genuinely fresh database would have failed here.
ALTER TABLE trashed_repos ALTER COLUMN expires_at DROP NOT NULL;

-- v1.2.3-multi: FALSE when the backup ZIP is bigger than Telegram lets a bot DOWNLOAD
-- (20MB) even though it could be sent (50MB). Such an entry can still be re-sent as a
-- ZIP, but "Restore" is not offered for it — it used to create an empty repo and fail.
ALTER TABLE trashed_repos ADD COLUMN IF NOT EXISTS restorable BOOLEAN NOT NULL DEFAULT TRUE;

-- ── v1.1.0-multi — Open multi-user access + Admin Dashboard ─────────
--
-- GitroHub moved from "one hardcoded owner" to "anyone can /start and
-- connect their own GitHub account freely" — everything below supports
-- that plus the Admin Dashboard's oversight of the resulting user base.
-- ADMIN_ID (see config.js) still names exactly one person, but that
-- person is now a normal user PLUS the only one who sees the 🛡️ Admin
-- button and everything behind it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_first_name TEXT;

-- Set once, automatically, for whoever's telegram_id matches ADMIN_ID —
-- never toggled through any UI, so there's no path for a user to grant
-- themselves admin.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- 🚫 Ban = is_blocked + revoke (per explicit design decision: banning
-- always tears down the GitHub connection too, same teardown path as a
-- self-serve Disconnect — see lib/adminActions.js). blocked_reason is
-- optional free text the admin can attach for their own records.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

-- ⏸️ Suspend = temporary, auto-expiring version of a ban — does NOT
-- revoke the GitHub token, since the whole point is "come back later
-- exactly as you left it." Checked lazily at the access gate (no
-- separate poller needed): the instant `suspended_until` is in the past,
-- the gate clears it and lets the person straight through.
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;

-- ⭐ Trust badge — deliberately non-functional today (grants no extra
-- limits or features by itself). Scaffolding for later tiered features,
-- per the "don't ship half-done" principle: the flag exists and is
-- visible in the Admin Dashboard now, what it unlocks can come later.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_trusted BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-user overrides of the global upload/rate limits in config.js.
-- NULL = "use the global default", never a magic number — this is what
-- lets Settings/Admin tell the difference between "explicitly set to the
-- same number" and "never touched."
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_zip_bytes_override BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_file_bytes_override BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_action_cap_override INT;

-- 🖱️ Click tracking — incremented once per accepted update (message or
-- button tap) in the access-control gate, right after the block/suspend
-- check passes. This is intentionally the ONE counter that touches every
-- single interaction, so it has to stay a cheap single UPDATE — no joins,
-- no extra table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_actions BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_is_blocked ON users (is_blocked);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC);

-- Marks an activity_log row as one that represents an actual GitHub commit
-- (upload, replace, batch upload, scheduled upload/repo-create, edit
-- file, delete file) — standardized here so the Admin Dashboard's
-- per-user "commit count" is a real COUNT(*), not icon-guessing across
-- a dozen different emoji used for a dozen different features.
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS is_commit BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_activity_log_commits ON activity_log (telegram_id, is_commit) WHERE is_commit;

-- Admin action audit trail — every ban/unban/suspend/trust/limit-change/
-- broadcast/export/delete/purge the admin performs, so "what did I do and
-- when" is answerable later without relying on memory. Deliberately its
-- own table rather than reusing activity_log — this is a record of what
-- the ADMIN did, not what a regular user did with their own account.
CREATE TABLE IF NOT EXISTS admin_action_log (
  id                  BIGSERIAL PRIMARY KEY,
  admin_id            BIGINT NOT NULL,
  target_telegram_id  BIGINT,           -- NULL for fleet-wide actions (broadcast, bulk purge)
  action              TEXT NOT NULL,     -- 'ban' | 'unban' | 'suspend' | 'unsuspend' | 'trust' | 'untrust' | 'limit_override' | 'broadcast' | 'export' | 'delete_user' | 'bulk_purge'
  detail              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_created ON admin_action_log (created_at DESC);

-- v1.3.0-multi — 🩺 Maintenance Mode's schedule (lib/maintenance.js) can
-- flip maintenance_enabled on its own, with no human admin behind that
-- particular change — admin_id must allow NULL so that system-initiated
-- audit rows are recorded honestly as "the schedule did this," not
-- misattributed to whichever admin happens to have adminId 0/undefined.
ALTER TABLE admin_action_log ALTER COLUMN admin_id DROP NOT NULL;

-- v1.2.0-multi — live-editable global defaults (upload size caps, hourly
-- action cap) without needing a redeploy. See lib/globalConfig.js — reads
-- are served from a periodically-refreshed in-memory cache, not a DB hit
-- on every single limit check, so this stays cheap on the hot path.
CREATE TABLE IF NOT EXISTS admin_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 📋 Repo template chosen at creation time (see lib/repoTemplates.js) —
-- mirrors gitignore/license above, applied (as a starter-file commit,
-- not a GitHub API param like those two) once the scheduled repo is
-- actually created.
ALTER TABLE scheduled_repos ADD COLUMN IF NOT EXISTS template TEXT;

-- Persisted counter for how many times this person has hit their hourly
-- action cap — feeds the 🚩 Suspicious filter below. Separate from the
-- in-memory sliding window in middleware/accessControl.js (that window
-- resets on restart and only exists to do the actual throttling); this
-- column is the durable "how often has this happened, ever" signal an
-- admin can actually see.
ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_limit_hits INT NOT NULL DEFAULT 0;

-- Powers ILIKE '%query%' searches (lib/adminStats.js's searchUsers) with
-- an actual index instead of a full table scan — fine at small scale
-- without this, but won't stay fine as the user base grows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users USING GIN (telegram_username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_github_username_trgm ON users USING GIN (github_username gin_trgm_ops);

-- 📝 Admin Notes — freeform, admin-only context left on a user's detail
-- card ("known issue, watching", "opened a support thread on Discord").
-- Never shown to the user themselves, never a factor in any automated
-- decision (limits, suspicion flags) — purely handoff context between
-- admins looking at the same account at different times.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- ↩️ Admin Undo — mirrors bulk_action_log's shape/TTL pattern (see
-- lib/bulkUndo.js) but for admin-initiated moderation, not a user's own
-- repo actions. Deliberately narrow: only actions where "previous state"
-- is something we can just write back (ban, suspend, bulk-suspend,
-- bulk-mute) get an entry here. Delete / bulk-purge / bulk-delete-banned
-- are excluded on purpose — deleteUserAndData() actually removes the
-- rows, there is no previous state left to restore, so logging an "undo"
-- for those would be a button that lies about what it can do.
CREATE TABLE IF NOT EXISTS admin_undo_log (
  id                  BIGSERIAL PRIMARY KEY,
  admin_id            BIGINT NOT NULL,
  action_type         TEXT NOT NULL,   -- 'ban' | 'suspend' | 'bulk_suspend' | 'bulk_mute'
  target_ids          TEXT NOT NULL,   -- JSON array of affected telegram_ids
  previous_state      TEXT NOT NULL,   -- JSON: whatever's needed to revert (per-target where it varies)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  undone_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_undo_log_created ON admin_undo_log (created_at DESC);

-- 🚩 User Reports — the one direction moderation never had a channel for:
-- a user flagging a problem TO an admin. Everything else in this system
-- is admin-initiated (ban/suspend/message); this is the only inbound
-- signal that isn't the automated anomaly/suspicious-activity detector.
CREATE TABLE IF NOT EXISTS user_reports (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'dismissed'
  resolved_by   BIGINT,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_reports_status ON user_reports (status, created_at DESC);

-- 📢 Scheduled Broadcasts — doubles as Broadcast History. Every broadcast,
-- immediate or scheduled, gets exactly one row here: an immediate send
-- inserts with send_at = now() and is marked 'sent' within the same
-- request; a scheduled one sits 'pending' until index.js's poller (same
-- 60s cadence as Scheduled Repos/Uploads) picks it up. One table serving
-- both "queue" and "history" — same shape those two features already use,
-- not a new pattern introduced just for this.
CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
  id            BIGSERIAL PRIMARY KEY,
  admin_id      BIGINT NOT NULL,
  text          TEXT NOT NULL,
  entities      TEXT,              -- JSON array of Telegram message entities, or NULL
  send_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed' | 'cancelled'
  sent_count    INT,
  total_count   INT,
  error_message TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE scheduled_broadcasts ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_processing ON scheduled_broadcasts (status, processing_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_due ON scheduled_broadcasts (status, send_at);

-- 👑 Admin Roles — four tiers (guest < moderator < admin < super_admin)
-- WITHIN the existing ADMIN_IDS allowlist (config.js/.env still decides
-- who can reach the Dashboard AT ALL — this table only decides what
-- someone already on that list can DO there). Seeded once at boot from
-- ADMIN_IDS/SUPER_ADMIN_IDS (lib/roles.js's seedFromConfig, idempotent
-- via ON CONFLICT DO NOTHING) so an existing deployment's current admins
-- keep exactly their current access on upgrade — nobody is unexpectedly
-- demoted to guest just because this table didn't exist before.
CREATE TABLE IF NOT EXISTS admin_roles (
  telegram_id BIGINT PRIMARY KEY,
  role        TEXT NOT NULL DEFAULT 'admin', -- 'guest' | 'moderator' | 'admin' | 'super_admin'
  granted_by  BIGINT,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 🚩 Report categories — lets the 🚩 Reports queue be scanned at a
-- glance instead of every row needing to be opened to know what kind of
-- problem it is.
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'; -- 'bug' | 'abuse' | 'other'

-- ⏳ Timed bans — banUser() already existed as permanent-only; this lets
-- a ban expire on its own, same shape Suspend's suspended_until already
-- uses, so a poller (see index.js) can auto-unban exactly the way
-- nothing already auto-lifts a suspension past its timestamp either.
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_until TIMESTAMPTZ;

-- 📧 GitHub email column — REMOVED in v1.1.8 alongside dropping the
-- user:email OAuth scope entirely (lib/oauth.js is back to
-- repo,delete_repo only). This column existed for one release to back
-- the public-email display on the "welcome back" card; that display is
-- gone, so a stale, silently-stopped-updating column serving no purpose
-- has no reason to keep existing — same zero-orphaned-data posture the
-- rest of this schema already holds itself to. Real removal, not a
-- soft-deprecate: DROP, not just "stop writing to it."
ALTER TABLE users DROP COLUMN IF EXISTS github_email;

-- 🧹 v1.1.8 one-time cleanup — closes the group/channel leak fixed in
-- middleware/accessControl.js (that gate previously had no
-- private-chat-only / non-bot-sender check, so any bot that fired an
-- update in a chat this bot happened to be in — e.g. Telegram's own
-- @Channel_Bot posting linked-channel content into a discussion group —
-- got a real `users` row created for it). This DELETE is intentionally
-- narrow and conservative: it only removes rows that are unmistakably
-- inert bot artifacts, never anything that could plausibly be a real
-- person who just has "bot" in their name — never-connected AND at
-- most one recorded click (the single update that created the row)
-- AND a username ending in "bot". Naturally idempotent: after the
-- first run there's nothing left to match, and the new gate stops any
-- more from ever being created, so this is safe to leave running on
-- every boot rather than needing a one-shot flag.
DELETE FROM users
WHERE telegram_username ILIKE '%bot'
  AND connected_at IS NULL
  AND COALESCE(total_actions, 0) <= 1
  AND is_admin = false;

-- ⏸️ Suspend reason — suspendUser() previously had NO reason parameter
-- at all (unlike banUser(), which already had blocked_reason above).
-- Same shape, same nullable-is-fine reasoning: an admin can suspend
-- without typing one, Warden always supplies its own signal-breakdown
-- text here when it acts autonomously.
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- 🔒 Lockdown Mode (Owner-only) — per-admin Dashboard lockout, distinct
-- from is_blocked/suspended_until (those affect the WHOLE bot for a
-- regular user; this affects ONLY Dashboard access for an existing
-- admin, and the admin keeps using the bot as an ordinary user in the
-- meantime — deliberately, so nothing looks obviously different to a
-- possibly-compromised session). dashboard_locked_at doubles as "is it
-- currently locked" (NULL = not locked) and an audit timestamp in one
-- column, same pattern blocked_at already uses above.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_locked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_locked_by BIGINT;

-- 🤖 Warden onboarding nudge tracking — set to now() the moment the
-- nudge fires, so it never repeats. Checked first in warden.js, then
-- the actual send happens only if this is still NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_nudged_at TIMESTAMPTZ;
-- previously view-only: no cancel, no repost, no recurrence at all
-- (status only ever moved pending -> sent/failed, one-shot). via_warden
-- marks a broadcast Warden queued itself (admin_id stays NULL for
-- those, same "system did this" pattern admin_action_log already uses
-- for Maintenance Mode's own schedule). recurrence_type NULL means
-- "one-shot" (the existing, unchanged behavior) — set, the poller
-- recomputes send_at and re-arms instead of finalizing 'sent'.
ALTER TABLE scheduled_broadcasts ALTER COLUMN admin_id DROP NOT NULL;
ALTER TABLE scheduled_broadcasts ADD COLUMN IF NOT EXISTS via_warden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE scheduled_broadcasts ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE scheduled_broadcasts ADD COLUMN IF NOT EXISTS reposted_from_id BIGINT;
ALTER TABLE scheduled_broadcasts ADD COLUMN IF NOT EXISTS recurrence_type TEXT; -- NULL | 'daily' | 'weekly' | 'custom'
ALTER TABLE scheduled_broadcasts ADD COLUMN IF NOT EXISTS recurrence_interval_days INT;
ALTER TABLE scheduled_broadcasts ADD COLUMN IF NOT EXISTS recurrence_end_at TIMESTAMPTZ;
ALTER TABLE scheduled_broadcasts ADD COLUMN IF NOT EXISTS recurrence_fired_count INT NOT NULL DEFAULT 0;

-- 🤖 WARDEN — v1.1.8's autonomous Owner-only moderation subsystem.
-- Deliberately its own tables rather than folding into existing ones:
-- Warden is a first-class subsystem, not a bolted-on toggle, and giving
-- it its own action log/rule set/template library keeps its audit
-- trail cleanly separable from human admin actions even though both
-- ultimately affect the same users.

-- One-row config, same shape as admin_config but kept separate since
-- Warden's settings are structurally different (per-privilege toggles,
-- not arbitrary key/value) and are Owner-only regardless of what
-- admin_config's own access rules ever become.
CREATE TABLE IF NOT EXISTS warden_config (
  id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton row
  enabled             BOOLEAN NOT NULL DEFAULT false,
  dry_run             BOOLEAN NOT NULL DEFAULT true, -- logs "would have done X" without acting until the Owner turns it off
  -- Default-ON privileges (reversible, low-risk):
  allow_auto_mute            BOOLEAN NOT NULL DEFAULT true,
  allow_auto_restrict        BOOLEAN NOT NULL DEFAULT true,
  allow_admin_nudge_broadcast BOOLEAN NOT NULL DEFAULT true,
  allow_onboarding_nudge     BOOLEAN NOT NULL DEFAULT true,
  -- Default-OFF privileges (opt-in):
  allow_auto_suspend         BOOLEAN NOT NULL DEFAULT false,
  allow_auto_timed_ban       BOOLEAN NOT NULL DEFAULT false,
  allow_fleet_broadcast      BOOLEAN NOT NULL DEFAULT false,
  -- Owner-only-unlockable, OFF until the Owner explicitly enables the
  -- unlock itself (two gates: unlocked AND allowed, both required):
  permanent_ban_unlocked     BOOLEAN NOT NULL DEFAULT false,
  permanent_ban_allowed      BOOLEAN NOT NULL DEFAULT false,
  permanent_delete_unlocked  BOOLEAN NOT NULL DEFAULT false,
  permanent_delete_allowed   BOOLEAN NOT NULL DEFAULT false,
  -- Self-throttle / circuit breaker
  max_actions_per_run        INT NOT NULL DEFAULT 25,
  auto_paused_at              TIMESTAMPTZ, -- set by the breaker itself; NULL = not paused
  auto_paused_reason           TEXT,
  cooldown_hours              INT NOT NULL DEFAULT 24, -- won't re-act on the same user within this window
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  BIGINT
);
INSERT INTO warden_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Per-user signal state feeding the escalation ladder — this is what
-- makes Warden's logic a state machine per user rather than a flat
-- "one rule -> one response" system: repeated/compounding signals earn
-- a harsher response than a single one-off would.
CREATE TABLE IF NOT EXISTS warden_user_state (
  telegram_id         BIGINT PRIMARY KEY,
  confidence_score    NUMERIC NOT NULL DEFAULT 0,
  escalation_level    INT NOT NULL DEFAULT 0, -- 0=none, 1=flagged, 2=restricted, 3=suspended
  last_signal_at       TIMESTAMPTZ,
  last_action_at       TIMESTAMPTZ, -- cooldown reference point
  last_action_type      TEXT,
  signal_breakdown       TEXT, -- JSON: {signal: weight} snapshot behind the current score — the "why"
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Warden's own action log — separate from admin_action_log so its
-- volume (it can act far more often than a human) never crowds out the
-- human audit trail, and so its own paginated screen can be purely
-- about it. admin_id is always NULL here by definition (see via_warden
-- above for the same convention on the broadcast side); dry_run marks
-- an entry that was logged-only, never actually applied.
CREATE TABLE IF NOT EXISTS warden_action_log (
  id             BIGSERIAL PRIMARY KEY,
  target_id      BIGINT NOT NULL,
  action_type    TEXT NOT NULL, -- 'flag' | 'mute' | 'restrict' | 'suspend' | 'timed_ban' | 'permanent_ban' | 'permanent_delete' | 'nudge_broadcast' | 'onboarding_nudge' | 'alert_owner'
  reason         TEXT NOT NULL, -- the signal breakdown, human-readable
  dry_run        BOOLEAN NOT NULL DEFAULT false,
  undo_log_id    BIGINT, -- links to admin_undo_log when the action is reversible
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warden_action_log_created ON warden_action_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warden_action_log_target ON warden_action_log (target_id);

-- Pre-written broadcast templates for common scenarios — Warden can
-- fire one verbatim when a matching trigger condition is met, and the
-- Owner can also hand-fire any of these manually from the template list.
CREATE TABLE IF NOT EXISTS warden_broadcast_templates (
  id            BIGSERIAL PRIMARY KEY,
  scenario_key  TEXT NOT NULL UNIQUE, -- 'maintenance_start' | 'maintenance_end' | 'incident' | 'rate_limit_notice' | 'onboarding_nudge' | custom keys
  label         TEXT NOT NULL,
  text          TEXT NOT NULL,
  is_builtin    BOOLEAN NOT NULL DEFAULT false, -- seeded templates vs Owner-authored ones
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═════════════════════════════════════════════════════════════════════════
-- 🧠 Warden Brain (v1.2.0-multi)
-- Warden is an observer/analyst: it collects evidence, builds per-user
-- baselines, correlates and evaluates, records and reports. It has NO
-- enforcement capability — restrict/suspend/ban are owner actions.
-- Counts and metadata only: never repo content, file names or message text.
-- ═════════════════════════════════════════════════════════════════════════

-- One row per user per hour. Written by the in-memory collector
-- (lib/wardenBrain/collector.js), read by the baseline + evidence engines.
CREATE TABLE IF NOT EXISTS warden_activity_buckets (
  telegram_id    BIGINT      NOT NULL,
  bucket_start   TIMESTAMPTZ NOT NULL,
  actions        INT         NOT NULL DEFAULT 0,  -- accepted taps/messages
  errors         INT         NOT NULL DEFAULT 0,  -- failed operations
  repeats        INT         NOT NULL DEFAULT 0,  -- same control hit again within seconds
  cap_hits       INT         NOT NULL DEFAULT 0,  -- updates refused by the hourly cap
  sessions       INT         NOT NULL DEFAULT 0,  -- sessions that STARTED this hour (30 min idle gap)
  active_minutes INT         NOT NULL DEFAULT 0,  -- distinct minutes with at least one action
  max_burst      INT         NOT NULL DEFAULT 0,  -- most actions inside any 60s window
  PRIMARY KEY (telegram_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_warden_buckets_time ON warden_activity_buckets (bucket_start);

-- Per-user Warden state: learned baseline + where the user sits on the
-- progressive ladder (normal → observe → flag → enhanced_monitoring →
-- review_candidate). Promotion needs the higher stage to HOLD (pending_*).
CREATE TABLE IF NOT EXISTS warden_profiles (
  telegram_id         BIGINT PRIMARY KEY,
  baseline            JSONB,
  baseline_updated_at TIMESTAMPTZ,
  stage               TEXT        NOT NULL DEFAULT 'normal',
  stage_since         TIMESTAMPTZ NOT NULL DEFAULT now(),
  pending_stage       TEXT,
  pending_since       TIMESTAMPTZ,
  risk                NUMERIC     NOT NULL DEFAULT 0,
  confidence          NUMERIC     NOT NULL DEFAULT 0,
  snooze_until        TIMESTAMPTZ,              -- owner chose "keep watching"
  dismissed_until     TIMESTAMPTZ,              -- owner dismissed a case: no new case below enhanced until then
  last_eval_at        TIMESTAMPTZ,
  last_decision       JSONB
);

-- Owner Board. One OPEN case per user; new evidence merges into it.
CREATE TABLE IF NOT EXISTS warden_cases (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT      NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'open',   -- open | dismissed | resolved
  stage         TEXT        NOT NULL,
  peak_stage    TEXT        NOT NULL,
  risk          NUMERIC,
  confidence    NUMERIC,
  summary       JSONB,                                  -- latest decision snapshot shown on the card
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  close_reason  TEXT,
  alerted_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_warden_case_open ON warden_cases (telegram_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_warden_cases_status ON warden_cases (status, updated_at DESC);

-- Timeline for a case: stage changes, evidence, owner actions, warnings sent.
CREATE TABLE IF NOT EXISTS warden_case_events (
  id          BIGSERIAL PRIMARY KEY,
  case_id     BIGINT      NOT NULL REFERENCES warden_cases(id) ON DELETE CASCADE,
  telegram_id BIGINT      NOT NULL,
  kind        TEXT        NOT NULL,
  detail      JSONB,
  actor       BIGINT,                                   -- NULL = Warden itself
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warden_case_events_case ON warden_case_events (case_id, created_at);

-- Append-only evidence store. Decay is applied when READ, never by deleting.
CREATE TABLE IF NOT EXISTS warden_evidence (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT      NOT NULL,
  case_id      BIGINT,
  type         TEXT        NOT NULL,
  class        TEXT        NOT NULL,                    -- independence group
  strength     NUMERIC,
  reliability  NUMERIC,
  observed     JSONB,
  baseline     JSONB,
  window_start TIMESTAMPTZ,
  window_end   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warden_evidence_user ON warden_evidence (telegram_id, created_at DESC);

-- 🛡 Repo Shield: owner-controlled protection of a user's repositories from
-- being viewed/downloaded/deleted/changed by other admins.
ALTER TABLE users ADD COLUMN IF NOT EXISTS repos_protected    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS repos_protected_by BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS repos_protected_at TIMESTAMPTZ;

-- Every bulk shield change, so it can be undone (affected = rows that actually changed).
CREATE TABLE IF NOT EXISTS repo_shield_batches (
  id         BIGSERIAL PRIMARY KEY,
  actor      BIGINT      NOT NULL,
  action     TEXT        NOT NULL,                      -- protect | unprotect
  scope      TEXT        NOT NULL,
  affected   BIGINT[]    NOT NULL DEFAULT '{}',
  undone_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Owner gets a message when a case reaches review_candidate (rare by design).
ALTER TABLE warden_config ADD COLUMN IF NOT EXISTS alerts_review BOOLEAN NOT NULL DEFAULT TRUE;

-- ═══ v1.2.1-multi: indexes found missing by the scaling audit ═══════════
-- Retention deletes by age alone; the per-user indexes can't drive that.
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log (created_at);
CREATE INDEX IF NOT EXISTS idx_access_log_created   ON access_log (created_at);
-- Warden's owner-feedback query joins evidence → case; there was no index on case_id.
CREATE INDEX IF NOT EXISTS idx_warden_evidence_case ON warden_evidence (case_id);
CREATE INDEX IF NOT EXISTS idx_warden_cases_closed  ON warden_cases (closed_at) WHERE status <> 'open';
-- Repo Shield / Trusted counts scan users; partial indexes keep them cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_users_repos_protected ON users (telegram_id) WHERE repos_protected;
CREATE INDEX IF NOT EXISTS idx_users_trusted         ON users (telegram_id) WHERE is_trusted;
-- Admin dashboard counters (v1.2.1-multi): a partial index so the recent-error count touches only error rows
-- (the commit counter is already covered by idx_activity_log_commits).
CREATE INDEX IF NOT EXISTS idx_activity_log_error_recent ON activity_log (created_at) WHERE is_error = TRUE;

-- ═══ v1.2.4-multi: several GitHub accounts per Telegram user, organisations, richer alerts ═══
-- users.github_token_enc / github_username / github_scope keep mirroring the ACTIVE account, so every
-- existing code path keeps working unchanged; this table holds ALL of a person's connected accounts.
CREATE TABLE IF NOT EXISTS github_accounts (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT      NOT NULL,
  github_login  TEXT        NOT NULL,
  token_enc     TEXT        NOT NULL,          -- AES-256-GCM, same key as users.github_token_enc
  scope         TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, github_login)
);
CREATE INDEX IF NOT EXISTS idx_github_accounts_user ON github_accounts (telegram_id, last_used_at DESC);

-- One-time backfill: everyone currently connected becomes their own first (active) account.
INSERT INTO github_accounts (telegram_id, github_login, token_enc, scope, added_at)
SELECT telegram_id, github_username, github_token_enc, github_scope, COALESCE(connected_at, now())
FROM users
WHERE github_token_enc IS NOT NULL AND github_username IS NOT NULL
ON CONFLICT (telegram_id, github_login) DO NOTHING;

-- Which owner My Repos is showing: NULL = the personal account, otherwise an organisation login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_owner TEXT;

-- Webhook registrations now remember the repo's OWNER (a person or an organisation) and the GitHub
-- ACCOUNT whose token created them, so alerts route correctly for org repos and for several accounts.
ALTER TABLE repo_webhooks ADD COLUMN IF NOT EXISTS owner_login   TEXT;
ALTER TABLE repo_webhooks ADD COLUMN IF NOT EXISTS account_login TEXT;

-- Which kinds of live alert a person wants (absent row = that event type's default).
CREATE TABLE IF NOT EXISTS alert_event_prefs (
  telegram_id BIGINT  NOT NULL,
  event_key   TEXT    NOT NULL,
  enabled     BOOLEAN NOT NULL,
  PRIMARY KEY (telegram_id, event_key)
);

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- v1.2.5-multi — saved data and background jobs know WHICH GitHub account / owner they belong to.
-- Until now pins, tags, trash entries and scheduled jobs were keyed by repo NAME only, so two
-- accounts (or an account and its organisation) with a same-named repo shared them, and a job
-- scheduled under one account ran with whichever account happened to be active later.
-- NULL = a row written before 1.2.5: it keeps behaving exactly as it did (visible under every owner,
-- jobs run on the active account) until something claims it, so no existing data moves or disappears.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE pinned_repos      ADD COLUMN IF NOT EXISTS owner_login   TEXT;
ALTER TABLE repo_tags         ADD COLUMN IF NOT EXISTS owner_login   TEXT;
ALTER TABLE trashed_repos     ADD COLUMN IF NOT EXISTS owner_login   TEXT;
ALTER TABLE trashed_repos     ADD COLUMN IF NOT EXISTS account_login TEXT;
ALTER TABLE scheduled_repos   ADD COLUMN IF NOT EXISTS account_login TEXT;
ALTER TABLE scheduled_repos   ADD COLUMN IF NOT EXISTS owner_login   TEXT;   -- the ORGANISATION it was scheduled for (NULL = the account's own repos)
ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS account_login TEXT;
ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS owner_login   TEXT;

-- A pin / tag assignment is unique per OWNER now (a NULL owner counts as one shared "legacy" owner).
ALTER TABLE pinned_repos DROP CONSTRAINT IF EXISTS pinned_repos_telegram_id_repo_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pinned_repos_scope
  ON pinned_repos (telegram_id, repo_name, (COALESCE(LOWER(owner_login), '')));
ALTER TABLE repo_tags DROP CONSTRAINT IF EXISTS repo_tags_telegram_id_repo_name_tag_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_repo_tags_scope
  ON repo_tags (telegram_id, repo_name, tag_id, (COALESCE(LOWER(owner_login), '')));

-- Webhooks registered before 1.2.4 have no owner/account. Those could only have been made by the
-- person's FIRST account (multi-account did not exist), so that is what they are stamped with —
-- alerts then keep arriving after the person switches to another account.
UPDATE repo_webhooks rw
   SET owner_login   = COALESCE(rw.owner_login,   fa.github_login),
       account_login = COALESCE(rw.account_login, fa.github_login)
  FROM (SELECT DISTINCT ON (telegram_id) telegram_id, github_login
          FROM github_accounts ORDER BY telegram_id, added_at ASC, id ASC) fa
 WHERE fa.telegram_id = rw.telegram_id
   AND (rw.owner_login IS NULL OR rw.account_login IS NULL);

-- Last time an account's token was checked against GitHub (the all-accounts health sweep), and what
-- it found. 'ok' | 'revoked' | 'unknown'. Lets admins see a dead extra account instead of a ghost.
ALTER TABLE github_accounts ADD COLUMN IF NOT EXISTS health_status     TEXT;
ALTER TABLE github_accounts ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ;

-- ── v1.2.5-multi: change journal ────────────────────────────────────────────────────────────────
-- What GitroHub itself changed in a repo (commits it made, branches/tags it deleted, rollbacks and reverts),
-- so "↩️ Undo" and "♻️ Recover" can offer exactly those — per account, newest first. Holds ids and names only.
CREATE TABLE IF NOT EXISTS change_journal (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  account_login TEXT,
  owner_login   TEXT,
  repo_name     TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- commit | revert | restore | rollback | branch_delete | tag_delete
  ref_name      TEXT,                   -- branch or tag the change was on
  sha           TEXT,                   -- commit made / ref's new value
  prev_sha      TEXT,                   -- what the ref pointed at before (deleted ref, rolled-back branch)
  label         TEXT NOT NULL DEFAULT '',
  undone_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_change_journal_user_repo ON change_journal (telegram_id, repo_name, created_at DESC);

-- ── v1.2.5-multi: small per-person switches (which "needs you" counts show, daily digest on/off, …) ──
CREATE TABLE IF NOT EXISTS user_prefs (
  telegram_id BIGINT NOT NULL,
  pref_key    TEXT   NOT NULL,
  pref_value  TEXT   NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, pref_key)
);

-- ── v1.2.5-multi: Warden Watch (tiered monitoring) ──────────────────────────────────────────────
-- Sensitive actions people take (transfer, rollback, access changes, deletes…) with a risk score. Names and
-- ids only — never a token, secret or file content.
CREATE TABLE IF NOT EXISTS sensitive_actions (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  account_login TEXT,
  owner_login   TEXT,
  action        TEXT NOT NULL,
  repo_name     TEXT,
  detail        TEXT,
  score         INT  NOT NULL DEFAULT 0,
  flagged       BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by   BIGINT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensitive_user ON sensitive_actions (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sensitive_flagged ON sensitive_actions (flagged, created_at DESC);

-- Every ⚡ Manage / 💼 Workspace tap, so the owner can see who did what under which account.
CREATE TABLE IF NOT EXISTS manage_audit (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  account_login TEXT,
  area          TEXT NOT NULL,
  action        TEXT NOT NULL,
  repo_name     TEXT,
  is_change     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manage_audit_time ON manage_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manage_audit_user ON manage_audit (telegram_id, created_at DESC);

-- An admin can pause ONE feature area for ONE person (without touching anyone else).
CREATE TABLE IF NOT EXISTS user_feature_pauses (
  telegram_id BIGINT NOT NULL,
  feature_key TEXT   NOT NULL,
  paused_by   BIGINT NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  PRIMARY KEY (telegram_id, feature_key)
);

-- Optional owner confirmation for the riskiest actions.
CREATE TABLE IF NOT EXISTS sensitive_approvals (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  action      TEXT   NOT NULL,
  repo_name   TEXT,
  status      TEXT   NOT NULL DEFAULT 'pending',   -- pending | approved | denied
  decided_by  BIGINT,
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensitive_approvals_status ON sensitive_approvals (status, created_at DESC);

-- ── v1.3.0-multi: soft-delete (🧯 Restore center) ───────────────────────────────────────────────
-- Small things a person deletes (a tag with its defaults and repo assignments, a pin, a saved view, an
-- automation rule, a cancelled schedule) are kept here for 30 days so the Restore center can put them back.
-- `payload` holds just enough to re-create the thing (names and settings — never tokens or file contents).
CREATE TABLE IF NOT EXISTS soft_deleted (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL,
  kind         TEXT   NOT NULL,                  -- tag | pin | view | rule | schedule
  label        TEXT   NOT NULL DEFAULT '',
  payload      JSONB  NOT NULL DEFAULT '{}'::jsonb,
  owner_login  TEXT,                             -- NULL = per-person (visible under every owner)
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  restored_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_soft_deleted_user ON soft_deleted (telegram_id, restored_at, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_soft_deleted_expiry ON soft_deleted (expires_at);

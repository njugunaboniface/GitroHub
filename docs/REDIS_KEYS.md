<div align="center">

# 🔑 Redis key inventory

**GitroHub v2.3.3-multi** · [← README](../README.md) · [Scaling](./SCALING.md)

</div>

Everything GitroHub keeps in Redis is short-lived or explicitly capped. Recommended server setting: `maxmemory-policy volatile-lru`. `redis_keys` and `redis_used_memory_bytes` are exported on `/metrics` (sampled once a minute).

| Key pattern | Written by | Purpose | Lifetime | Size | Cleanup |
|---|---|---|---|---|---|
| `tg-session:<chat>:<user>` | `middleware/redisSessionStore` | Telegraf session / wizard state | `SESSION_TTL_SECONDS` (24 h, editable in Global Config) | small JSON | TTL; deleted on account removal |
| `cbref:<id>` | `lib/callbackRefs` | long callback data → value (Telegram's 64-byte limit); `<id>` is a content hash | 30 days | < 1 KB | TTL |
| `filebuf:<id>` | `lib/fileBufferCache` | file bytes awaiting an upload commit (base64) | 30 min (`WIZARD_SESSION_TTL_SECONDS`) | ≤ ~20 MB each; **budget `FILEBUF_REDIS_BUDGET_MB` (256)** | TTL + explicit release |
| `oauth-state-used:<jti>` | `lib/oauth` | one-time OAuth state (replay protection) | state TTL + 60 s | tiny | TTL |
| `poller-lease:<name>` | `lib/pollerLease` | scheduler leader lease (renewed while running) | lease TTL | tiny | TTL |
| `<sha256>` of `gitrohub:confirm-claim:<chat>:<msg>` | `lib/confirmFlow` | one-shot claim on a confirmation message (stops double confirms) | 30 s | tiny | TTL |
| `automation-prune:<date>` · `automation-weekly:<user>:<date>` · `rollup-sent:<user>:<date>:<mode>` | `index.js` | once-per-day / once-per-week job markers | ~25 h | tiny | TTL |
| `webhook-buffer:<user>:<repo>` | `lib/webhookDigest` | pending live-alert events | up to 3 days (`WEBHOOK_BUFFER_TTL_SECONDS`); **list capped at 200** (`WEBHOOK_MAX_BUFFERED_EVENTS`) | ≤ 200 entries | `LTRIM` + TTL |
| `webhook-dropped:<user>:<repo>` | `lib/webhookDigest` | count of events that could not be shown ("+N more") | same as the buffer | one integer | decremented when a digest reports it; TTL |
| `webhook-digest-due:<user>:<repo>` | `lib/webhookDigest` | when the next digest is due | *no TTL* — removed when its digest is delivered (or found empty) | tiny | the digest poller |
| `webhook-digest-lock:<user>:<repo>` | `lib/webhookDigest` | claim while a digest is being sent | lock TTL | tiny | TTL / release |
| `webhook-delivery:<id>` | webhook route (`lib/webhookGuard`) | duplicate-delivery suppression (removed again if a delivery is rate-limited or shed, so GitHub's *Redeliver* works) | 1 h | tiny | TTL |
| `report-cooldown:<user>` | `handlers/reports` | one report per minute | 60 s | tiny | TTL |
| `sens-notified:<id>` | `lib/sensitiveActions` | one admin alert per flagged action | 10 min | tiny | TTL |
| `ownerweb:link:<sha256>` | `lib/ownerWeb` | single-use sign-in link for the owner web panel (the token itself is never stored, only its hash) | 2 min | tiny | TTL; deleted when used |
| `ownerweb:index` | `lib/ownerWeb` | list of live owner web panel sessions (device, masked address, time) for the Sessions page; entries whose session expired are dropped when it is read | 12 h (refreshed on change) | tiny | TTL; pruned on read |
| `ownerweb:sess:<sha256>` | `lib/ownerWeb` | owner web panel session (owner id, CSRF token, "fresh until") | 12 h | tiny | TTL; deleted on sign-out |
| `sens-ok:<id>:<action>:<repo>` | `lib/sensitiveActions` | one-time Owner approval of a held action | 15 min | tiny | TTL; consumed on use |

> [!NOTE]
> `webhook-digest-due:*` is the one key without a TTL. It is not unbounded: it exists only while a digest is pending, and the 30-second poller deletes it as soon as the digest is delivered or its buffer turns out to be empty.

## 🔎 Handy checks
```
redis-cli --scan --pattern 'webhook-*' | head      # what live alerts are holding
redis-cli ttl 'tg-session:123:123'                 # a session's remaining life
redis-cli info memory | grep used_memory_human     # overall footprint
```

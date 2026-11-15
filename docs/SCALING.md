<div align="center">

# 📈 Scaling & process-local state

**GitroHub v2.3.3-multi** · [← README](../README.md) · [Load testing](./LOAD_TESTING.md) · [Redis keys](./REDIS_KEYS.md)

</div>

> [!IMPORTANT]
> GitroHub is **one bot replica**. This page records *why*, what is safe to leave in process memory, and what would have to move to shared storage before a second replica is added. Nothing here has been load-tested against a real multi-replica deployment.

## 🧭 The short version

| Question | Answer |
|---|---|
| Can I run two replicas today? | **No.** Several guards are per-process (below). Two replicas would multiply them. |
| Can one replica serve many people? | Yes — see [LOAD_TESTING.md](./LOAD_TESTING.md) for what was and wasn't measured. |
| What is already shared? | Scheduler leases, OAuth one-time state, callback references, sessions, webhook buffers and delivery-id dedupe live in **Redis**. |

## 🗂️ Classification of process-local state

### A · Safe to stay process-local

| State | Where | Why it's fine |
|---|---|---|
| Per-user update serialization | `lib/userSerializer.js` (wired in `bot.js`) | Correct only if one process sees all of a person's updates — see B. |
| Rapid duplicate-tap guard | `lib/rapidTap.js` | A 1.2-second, size-bounded map keyed by user + message + button. Same one-process assumption as the serializer it sits in front of. |
| Event-loop / CPU / memory sampling, metrics registry | `lib/runtimeMetrics.js`, `lib/metrics.js` | Per-process by definition. |
| Request context | `lib/requestContext.js` (`AsyncLocalStorage`) | Per-process by definition. |

### B · Must become shared before a second replica

| State | Today | Needed |
|---|---|---|
| Update serialization | in-memory queue per user | sticky routing by Telegram user id, **or** a Redis lock per user |
| Hourly action cap, `actionLock` | in-memory windows | Redis counters / locks |
| **GitHub traffic limits** | `GITHUB_MAX_CONCURRENCY` is *per process* — two replicas at 20 = 40 concurrent | a Redis-backed token bucket + per-identity lease with TTL. The manager keeps all limiter, lane and breaker state behind one class so it can be swapped. |
| Resource gates | `lib/gate.js` (archive, download, upload, bulk) | same per-process caveat |
| Webhook rate window and limiter | `lib/webhookGuard.js` | the *dedupe* is already Redis-backed (`SET NX EX`); the rate window and limiter are local |

### C · Needs redesign
- `fileBufferCache`: the L1 (memory) tier is local; the L2 (Redis) tier is shared and works across replicas (read-through). Budgets are tracked per process, so total Redis use is bounded by `replicas × FILEBUF_REDIS_BUDGET_MB` and by the 30-minute TTL.

### D · Bounded caches — safe, with documented limits
Octokit client cache (50 tokens) · repo / language / tree-stats / username caches (LRU `BoundedMap`, TTL-swept; `REPO_CACHE_MAX_USERS`) · git tree ETag cache (bounded by total entries; `TREE_CACHE_MAX_ENTRIES`) · per-user action windows and view state (LRU) · `callbackRefs` memory fallback (Redis is primary) · GitHub conditional-request cache (`GITHUB_CACHE_MAX_ENTRIES`) · traffic lanes (reaped when idle, hard cap 5000) · webhook deduper LRU (2000) · webhook rate window (5000 keys) · rapid-tap guard (5000 entries).

## ✅ What already works across replicas
Scheduler leases (`lib/pollerLease.js`, renewed while a run is in progress) · scheduled-job *claims* (rows flip to `processing` in one statement, so two pollers can't both run the same job) · OAuth one-time state · callback references · sessions · webhook digest buffers, drop counters and delivery-id dedupe.

## 🚫 Do not scale by adding replicas yet
Adding replicas multiplies every item in **B**. First move those to Redis, then re-run `npm run load-test` and the failure tests against a staging deployment.

## 🔧 Tuning one replica
All knobs are environment variables — see [`.env.example`](../.env.example), sections 5–8. The ones that matter first:

| Symptom | Look at |
|---|---|
| "busy" / `GITHUB_QUEUE_FULL` replies under load | `GITHUB_MAX_CONCURRENCY`, `GITHUB_MAX_QUEUE_SIZE` — raise only after watching `github_secondary_limit_events` |
| Slow replies, `/health` says degraded with pool waiters | `PG_POOL_MAX` (default 3) |
| Process restarts near its memory ceiling | `MEMORY_WATCHDOG_MB`, `NODE_OPTIONS=--max-old-space-size`, `FILEBUF_MAX_MEMORY_MB` |
| Warden not looking at everyone | `WARDEN_MAX_USERS` (least recently evaluated first) |

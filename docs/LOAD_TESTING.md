<div align="center">

# 🧪 Load testing

**GitroHub v2.3.3-multi** · [← README](../README.md) · [Scaling](./SCALING.md)

</div>

`npm run load-test` drives the **real** `src/lib/github.js` and traffic manager against a fake GitHub that models secondary limits (403 + `Retry-After` when one token has more than 12 requests in flight, or more than 60 overall), a log-normal latency tail and occasional 502s. Each virtual user has their own token and runs a realistic mix: browse repos, open a repo, languages, browse files, read, edit, create a repo.

## ▶️ Running it
```bash
node scripts/load-test.js                              # 10 25 50 100 250 500 1000 users
node scripts/load-test.js --baseline 50 250            # + the same run WITHOUT the traffic layer
node scripts/load-test.js --baseline-all               # run the unmanaged baseline for every step, not only ≤ 250
node scripts/load-test.js --burst --baseline 5 10 25 50   # every user fires 30 requests at once
LOAD_THINK_MS=40 node scripts/load-test.js 250         # stress: users hammer the bot
```

### Knobs

| Variable / flag | Default | Meaning |
|---|---:|---|
| `LOAD_LATENCY_MS` | 60 | median latency of the fake GitHub |
| `LOAD_TIME_SCALE` | 1 | multiplier on that latency (>1 = a slower GitHub) |
| `LOAD_PER_TOKEN_LIMIT` | 12 | concurrent requests one token may have before the fake GitHub objects |
| `LOAD_GLOBAL_LIMIT` | 60 | concurrent requests overall before it objects |
| `LOAD_OPS_PER_USER` | 8 | operations each virtual user performs |
| `LOAD_THINK_MS` | 1500 | pause between a user's actions |
| `LOAD_BURST_FANOUT` | 30 | requests one user fires at once in `--burst` mode |
| `--baseline`, `--baseline-all`, `--burst` | — | see above |

## ⚠️ What this does and does NOT measure
Measured: the traffic layer, queueing, fairness, retries, event-loop lag and memory of the bot's own process — in-process, against a *model* of GitHub.

**Not measured** (not available in the build sandbox): real GitHub latency and limits, Postgres, Redis, Telegram, or a Railway container. Do not quote any number below as "GitroHub supports N users" — run the same script against a staging deployment with real services before drawing that conclusion.

> [!NOTE]
> The tables below were recorded on v1.2.1-multi. The request path they exercise (traffic manager, gates, `github.js`) has not changed since, so they still apply to v1.2.3; the defaults they quote (`GITHUB_MAX_CONCURRENCY=20`, queue 500, per-user queue 60, bulk gate 3) match `src/` today.

## 📊 Results — realistic users (≈1.5 s between actions), default config
```
GitHub model: median 60ms, GitHub objects above 12 in-flight per token or 60 overall; 8 ops/user, think ≈1500ms

MANAGED (traffic layer on)
users   ops  fail  ops/s  p50ms  p95ms  p99ms  qwait  gh req/s  peak gh  peak/tok  2ndry@GH  retry  shed  unkn  loop p99  RSS MB
   10    80     0      5     77    229    288      0         6        4         1         0      0     0     0      11.1      60
   25   200     0     11     64    182    645      3        12        7         1         0      2     0     0      10.9      63
   50   400     0     23     66    196    315      1        25        9         1         0      0     0     0      11.1      71
  100   800     0     42     65    194    260      1        46       12         1         0      1     0     0      11.1      90
  250  2000     0    104     67    201    304      2       117       20         1         0      6     0     0      11.1      94
  500  4000     0    178    282   1278   1980    149       199       20         1         0     12     0     0      12.3     103
 1000  8000  1142    243   1111   4569   6019    784       236       20         1         0     19  1142     0      14.0     125
  errors at 1000 users: GITHUB_QUEUE_FULL×1142

UNMANAGED baseline (no traffic layer; same fake GitHub)
users   ops  fail  ops/s  p50ms  p95ms  p99ms  qwait  gh req/s  peak gh  peak/tok  2ndry@GH  retry  shed  unkn  loop p99  RSS MB
   10    80     0      5     63    210    271    784         6        4         1         0      0     0     0      11.0     125
   25   200     0     12     65    213    255    784        13        5         1         0      0     0     0      11.1     125
   50   400     1     24     66    181    349    784        27        7         1         0      0     0     0      11.1     125
  100   800     2     44     69    191    299    784        50       14         1         0      0     0     0      11.0     125
  250  2000     6    108     67    194    256    784       123       27         1         0      0     0     0      12.4     125
```
Reading it:
- Up to 250 simultaneous active users: **0 failures**, p50 ≈ 67 ms (the modelled
  GitHub latency), queue wait ≈ 1–3 ms, peak in-flight GitHub requests 20 (the
  configured ceiling, far below GitHub's 100), ≤1 per token, event-loop lag p99 ≈ 11 ms
  (the sampling resolution floor), RSS ≈ 95 MB.
- The unmanaged baseline shows ~0.3 % failures (the injected 502s, which nothing
  retried); with the layer on they were retried and users saw none.
- **Bottleneck found:** at 500–1000 users the offered load (~330–660 ops/s) exceeds
  what `GITHUB_MAX_CONCURRENCY=20` allows (~240 req/s at 60 ms median). At 500 the
  queue absorbs it (p95 1.3 s); at 1000 the bounded queue (500) fills and
  **1142 of 8000 operations (14 %) were refused with `GITHUB_QUEUE_FULL`** — a
  truthful "busy, nothing was changed" rather than a crash or a hung chat.
  Memory stayed at ≈125 MB. That ceiling is a *configuration choice*, not a code
  limit; raising `GITHUB_MAX_CONCURRENCY` is only appropriate after watching
  `github_secondary_limit_events` against real GitHub.
- The "unmanaged" columns for queue wait and RSS are not comparable (same process).

## 💥 Results — burst (every user fires 30 requests at once, as a bulk action / big upload does)
```
GitHub model: median 60ms, GitHub objects above 12 in-flight per token or 60 overall; 8 ops/user, think ≈1500ms

MANAGED (traffic layer on) — BURST: every user fires 30 requests at once
users   ops  fail  ops/s  p50ms  p95ms  p99ms  qwait  gh req/s  peak gh  peak/tok  2ndry@GH  retry  shed  unkn  loop p99  RSS MB
    5   150     0    248    546    586    586    200       248       20         6         0      0     0     0      11.1      57
   10   300     0    258   1005   1130   1130    376       258       20         6         0      0     0     0      11.0      67
   25   750   230    374   1801   1948   1965    650       259       20         6         0      1   230     0      11.5      80
   50  1500   980    642     57   1996   2338    734       222       20         6         0      3   980     0      11.0      97
  errors at 50 users: GITHUB_QUEUE_FULL×980

UNMANAGED baseline (no traffic layer; same fake GitHub; RSS is not comparable — same process) — BURST
users   ops  fail  ops/s  p50ms  p95ms  p99ms  qwait  gh req/s  peak gh  peak/tok  2ndry@GH  retry  shed  unkn  loop p99  RSS MB
    5   150   126    649     10    230    230      -       104      150        13       126      0     0     0      10.9      97
   10   300   276   1935     19    155    155      -       155      300        13       276      0     0     0      12.4      98
   25   750   726   5034     42    105    150      -       161      750        13       726      0     0     0      10.7      99
   50  1500  1476   9804     50     54    151      -       157     1500        13      1476      0     0     0      10.6     100
```
This is the case the layer exists for. **Without it, 84–98 % of burst requests were
answered with a secondary-limit 403** (peak 13 in flight on one token, above the
modelled threshold of 12). **With it: 0 failures at 5 and 10 users, peak 6 per token, 0
secondary limits ever reached GitHub.** At 25+ users firing 30 requests simultaneously
(750–1500 requests offered in the same instant against a queue of 500) the excess is
shed truthfully (`GITHUB_QUEUE_FULL`); in production those bursts are additionally
spread by the bulk gate (3 concurrent bulk jobs) and the per-user queue cap (60),
which this harness bypasses by calling `github.js` directly.

## 🧾 Still to run against staging
p50/p95/p99 end-to-end Telegram latency, Postgres pool wait (`pg_pool_wait_ms`) and `pg_pool_waiting`, Redis latency/memory, upload/archive/download concurrency under real files, webhook backlog with 100+ events, restart/overlap behaviour, and the failure matrix (Postgres/Redis restart, Telegram slowdown). The metrics for all of these are exported on `/metrics`.

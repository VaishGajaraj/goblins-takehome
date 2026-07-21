# Load-testing the grading pipeline

One iteration = one student submission: `POST /api/submissions` (329KB PNG, the
realistic payload) → `202` → poll `GET /api/submissions/:id` with backoff until
graded. Arrivals are open-model (`ramping-arrival-rate`), so submission rate
stays on schedule even when grading slows — exactly what a classroom does.

## Profiles

| profile | shape | duration | use |
|---|---|---|---|
| `smoke` | 2/s steady + 6/s herd blip | ~40s | CI sanity, script check |
| `short` | 1 class at ~2× pace (ramp to 60/min) + 10/s×30s herd | ~4 min | **default ship gate** |
| `full` | 3 classes staggered 5 min (ramp 15→25/min each) + 10/s×30s herd | ~35 min | the real testing-day shape |
| `shed` | deliberate overload: 25/s×30s (≫ ~10/s service rate) | ~5 min | proves graceful shedding + recovery |

Guards against invalid runs (each added after an audit or a bad staging run;
see PLAN.md rounds 5–6): deterministic (student × problem) cycling so the
app's 3-attempt cap can't silently eat load (`attempt_capped==0` gate) ·
`dropped_iterations==0` so k6 provably offered the scheduled arrivals (no
silent VU throttling) · `gracefulStop: 150s` so tail polls reach terminal
states and `lost_submissions` is exact · `teardownTimeout: 300s` outlives the
3-min drain budget the teardown measures.

## Running

```sh
# local loop (free): term A — server tuned as a load target (fake grader,
# per-IP/daily guards off, PORT=3111 to match the k6 default)
npm run build && npm run loadtarget
# term B
npm run loadtest              # short | loadtest:smoke | loadtest:shed | loadtest:full

# ship/no-ship run against deployed staging (fake grader, real infra):
k6 run -e PROFILE=short -e BASE_URL=https://goblins-grader-staging.fly.dev loadtest/scenario.js

# HTML report:
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=report.html k6 run ...
```

Or trigger the **"Load test" GitHub Action** (workflow_dispatch) — it runs the
chosen profile against staging and uploads the HTML report as an artifact.

## Ship gates (k6 exits non-zero on breach)

Steady-state: submit p95 < 500ms · real-failure rate < 1% (429s are protocol,
not failures) · time_to_grade p95 < 15s, p99 < 45s. Always: zero lost
submissions (202'd but never terminal) · every QueueFull 429 carries a
retry-after hint · zero per-IP/budget-guard trips (staging disables those — the
load generator is one IP; prod keeps them strict). Herd: gated on graceful shed
+ **full backlog drain within 3 min** of the spike (checked in teardown), not
on steady-state latency — absorbing then recovering is the design.

## If a run fails

Three failure modes are common and none of them mean the pipeline is broken:

1. **"RateLimitedError: the target's per-IP/daily guards are on"** — you're
   load-testing a server with production guards. Use `npm run loadtarget`
   locally or point `BASE_URL` at staging. (The run aborts immediately with
   this message rather than producing a confusing red result.)
2. **A deploy rolled mid-run.** Pushes to main auto-deploy staging; the
   machine replacement drops connections for a few seconds, which trips the
   `http_req_failed` abort gate. Check the Actions "Deploy" workflow isn't
   running, then rerun.
3. **The setup preflight refuses the target** — either it's unreachable or
   its grader backend is `real` (load-testing that spends model money;
   override with `-e ALLOW_REAL=true` only on purpose).

The red "Load test" runs from 2026-07-20 in the Actions history are kept on
purpose: they're the harness-tuning iterations (VU init storm, undersized
pools, the ingest-ceiling discovery) described in PLAN.md audit round 6.

## Running against the real model

The fake/real toggle is per-deployment, not baked in: any target with
`GRADER_BACKEND=real` exercises the identical pipeline with real OpenRouter
calls, and the harness runs against it if you pass `-e ALLOW_REAL=true`
(the preflight otherwise refuses, since every submission then costs ~$0.002 —
a `short` run ≈ $1, `full` ≈ $3).

We validated the real path under concurrency with a 40-submission burst
(`scripts/real-burst.mjs`) at worker concurrency 20: 40/40 graded, zero
failures, accept p95 182ms, time-to-grade p50 2.1s / p95 3.4s. That matches
the fake grader's latency model, which is what makes the free runs
representative.

## Why the model bill is $0

The target runs `GRADER_BACKEND=fake`: same queue, workers, retries, DB writes,
and API surface — only the paid OpenRouter call is replaced by a lognormal
latency sample (median 1.8s, σ 0.6, tail ~10s, 2% injected retryable failures),
parameters fitted to the real-model smoke test in PLAN.md. Capacity math to
interpret results: throughput ≈ GRADER_CONCURRENCY / avg grade latency ≈
20 / 2s ≈ 10 grades/s ≈ 600/min — 3-class steady peak is ~75/min, herd is 10/s.

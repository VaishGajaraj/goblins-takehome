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
| `full` | 3 classes staggered 5 min (ramp 15→25/min each) + 10/s×30s herd | ~32 min | the real testing-day shape |

## Running

```sh
# local loop (free): term A
GRADER_BACKEND=fake GRADER_CONCURRENCY=20 SUBMIT_RATE_PER_MIN=1000000 \
DAILY_SUBMISSION_CAP=1000000 npm start
# term B
npm run loadtest              # short profile vs localhost:3111... set BASE_URL if needed

# ship/no-ship run against deployed staging (fake grader, real infra):
k6 run -e PROFILE=short -e BASE_URL=https://goblins-grader-staging.fly.dev loadtest/scenario.js

# HTML report:
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=report.html k6 run ...
```

Or trigger the **"Load test" GitHub Action** (workflow_dispatch) — it runs the
chosen profile against staging and uploads the HTML report as an artifact.
That's the "re-run as often as we like" button.

## Ship gates (k6 exits non-zero on breach)

Steady-state: submit p95 < 500ms · real-failure rate < 1% (429s are protocol,
not failures) · time_to_grade p95 < 15s, p99 < 45s. Always: zero lost
submissions (202'd but never terminal) · every QueueFull 429 carries a
retry-after hint · zero per-IP/budget-guard trips (staging disables those — the
load generator is one IP; prod keeps them strict). Herd: gated on graceful shed
+ **full backlog drain within 3 min** of the spike (checked in teardown), not
on steady-state latency — absorbing then recovering is the design.

## Why the model bill is $0

The target runs `GRADER_BACKEND=fake`: same queue, workers, retries, DB writes,
and API surface — only the paid OpenRouter call is replaced by a lognormal
latency sample (median 1.8s, σ 0.6, tail ~10s, 2% injected retryable failures),
parameters fitted to the real-model smoke test in PLAN.md. Capacity math to
interpret results: throughput ≈ GRADER_CONCURRENCY / avg grade latency ≈
20 / 2s ≈ 10 grades/s ≈ 600/min — 3-class steady peak is ~75/min, herd is 10/s.

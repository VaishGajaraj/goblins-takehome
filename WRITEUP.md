# Writeup: can we trust the grading pipeline?

_Statement of confidence, updated 2026-07-22. Live app:
[goblins-grader.fly.dev](https://goblins-grader.fly.dev) · load-test target:
goblins-grader-staging.fly.dev (fake grader). Reproduce the application-pipeline
tests with the [load-test guide](./loadtest/README.md), inspect the
[evaluation runner](./eval/run-eval.mjs), or run the
[manual Load test workflow](./.github/workflows/loadtest.yml)._

**Read the implementation:** [submission admission and persistence](./server/src/StudentApi.ts#L154-L248)
→ [bounded queue and workers](./server/src/GradingQueue.ts#L25-L124)
→ [fake and real graders](./server/src/Grader.ts#L25-L237). The
[k6 profiles and gates](./loadtest/scenario.js#L98-L218) drive that same API.

## What the system reliably handles today

The deployed fake-grader staging environment is one shared-CPU Fly machine
with 512MB RAM, SQLite on a volume, 20 grading workers, and a 200-job queue
([configuration](./fly.staging.toml#L9-L43)). Its fake grader uses a lognormal
latency distribution with a 1.8s median and 0.6 sigma plus 2% retryable
failures ([implementation](./server/src/Grader.ts#L43-L90)). That model implies
roughly **9 grades/s (~550/min)** before application overhead. This is a
capacity estimate, not a measured sustained-throughput result.

The committed evidence supports a narrower claim: the deployed application
path accepted a 10 submissions/s burst for 30 seconds, queued the work, and
drained it without losing accepted submissions. The separate three-class
profile schedules a maximum combined rate of about 63/min, but there is no
committed result for that full profile. The 10/s herd is intentionally severe:
it represents 30 students each submitting ten problems in 30 seconds, not a
normal classroom moment ([scenario model](./loadtest/scenario.js#L11-L21)).

Evidence measured against the deployed staging app on 2026-07-20:

- **The `short` profile passed its committed gates.** It scheduled about 393
  submission flows (about 93 from the class ramp plus 300 from the herd); the
  raw summary reports 435 total k6 iterations because the metrics observer is
  also an iteration. Each submission used a 329KB PNG, which becomes about
  439KB after base64 encoding before JSON overhead
  ([payload setup](./loadtest/scenario.js#L47-L56)). Steady submit p95 was
  **264.7ms**, and steady time-to-grade p50/p95/p99 was
  **3.1s / 7.2s / 11.3s**. The highest five-second queue sample was **127**.
  There were zero observed HTTP failures, lost accepted submissions, sheds,
  attempt-cap trips, rate-limit trips, dropped iterations, or drain timeouts.
  See the [raw short summary](./loadtest/results/short-staging-2026-07-20.summary.json).

- **The `shed` profile proved bounded overload behavior.** It scheduled 600
  submissions at 20/s for 30 seconds. Of those, **491 were accepted and 109
  received clean QueueFull 429s**; the raw summary's 610 total iterations also
  includes observer work. The highest sampled queue depth was its **200 cap**,
  every shed response had a retry hint, and no accepted submission missed the
  terminal-state polling window. Accepted submissions had p50/p95/p99
  time-to-grade of **45.1s / 75.8s / 79.4s**, and teardown observed the backlog
  drain within its recovery budget. See the
  [raw shed summary](./loadtest/results/shed-staging-2026-07-20.summary.json),
  [server-side cleanup and 429](./server/src/StudentApi.ts#L235-L244), and
  [client retry handling](./client/src/pages/WorkPage.tsx#L191-L207).

- **A manually recorded real-provider calibration completed 40/40 grades.**
  The target was configured with 20 workers, but the script paced submissions
  at about 5/s over eight seconds using one 47KB image and one problem
  ([script](./scripts/real-burst.mjs#L28-L77)). The recorded accept p95 was
  182ms and time-to-grade p50/p95 was 2.1s/3.4s. This checks the real integration
  and rough latency for one modest burst; it does not demonstrate 20 concurrent
  model calls, sustained provider capacity, or quota behavior. The output of
  that manual run is not committed as a result artifact.

- **Manual process-crash recovery worked for three in-flight jobs.** After a
  `kill -9` and restart, all three were requeued and graded. The mechanism is
  visible in the [durable submission states](./server/src/Db.ts#L61-L78) and
  [startup requeue](./server/src/GradingQueue.ts#L90-L115). This demonstrates
  process recovery on the same volume, not protection from volume or regional
  loss; the test transcript is not committed as an artifact.

- **The harness checks whether it delivered the intended test.** Deterministic
  student/problem cycling prevents the three-attempt product limit from
  silently reducing load; `dropped_iterations == 0` proves k6 offered the
  schedule; a 150-second graceful stop lets tail polling finish; and teardown
  waits for queued and grading work to clear. See the
  [selection logic](./loadtest/scenario.js#L181-L192),
  [thresholds](./loadtest/scenario.js#L194-L218), and
  [observer and teardown](./loadtest/scenario.js#L335-L356).

- **Harness-tuning runs suggested a large-request ingress ceiling.** Repeated
  runs with roughly 439KB base64 request bodies became unstable around
  **11–25 submissions/s**, depending on Fly burst credits, before the queue
  overflowed. This is an observational range without committed CPU telemetry,
  so it should not be treated as a formal CPU benchmark. The overload profile
  uses a 47KB PNG to isolate queue behavior from that ingress constraint
  ([rationale](./loadtest/scenario.js#L154-L172)).

## What the current gates do not prove

- `grade_failed` is recorded but has no threshold, and normal profiles do not
  explicitly require zero shedding. The overload gate requires some shedding,
  but does not set a maximum acceptable shed rate.
- The overload scenario records the first QueueFull response; it does not model
  the client's later retry wave.
- The fake grader does not reproduce provider quotas, network saturation,
  correlated outages, response-format failures, or provider fallback behavior.
- `/api/metrics` and teardown use global database state, and repeated tests
  retain assignments and PNGs. A dedicated target and cleanup/retention policy
  are required for reliable long-term repetition.

These are the next load-harness improvements, not reasons to discard the
current short and overload results.

## Is grading with cheap models accurate enough?

The committed golden set contains ten simulated whiteboards—correct, messy,
partial, wrong, and injection cases across two fraction problems—and invokes
the [same production grading function](./eval/run-eval.mjs#L1-L59). This is an
initial model-selection signal, not a broad accuracy claim: it contains no real
student handwriting, independent teacher raters, repeated runs, or other
subject areas. See the [ground truth](./eval/ground-truth.json) and
[recorded results](./eval/results.json).

| model | usable results | MAE among usable results | within ±1 | injection images | p50 |
|---|---:|---:|---:|---|---:|
| **gemini-3-flash-preview** (default) | 10/10 | **0.0** | 10/10 | both scored 0 ✓ | ~1.9s |
| gemini-2.5-flash-lite | 10/10 | 2.5 | 6/10 | **both scored 10 ✗** | ~1.7s |
| gpt-5-mini (configured fallback) | 2/10 | 0.0 on 2 cases | 2/2 | no usable injection result | ~10s on 2 cases |

The recorded results support using Gemini Flash Preview over Flash Lite in this
small set: Flash Lite followed instructions written in the student image and
awarded full credit. They do **not** yet validate GPT-5 Mini as a reliable
fallback: it matched the expected score in two usable cases, while eight of ten
attempts returned no usable grade. That path needs to be corrected and rerun
before relying on it in production. The
[system prompt](./server/src/Grader.ts#L129-L136), strict output schema, and
[server-side decoding and clamping](./server/src/Grader.ts#L138-L219) are useful
defenses, but representative teacher-scored work remains the real quality gate.

At the estimated primary-model price of about $0.002/grade, a 30-student,
10-problem assignment costs roughly **$0.60** and the provided $20 budget covers
about 10,000 grades. These are token-based estimates, not recorded billing data.

## Where it slows down and breaks

The tests found several distinct constraints rather than one universal failure
order:

1. As arrivals approach worker completion capacity, queueing stretches
   time-to-grade ([worker pool](./server/src/GradingQueue.ts#L42-L97)).
2. At the 200-job queue boundary, new work receives a clean 429 instead of an
   unbounded wait ([bounded dispatcher](./server/src/GradingQueue.ts#L25-L32)).
3. Large request bodies can constrain single-machine ingress before the queue
   fills; the shed profile therefore uses its smaller fixture.
4. SQLite's single writer, the local image volume, and sustained real-provider
   behavior have not been tested near their scale limits.

## 1,000 → 1M students

Student count must first be translated into traffic. If every student submits
ten grades in the same 20-minute window, 1,000 students produce about **8.3
submissions/s** and roughly **3.3GB of decoded PNGs**. That already leaves
little margin against the fake model's estimated service rate and exceeds the
current 1GB-volume design, so “1,000 students as-is” is not a supported claim.

- **1k:** the one-node architecture pattern can support a bounded pilot after
  validating real-provider quota, tuning concurrency with headroom, moving
  images to object storage or adding retention, and testing production limits.
- **10k:** move durable job state to Postgres, add atomic claims and leases,
  move images to object storage, split API and workers, and use shared edge
  rate limits. Effect isolates service interfaces, but this is a substantive
  distributed-systems change, not only a driver swap.
- **100k:** use a managed queue or event bus, a dedicated autoscaled worker
  fleet, provider-quota-aware routing, dead-letter handling, per-class fairness,
  and alerts on oldest-job age and time-to-grade.
- **1M:** add regional partitioning, regional object storage, strict tenant
  budgets, multi-provider routing, model cascades for cost control, retention
  policy, and sampled human review for quality calibration.

The current boundaries are visible in the [single-machine Fly configuration](./fly.toml#L12-L32),
[SQLite layer](./server/src/Db.ts#L15-L86), and
[in-process queue](./server/src/GradingQueue.ts#L25-L125).

## Ship / no-ship

**Ship as a bounded, teacher-visible pilot for a small number of monitored
classrooms.** The committed short profile passed its declared gates, the
overload profile shed predictably and recovered, and the default short test can
be rerun in about four minutes for no model cost. Grades remain auditable through
the [teacher-scoped inspection endpoint](./server/src/TeacherApi.ts#L170-L230)
and [review UI](./client/src/pages/TeacherPage.tsx#L20-L115).

**Do not treat this as evidence for a broad rollout yet.** Wider release remains
conditional on a sustained real-provider test at production settings, a
representative teacher-labeled accuracy set, stronger failure/shed thresholds,
and an image cleanup and retention plan.

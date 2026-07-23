# Technical report

How the system works, module by module, with the key functions and the
frameworks behind them. Companion to [README.md](./README.md) (quickstart),
[WRITEUP.md](./WRITEUP.md) (measured results), and [PLAN.md](./PLAN.md)
(decision log).

## Stack

| Layer | Choice | Version | Why |
|---|---|---|---|
| Server runtime | Node.js | 22 | native fetch, stable LTS |
| Server framework | **Effect** (`effect`, `@effect/platform`, `@effect/platform-node`) | 3.22.0 / 0.97.0 / 0.108.0, exact-pinned | Goblins' stack; its primitives (Queue, Stream, Schedule, Schema, Layer) map directly onto the grading pipeline. v3 pinned because v4 is beta and generated code drifts across the rename boundary |
| Persistence | SQLite via `@effect/sql-sqlite-node` (better-sqlite3 underneath) | 0.53.0 | zero-ops on one box; WAL for concurrent readers; the job ledger (see invariants) |
| Client | React 19 + Vite 6 + react-router 7 | caret | plain client, no Effect on the frontend — the norm for small Effect apps |
| Whiteboard | `@excalidraw/excalidraw` | 0.18.1 | MIT, pen/eraser/undo/touch built in, `exportToBlob` → PNG |
| Models | OpenRouter (OpenAI-compatible API) | — | `google/gemini-3-flash-preview` primary; `openai/gpt-5-mini` is configured as a provisional failover but its recorded eval was only 2/10 usable |
| Load testing | Grafana k6 | 2.x | open-model arrival executors, thresholds as CI exit codes |
| Hosting | Fly.io, 2 apps (prod real / staging fake), 1 machine each + 1GB volume | — | always-on stateful process + disk is the native primitive |
| CI/CD | GitHub Actions | — | `deploy.yml` (push → both apps), `loadtest.yml` (dispatch → k6 vs staging, HTML artifact) |

## Runtime topology

```
                    ┌─ goblins-grader.fly.dev          (GRADER_BACKEND=real)
 push to main ──►───┤    shared-cpu-1x · 512MB · /data volume (SQLite + PNGs)
 (deploy.yml)       └─ goblins-grader-staging.fly.dev  (GRADER_BACKEND=fake,
                         guards opened for load tests)
```

One Node process per app serves the API, the built SPA, and runs the grading
workers in-process. `--ha=false` keeps exactly one machine — SQLite is a
single-writer store and the design leans into that (see scaling in WRITEUP).

## Server: the Layer graph

Effect apps are wired as **Layers** (dependency-injected services).
`main.ts` composes:

```
HttpLive (HttpLayerRouter.serve)
 ├─ ApiRoutes = HttpLayerRouter.addHttpApi(GoblinsApi)   ← typed API surface
 │    ├─ SystemLive   (health, metrics)
 │    ├─ TeacherLive  (draft, create, view, inspect work, rubric, regrade)
 │    └─ StudentLive  (classInfo, join, submit, poll)
 ├─ StaticRoutes      (SPA files + index.html fallback, cwd-independent)
 ├─ GradingQueueLive  (bounded queue + worker pool + boot requeue)
 ├─ GraderLive        (fake | real, selected by env)
 ├─ RubricGenLive / ProblemGenLive (same fake/real pattern)
 ├─ SubmitRateLimitLive / JoinRateLimitLive
 ├─ DbLive            (SqliteClient + idempotent schema + WAL pragmas)
 └─ NodeContext.layer (FileSystem/Path for static serving)
```

Ordering matters once: **workers are up before recovery starts**, so a backlog
larger than the queue can drain while it is re-offered. Recovery is forked and
may interleave with new HTTP admissions; SQLite remains the durable job ledger.

### `Api.ts` + `Domain.ts` — the typed surface

`HttpApi.make("goblins")` declares every endpoint with `Schema` payloads,
success types, and **tagged errors annotated with HTTP statuses**
(`NotFoundError`→404, `InvalidImageError`→400, `QueueFullError`/
`AttemptLimitError`/`PausedError`/`RateLimitedError`→429). Handlers return
typed values or fail with declared errors; the platform encodes both.
Invalid bodies 400 automatically; `/api/openapi.json` is generated for free.
Errors carry `_tag` in the JSON body — the client switches on it (`ApiError`
in `client/src/api.ts`), and k6 counts sheds vs caps by the same tag.

### `Db.ts` — schema and pragmas

Idempotent `CREATE TABLE IF NOT EXISTS` at boot (single migration by design):
`assignments` (join_code UNIQUE, teacher_secret UNIQUE) → `problems`
(rubric as JSON text, whole-rubric replace on edit) → `students`
(UNIQUE(assignment_id, name)) → `submissions` (status CHECK constraint,
UNIQUE(student_id, problem_id, attempt), timestamps for latency metrics).
Pragmas: `journal_mode=WAL` (workers write while the report polls),
`busy_timeout=5000`, `foreign_keys=ON`. PNGs live on the volume as files;
rows store paths.

### `GradingQueue.ts` — the pipeline core

- **`GradingQueue` service**: `enqueue` = `Queue.offer` on a
  `Queue.dropping(QUEUE_CAPACITY)` — returns `false` when full (the shed
  signal). `enqueueWait` = offer with `Schedule.spaced` retry-until-accepted,
  used only off the hot path (boot requeue, teacher regrade).
- **`gradeOne(submissionId)`**: load row+problem → mark `grading` → call
  `Grader.grade` with `Effect.timeout("75 seconds")` and
  `Effect.retry({ times: 2, schedule: exponential("500 millis").jittered,
  while: retryable })` → persist `graded` (score, feedback, criteria_hits) —
  or, via `Effect.catchAllCause`, persist `failed` without ever killing the
  worker stream.
- **Worker pool**: `Stream.fromQueue(queue).pipe(Stream.mapEffect(gradeOne,
  { concurrency: GRADER_CONCURRENCY }), Stream.runDrain)` forked into the
  layer's scope. Throughput ≈ concurrency ÷ mean grade latency. With the
  staging fake's lognormal parameters and retry rate, 20 workers imply roughly
  9/s before application overhead; this is a model estimate, not sustained
  measured throughput.
- **Boot requeue**: `SELECT id WHERE status IN ('queued','grading')` →
  `enqueueWait` each, forked so HTTP starts immediately while a large
  backlog trickles in.
- **`metricsSnapshot`**: queue depth + status counts + avg/max time-to-grade
  for `/api/metrics` — the "inside view" the load test's observer samples.

### `Grader.ts` — one interface, two backends

`Grader.grade(input) → { score, feedback, criteriaHits }`.

- **`clamp` (applies to both backends)**: per-criterion awards are bounded,
  total score is bounded to `[0, maxPoints]`, and feedback is truncated. The
  current implementation does not recompute the total from criterion awards;
  stable criterion IDs plus a server-computed total are a production follow-up.
- **Fake**: `lognormalMs(median, σ)` via Box-Muller (defaults fitted to the
  real model: median 1800ms, σ 0.6), configurable injected retryable-failure
  rate, and `hash01(imagePath)` for stable pseudo-random scores — same
  submission grades the same on re-runs.
- **Real — `makeRealGrade`**: one `fetch` to OpenRouter chat/completions:
  system prompt that frames the image as **untrusted student work** (any
  instructions inside are content to grade, not commands), user content =
  problem + rubric JSON + `image_url` data-URL of the PNG,
  `response_format: json_schema (strict)`, `temperature: 0`,
  `models: [primary, fallback]` for provider failover, 60s abort signal.
  Response → `Schema.decodeUnknown` → `clamp`. Errors are classified
  retryable (429/5xx/timeouts) vs not, feeding the queue's retry policy.
- **`GraderLive`** selects fake vs real from `GRADER_BACKEND` (+ key
  presence). `RubricGen.ts` and `ProblemGen.ts` follow the identical
  pattern — batch generation, `normalize`/clamp server-side, and **template
  fallback on any model failure** so teacher flows never block on a model.

### `StudentApi.ts` — the submit path, in order

limiter (per-IP, `fly-client-ip`) → student/problem ownership check → daily
submission cap (kill switch) → attempt-cap fast path → PNG validation (magic
bytes + ≤2MB) → write file → **atomic attempt allocation**:

```sql
INSERT INTO submissions (…, attempt, …)
SELECT …, COALESCE(MAX(attempt),0)+1, …
FROM submissions WHERE student_id=? AND problem_id=?
HAVING COALESCE(MAX(attempt),0) < ?cap
```

SQLite's single-writer serialization makes the MAX+1 race-free; the HAVING
re-enforces the cap under concurrency; an empty insert = cap hit (verified: 6
parallel submits → attempts exactly 1,2,3, zero 500s). Then `enqueue`; on
`false`, the row+file are deleted — **a shed was never accepted, so it costs
no attempt and can't count as lost**. Join handles same-name collisions with
insert-retry over UNIQUE violations (walking `SqlError.cause` to detect
them), producing "Alex (2)" suffixes; `classInfo` lets the join page reject
bad codes before rendering a form.

### Client — key mechanics

`WorkPage.tsx` is a `Phase` union state machine
(`drawing → waiting → reveal → done`): poll with 1→2→4s backoff, a
`submitRef` so the QueueFull auto-retry timer never fires a stale closure,
timers cleaned on unmount. `Whiteboard.tsx` lazy-loads Excalidraw (its
chunks dominate the bundle) and exports via
`exportToBlob({ maxWidthOrHeight: 1024, mimeType: "image/png" })` — the
1024px cap bounds payload size, image tokens, and cost variance.
Identity: `localStorage` per join code, with server-side resume by
code+name as the cross-device path. `TeacherPage.tsx` polls the report every
5s; each populated cell opens a teacher-secret-scoped inspector containing
the validated PNG, criterion decisions, feedback, and all attempts for that
student/problem. `RubricEditor` keeps local draft state keyed by problem id
so polling doesn't clobber edits. Before submission, the whiteboard scene is
snapshotted in memory and restored as editable Excalidraw data when the
student retries.

## Load-test harness (`loadtest/scenario.js`)

One iteration = one submission: POST (330KB base64 PNG) → 202 → poll to a
terminal state, recording `time_to_grade`. Profiles: `smoke` (~40s sanity),
`short` (~4min ship gate: 1 class ramping to 60/min + 10/s×30s herd), `full`
(~35min, 3 staggered classes), `shed` (20/s deliberate overload, light
payload). Several guards protect the validity of results; each exists
because an audit or a failed staging run showed the harness could mislead:
**open-model `ramping-arrival-rate`** executors (arrivals independent of
response times),
**deterministic student×problem cycling** with per-scenario offsets so the
app's attempt cap can't silently eat load (`attempt_capped==0` gate),
**`dropped_iterations==0`** (k6 provably offered the scheduled load — this
caught a VU-init storm, fixed with a `SharedArray` payload, and undersized VU
pools), `gracefulStop: 150s` so tail polls finish (`lost_submissions` stays
exact), `teardownTimeout: 300s` outliving the 3-minute drain check the
teardown performs against `/api/metrics`, and 429s registered as *expected*
via `http.setResponseCallback` so `http_req_failed` measures real failures
only. An `observer` scenario samples queue depth throughout.

## Eval harness (`eval/`)

10 fixture whiteboards (correct/messy/partial/wrong/**injection** × 2
problems) rendered by `make-fixtures.py` with pinned ground truth.
`run-eval.mjs` imports **the production `makeRealGrade`** (same prompt,
schema, clamping — no eval-only code path) and grades all fixtures
concurrently per model, reporting MAE, within-±1 rate, injection scores, and
p50 latency into `results.json`. This demoted flash-lite (MAE 2.5, injections
scored 10/10). GPT-5 Mini matched the two cases that produced usable grades,
but 8/10 attempts were unusable, so the recorded run does not validate it as a
reliable failover yet.

## Invariants

1. SQLite is the source of truth for job state; the queue only dispatches.
2. Every model output is schema-validated AND numerically clamped server-side.
3. A shed (429) is never an accepted submission: no attempt consumed, no
   lost-work accounting.
4. Fake and real graders share every line except the model call itself.
5. Workers start before HTTP accepts; failed grades can't kill the stream.
6. The teacher's rubric is the grading contract — the model is told to award
   points only per criterion, and criteria echoes are clamped to their
   declared point values.

## Cost model

Grade ≈ 1,000 image tokens + ~800 prompt + ~300 output on
gemini-3-flash-preview ($0.50/$3 per M) ≈ **$0.002/grade** → $0.60 per
30-student × 10-problem assignment; ~10k grades on the $20 key. Load tests:
$0 (fake backend). Infra: ~$5–6/mo for both Fly apps.

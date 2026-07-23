# Goblins Auto-Grader — Build Plan

Planning date: 2026-07-19. Research basis: see [RESEARCH.md](./RESEARCH.md).

## Framing

The auto-grader is a growth product: generous enough to be worth a teacher's time on its own, habit-forming (grading is a recurring chore), and one click away from the real Goblins experience. Two problems at once: a product one (is grading with cheap models good enough for teacher trust?) and an infra one (does the pipeline absorb testing-day spikes, and can we prove it repeatedly without burning model budget?).

## Decisions (made 2026-07-19)

| Decision | Choice | Why |
|---|---|---|
| Backend | **Effect v3** (effect 3.22.0, @effect/platform 0.97.0, @effect/platform-node 0.108.0, @effect/sql-sqlite-node 0.53.0 — pinned) | Goblins builds in Effect; v3 is production-stable and its Queue/Semaphore/Schedule primitives are exactly the grading-pipeline shape. v4 is beta — avoided. |
| Frontend | React + Vite, plain (no Effect client) | Norm for small Effect apps; typed client derivable from shared HttpApi if cheap. |
| Whiteboard | **Excalidraw** (MIT) | Drop-in `<Excalidraw/>`, pen/eraser/undo/touch out of the box, `exportToBlob` → PNG for the vision model. tldraw rejected: license key + watermark. |
| Grading model | **google/gemini-3-flash-preview** via OpenRouter; provisional GPT-5 Mini fallback | The small eval selected Gemini over Flash Lite because Flash Lite followed prompt-injection text in both attack images. GPT-5 Mini produced only 2/10 usable results, so the configured fallback is not yet validated. Estimated ~$0.002/primary grade; strict `json_schema` output. |
| Persistence | SQLite via @effect/sql-sqlite-node (v0.53.0) on a Fly volume | One always-on box; zero-ops; zero network hops so load-test numbers measure *our* pipeline, not a DB vendor's cold starts. WAL mode + busy_timeout for concurrent workers/report polling; Fly volume snapshots (daily) as the backup story, Litestream noted for continuous replication. Alternatives considered below. |
| Hosting | **Fly.io**, single always-on machine + 1GB volume (~$2–3/mo) | Dockerfile deploy, no cold starts to pollute latency numbers, concurrency limits tunable so k6 spikes hit the app, not the proxy. |
| Load tool | **k6 v2.x** (TypeScript scripts) | Open-model `ramping-arrival-rate` (arrivals independent of response times), thresholds = CI ship/no-ship exit codes, HTML dashboard export. |
| Auth | None (per brief) | Teacher gets a secret admin URL; students join via code + name. |

### Databases considered (2026-07-19 state)

SQLite-on-volume won for the demo because every alternative adds a failure mode or latency artifact we'd then be load-testing by accident. Rejected, with the honest reason:

- **Turso/libSQL** (free: 5GB, 500M reads/mo; `@effect/sql-libsql` v0.42.0): SQLite-compatible + managed, but the company is mid-pivot to a Rust rewrite and the libSQL embedded-replica path is now legacy — wrong week to bet on it.
- **Neon serverless Postgres** (free: 100 CU-hrs/mo; `@effect/sql-pg` v0.53.0): scale-to-zero cold starts (~0.5–2s) would pollute p99s unless pre-warmed/paid. Great for branching workflows; wrong for latency-honest load tests on a free tier.
- **Supabase Postgres** (free: 500MB, 7-day inactivity pause): the pause is fatal for a take-home reviewed on an unknown date. IPv6 direct connection from Fly works, but it's another service for no demo benefit.
- **Fly Managed Postgres** ($38/mo min): the *right* answer at 10k scale (same-region private network, HA, backups) — named in the scaling ladder; overkill at demo scale.
- **Cloudflare D1** (free: 5GB): effectively Workers-only — external HTTP access shares a 1,200 req/5min account limit. Wrong platform shape.
- **Upstash Redis + BullMQ** (free: 500K commands/mo): BullMQ's idle polling burns the free tier; Upstash themselves say use a paid plan. Our Effect Queue + SQLite job table does the same job with zero extra services.

The swap path is real, not hypothetical: @effect/sql is driver-abstracted, so SQLite → `@effect/sql-pg` at 10k is a layer change, not a rewrite.

## Architecture

```
React/Vite SPA ──HTTP──> Effect HttpApi server ──> SQLite (Fly volume)
  teacher: create/edit/report            │
  student: join/draw/submit/poll         ▼
                              bounded Queue.dropping(cap)
                              full → 429 + Retry-After
                                       │
                              worker pool (concurrency N)
                              timeout 60s · retry expo+jitter
                                       │
                        GRADER_BACKEND env flag
                        ├─ real: OpenRouter chat/completions
                        │        (image + rubric → strict JSON score)
                        └─ fake: lognormal latency (median ~2s, tail ~10s)
                                 + configurable error/timeout rates
```

Submission flow is **accept-and-enqueue**: validate, persist, return 202 + submission id; client polls `GET /submissions/:id`. This absorbs spikes, enables the zero-lost-submissions SLO, and gives the student a fun "goblin is grading…" beat. Same code path for fake and real graders — load tests exercise everything except the paid call.

**Durability (audit fix):** SQLite is the source of truth for job state (`queued|grading|graded|failed`); the in-memory queue is only a dispatcher. On boot, workers start first, then pending rows re-enqueue via a waiting offer (backlogs larger than queue capacity trickle in instead of dropping) — so a deploy or crash mid-spike loses nothing, which is what makes `lost_submissions == 0` an honest claim and squares with the brief's "everything persists." Attempt numbers are allocated atomically inside the INSERT (SQLite single-writer + HAVING re-check), so concurrent double-taps can't collide on `UNIQUE(student, problem, attempt)` or slip past the attempt cap; rapid duplicate submits are bounded by that cap and the disabled submit button. PNGs are written to the volume as files; SQLite keeps paths + metadata (keeps DB small, payloads streamable).

## Part 1 — product slice

**In:**
1. Teacher creates an assignment (title + math problems; one-click sample assignment to remove blank-page friction) → gets a share code + secret teacher URL.
2. Rubric auto-generated per problem (one model call), editable inline by the teacher before/after publishing.
3. Student joins with code + name → per-problem Excalidraw whiteboard → submit exports PNG.
4. Score + brief feedback shown after grading; auto-advance to next problem; finish screen.
5. Teacher report: students × problems grid with scores/status, live polling, and **per-problem class averages** — the "which problem did they struggle on" view is the analytics a teacher acts on (brief: "still with the analytics").
6. Persistence: everything server-side in SQLite. Teacher returns via secret URL; student re-enters code + name from any device and resumes. (Deliberate call: "name = identity within a class" is the no-auth persistence model.)
7. **Goblins CTA (audit fix — this is the business point):** the growth product must drive traffic to the main Goblins experience "a simple button-click away." Tasteful CTA on the teacher report ("Want this with real-time feedback for students? Try Goblins") and the student finish screen. Zero-cost to build; without it the app is a nice grader that grows nothing.

**Product note:** "real-time feedback turned off" = no live help *while* the student works; the post-submit score in point 4 is explicitly in the brief. The whiteboard stays feedback-silent until submission.

**Out (deliberate):** email/real auth, multi-class management, editing assignments after students start, images in problem statements, per-criterion partial-credit UI (rubric text carries it), accessibility beyond basics, mobile-teacher views, regrading already-graded work after rubric edits (+ stale-rubric banner) — global "regrade failed" exists; rubric-edit-triggered regrade is a cost decision for real-product scope. CSV export of grades is a maybe-if-time (teachers love it).

**Tone:** small goblin character in grading/waiting states; encouraging feedback wording ("show your work" praised, not just right/wrong). Cheap, high-leverage charm.

**Grading quality (round 3 — answers the brief's "how accurate w/ cheaper models?"):**
- Determinism levers: temperature 0, strict `json_schema` output (`{score, feedback, criteria[]}`), output capped at 500 tokens, rubric criteria echoed back so the model must anchor each point to a criterion.
- Whiteboard PNGs downscaled to ~1024px longest edge before upload — caps image tokens (~1k), payload size, and cost variance in one move.
- **Mini golden-set eval:** ~10 seeded submissions (correct / partially-correct / wrong / messy-handwriting) graded by gemini-3-flash-preview vs gemini-2.5-flash-lite, scores compared against hand-assigned ground truth. Costs <$0.10, becomes a table in the writeup, and turns the model choice from vibes into evidence. This is the product-side counterpart of the load test.

## Part 2 — load test

**Scenario model (k6):** one accepted-submission iteration = submit → poll to a terminal state, measuring a custom `time_to_grade` Trend and a `lost_submissions` Counter; QueueFull iterations return after the 429.
- `class_a/b/c`: `ramping-arrival-rate`, staggered starts (0/5/10 min), ramp to ~15–25 submissions/min each over a 20-min window (30 students × ~10 problems).
- `thundering_herd`: whole class dumps ~300 submissions in 30s (10/s) after the classes wind down.
- Short/CI variant of the same profile (~3 min) for the cheap loop.

**Capacity math (audit correction):** throughput ≈ worker_concurrency ÷ mean_grade_latency. The fake grader's 1.8s median lognormal latency has a ~2.15s mean; with its injected retry rate, concurrency 20 implies roughly 9 grades/s (~550/min) before application overhead. This is a model estimate, not measured sustained throughput. The staggered 3-class schedule peaks around 63/min and the herd offers 10/s for 30 seconds, so the herd is designed to show tail growth and bounded overload behavior. Submissions POST a 329KB PNG (~439KB after base64, before JSON overhead), so payload transfer is part of the system under test.

**Ship gates (k6 thresholds, non-zero exit on breach):**
- Steady-tagged work: `submit p(95) < 500ms` · `time_to_grade p(95) < 15s, p(99) < 45s`; globally, `http_req_failed rate < 1%`, `lost_submissions == 0`, zero dropped iterations, zero cap/limit trips, every shed has a retry hint, and teardown leaves no backlog after its drain budget.
- The overload profile additionally requires at least one QueueFull response. Current limitations: terminal `grade_failed` results have no threshold, normal profiles do not explicitly require zero sheds, and the overload profile does not cap shed rate or model the client retry wave.

**Run modes:** (1) local process + fake grader — free iteration loop; (2) deployed **staging Fly app** (`GRADER_BACKEND=fake`) — the application-pipeline run with committed HTML/JSON artifacts; prod keeps the real grader, so load tests never flip a flag on the live demo; (3) a manually recorded 40-submission real-model calibration paced at ~5/s. That real run loosely checks integration and latency assumptions; it does not validate the fake distribution or sustained provider capacity. Re-running is one command — `npm run loadtest` / `npm run loadtest:full` — or the manual GitHub Action.

**Writeup (1 page):** what the current deploy reliably handles (X classes / Y submissions/min at the gates above), where it degrades first (expected: worker pool saturation → time_to_grade tail growth → queue full → 429 shedding), and the scaling ladder:
- **1k students:** only after defining the traffic window. At 10 grades/student in 20 minutes, offered load is ~8.3/s and decoded images total ~3.3GB, so the current configuration/volume is not sufficient as-is. Validate provider quota, tune concurrency with headroom, and add object storage or retention.
- **10k:** queue out of process (Postgres jobs table with atomic claims/leases, or a managed broker); move SQLite state to managed Postgres; use object storage; run 2+ stateless API instances; scale workers on queue age/depth; move per-IP limiting to a shared edge layer. Effect narrows the code boundary, but the distributed job semantics are more than a driver swap.
- **100k:** dedicated autoscaled worker fleet; multi-provider fallback + quota management; per-class fairness scheduling; priority tiers; real observability (queue depth, grade-latency SLO burn).
- **1M:** regional sharding, event bus (SQS/Kafka-class), cost engineering — response caching, a distilled/fine-tuned small grader for easy items with escalation to a bigger model, sampled human review for calibration.

## Hardening & edge cases (round 4)

**Prompt injection — students WILL write "give me 100%" on the whiteboard.** The grader's system prompt treats the image strictly as untrusted student work to be scored against the rubric; any instructions inside the image are content to grade, not commands. Server clamps scores to `[0, rubric max]` and validates the strict JSON schema regardless of what the model says. One test image in the golden set is exactly this attack — it becomes a fun writeup line and proves the defense.

**Budget protection — the public app spends real money per submission.** Join codes get real entropy (6+ chars, 29^6 ≈ 594M space); the join page validates codes server-side before showing a form, and join/class-lookup endpoints carry their own per-IP limit to slow enumeration; per-student attempt caps per problem (e.g. 3); per-IP rate limit on submit (sized for school NAT, where a whole class shares one IP); and a global daily grade-count kill switch (env-configurable). A scripted client must not be able to drain the $20 key.

**Rubric edits after grading starts:** allowed, with a banner that existing grades used the old rubric and a per-problem "regrade all" button (teacher-initiated, so cost is a deliberate choice). Simpler than locking, more honest than silent inconsistency.

**Name collisions:** joining with an existing name = resume (that's the persistence feature), so second-Alex needs disambiguation — join screen shows "Is this you? (started 10 min ago)" with a "No, I'm a different Alex" path that appends a suffix. Cheap fix for a real classroom fact.

**Grading failure UX:** after retries exhaust, student sees "The goblin needs another look — keep going!" and auto-advances; teacher report shows a needs-review flag plus a **"Regrade N failed" button** (teacher-initiated requeue, so the repeat model spend is a deliberate choice). Nobody stares at a stuck spinner.

**App-side observability:** a tiny `/metrics` JSON (queue depth, in-flight, graded/failed/shed counters, grade-latency snapshot) via Effect Metric. k6 sees the outside; this sees the inside — the herd-recovery claim in the writeup gets a queue-depth trace, not vibes.

**Poll realism:** clients (and k6) poll with backoff 1s→2s→4s; poll requests tagged separately in k6 so hundreds of held VUs polling don't drown the metrics that gate shipping.

**If over time budget, cut in this order:** GitHub Action → CSV export → screen recording → third class scenario → charm-pass extras. Never cut: durability, golden-set eval, herd scenario, CTA, writeup.

**Reviewer's first open:** Alp lands on a page with a pre-seeded sample class — graded work already in the report — plus "create your own in 60 seconds." The demo must be alive before he does anything. README carries a 5-line demo script.

## Milestones (target ~75 + 75 min of AI-assisted work; buffer expected)

1. **Scaffold (20m):** repo, Effect server + HttpApi + static serving, Vite React, SQLite migrations, Dockerfile, fly.toml. Compile early — Effect API drift is the top risk.
2. **Teacher flow (20m):** create assignment, rubric generation + inline edit, share code, teacher URL.
3. **Student flow + pipeline (25m):** join, Excalidraw, PNG submit, queue/workers/retry, fake+real graders, score screen.
4. **Report + polish (10m):** teacher grid, aggregates, goblin charm pass.
5. **Load-test kit (40m):** k6 scenarios + thresholds + HTML report; local + Fly runs; tune concurrency/limits from findings.
6. **Ship (35m):** deploy, seed demo assignment, real-model smoke + golden-set accuracy eval, writeup, README, share repo with Karavil, optional 2–3 min recording.

## Risks

- **LLM-generated Effect code drift** (Http→HttpApi renames, v4 APIs leaking in): pin exact versions, keep RESEARCH.md sketches in context, compile after every chunk.
- **Fly proxy limits masquerading as app limits:** set `[http_service.concurrency]` hard_limit ~1000 before spike runs.
- **OpenRouter latency variance:** 60s timeout, retry w/ jitter, model fallback array; UX never blocks on grading.
- **Budget:** load tests never touch the real model; real spend ≈ demo + smoke ≪ $1 of the $20 key. Key lives in env/Fly secrets only — never in the repo.
- **Memory under image load:** 256MB may be tight for concurrent PNG handling; start at 512MB (~$2 more/mo is nothing) rather than debugging OOMs during spike runs.

## Audit log (round 2, 2026-07-19)

Re-audited against the canonical Notion brief (text confirmed identical to the original). Coverage held; five substantive fixes were folded in above: (1) Goblins CTA — the growth loop was missing from v1 of this plan; (2) DB-backed job durability + requeue-on-boot (client idempotency keys remained deferred); (3) explicit capacity math and realistic PNG payloads in k6; (4) scenario-specific latency plus global failure/recovery gates; (5) separate staging app as the load-test target + one-command re-run. Also made per-problem analytics explicit and pinned the "real-time feedback off vs post-submit score" product interpretation.

## Audit log (round 3, 2026-07-19)

Prompted by the "what other databases?" question. Added: alternatives considered (Turso, Neon, Supabase, Fly MPG, D1, Upstash) and an initial Postgres migration direction; the later audit clarified that distributed claiming, leases, object storage, and shared limits make this more than a driver swap. Also added SQLite operational specifics, the PNG downscale cap, and a mini golden-set accuracy eval because the brief explicitly asks how well cheaper models grade.

## Audit log (round 7, 2026-07-20 — post-ship product teardown)

Re-read the brief and walked the entire deployed workflow as teacher and student, plus a fresh-context UX review of every client page. Result: [PRODUCT.md](./PRODUCT.md) — 13 concrete findings across bugs/traps (teacher secret-URL dead end, clipboard crash on HTTP, double-draft race), teacher trust (no way to view the student's actual whiteboard or per-criterion breakdown — named the #1 next feature), student experience (try-again wipes the drawing; no recap), and growth (QR join, colleague share, asset caching). One finding was fixed immediately rather than documented: the join rate limit's default sat exactly at a real class's legitimate joining peak from one school NAT IP (60/min) — raised to 240. Everything else is deliberately documented-not-built, with a prioritized next-sprint list, per the brief's scoping premium.

## Audit log (round 6, 2026-07-20 — post-M5 dual audit)

Two parallel fresh-context audits: one on the k6 kit's honesty, one on repo ship-readiness. The k6 audit found three ways the test could lie, all fixed: (F1) k6's default 60s `teardownTimeout` would have killed the 3-min drain check as a spurious hard failure → 300s; (F2) random student/problem sampling collided with the app's own 3-attempt cap (~⅔ of full-profile herd would have bounced as AttemptLimit, quietly deflating offered load) → 10 problems + deterministic pair cycling with per-scenario offsets + `attempt_capped==0` gate; (F3) VU exhaustion only surfaces as `dropped_iterations`, which no gate watched → gate added + herd maxVUs sized to rate × poll-tail; plus `gracefulStop: 150s` so truncated tail polls can't leak past `lost_submissions==0`, and a new `shed` overload profile (20/s) because the standard herd never actually fills the queue — shedding was previously proven only ad-hoc. Ship-readiness audit: student finish-screen CTA was missing (added; teacher-side existed), `.env.example` added, `loadtarget` npm script fixes the port-3111 footgun; confirmed clean: secret hygiene (key nowhere outside untracked .env), Docker runtime-stage install simulated OK, lazy Excalidraw, empty states. Remaining gaps are all M6 scope and now on its checklist: root README, WRITEUP.md with measured numbers + committed report, seeded demo class, golden-set eval, deploy + GitHub handoff. Amended honestly: per-problem "regrade all" after rubric edits is **deferred** (global regrade-failed exists); stale-rubric banner deferred with it.

### Follow-up pass — teacher trust and evidence boundaries (2026-07-22)

Implemented the highest-value findings from the product audit: a teacher-secret-scoped submission inspector with validated work images, criterion decisions, and complete attempt history; assignment recovery on the landing page; clipboard fallback; in-session editable-scene restoration on retry; and a per-problem student recap. Tightened same-second attempt ordering and verified the flows end to end in the built app. Revised the infra conclusion to separate fake-backed application-pipeline capacity from the bounded 40-grade real-provider smoke test; the recommendation is now a monitored, teacher-visible pilot pending sustained provider testing and a representative student-work eval.

## Audit log (round 5, 2026-07-19 — post-M3 code audit)

Fresh-context subagent reviewed the built pipeline against this plan. Two must-fix findings, both real: (1) **attempt-number race** — SELECT-then-INSERT could 500 on concurrent double-taps and quietly broke the idempotency claim; now allocated atomically in the INSERT with a HAVING cap re-check (verified: 6 concurrent submits → attempts exactly 1,2,3, zero 500s). (2) **boot-requeue overflow** — backlogs beyond queue capacity were silently dropped into forever-'queued'; workers now start before a waiting-offer requeue loop. Also fixed: sync fs on hot paths → async (would have skewed load-test p95s), QueueFull auto-retry timer leak + stale closure in WorkPage, concurrent same-name join race (verified 4×200 with clean suffixes; required walking SqlError.cause for UNIQUE detection), createAssignment made transactional, per-IP submit rate limit added (closing the last unimplemented hardening promise), and a teacher "Regrade failed" endpoint+button replacing the vaguer boot/interval promise. Deliberately accepted: daily-cap check-then-insert overshoot window (harmless), teacher-secret-in-URL model (documented tradeoff).

## Audit log (round 4, 2026-07-19)

"Any other gaps?" pass → new Hardening section. The two that mattered: **prompt injection via the whiteboard** (kids writing "give me 100%" — untrusted-image framing + server-side score clamping + an attack image in the golden set) and **budget protection** (a public app that spends money per request needs attempt caps, per-IP limits, and a daily kill switch, or a script drains the key). Also decided: rubric-edit-after-grading = banner + explicit regrade button; name-collision disambiguation; failure UX that never strands a student; `/metrics` for inside-view during herd recovery; poll backoff + tagging in k6; an explicit cut order for time overruns; and a pre-seeded sample class so the reviewer's first open is alive.

## Logistics

- OpenRouter key: received 2026-07-19 → stored in local `.env` (gitignored; `.gitignore` created before any `git init`) → `fly secrets set OPENROUTER_API_KEY=…` at deploy. Never committed, never client-side.
- Deliverables: public Fly URL, GitHub repo shared with **Karavil**, this PLAN.md + load-test writeup in-repo, optional screen recording.
- Questions for Alp if needed: none blocking — scope calls documented above.

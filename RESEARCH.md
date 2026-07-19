# Research Digest (2026-07-19)

Condensed findings from three parallel research passes. Versions verified against npm/GitHub on this date.

## 1. Effect (TypeScript)

**Target Effect v3, not v4.** v4 has been beta since Feb 2026 and official guidance still recommends v3 for production. Nearly all docs and LLM training data are v3.

**Pinned versions (all published 2026-07-13):** `effect@3.22.0`, `@effect/platform@0.97.0`, `@effect/platform-node@0.108.0`, `@effect/sql@0.52.0`, `@effect/sql-sqlite-node@0.53.0`, `@effect/ai@0.37.0`, `@effect/ai-openrouter@0.12.0`. The 0.x packages have narrow peer ranges — install together at exactly these versions.

**HTTP server idiom (v3):** `HttpApi.make → HttpApiGroup → HttpApiEndpoint.post().setPayload(Schema.Struct(...))`, implemented with `HttpApiBuilder.group`, served via `HttpApiBuilder.serve` + `NodeHttpServer.layer`. Invalid bodies → automatic 400. Static files: `HttpLayerRouter.addHttpApi(Api)` merged with a file-serving route, then `HttpLayerRouter.serve`.

**Pipeline primitives (core `effect`):**
- `Queue.dropping<Job>(64)` — `Queue.offer` returns `false` when full → respond 429. (`Queue.bounded` suspends; wrong for reject-fast.)
- Workers: `Stream.fromQueue(q).pipe(Stream.mapEffect(grade, { concurrency: N }), Stream.runDrain)` forked in `Layer.scopedDiscard(Effect.forkScoped(...))`.
- Retry: `Effect.retry({ times: 3, schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered), while: pred })` + `Effect.timeout("60 seconds")`.
- `Effect.makeSemaphore(N)` / `RateLimiter.make({ limit, interval, algorithm: "token-bucket" })` both exist in v3 core.

**SQLite:** `@effect/sql-sqlite-node` is maintained and wraps `better-sqlite3` as an Effect service — `SqliteClient.layer({ filename })`, tagged-template queries, built-in Migrator. Use directly.

**Frontend:** norm is Effect server + plain React/Vite client; typed client derivable via `HttpApiClient.make` from the shared HttpApi. Skip @effect-atom for this scope.

**Known LLM drift traps:** dead 2024 `Http.*` API (now `HttpApi*`/`HttpRouter`); `@effect/schema` merged into core 3.10 (`import { Schema } from "effect"`); obsolete `Effect.gen(function* (_) …)` adapter; v4 beta APIs (`effect/unstable/*`, `ServiceMap`) leaking into v3 code; hallucinated Schedule combinators.

**@effect/ai:** official, provider-agnostic `LanguageModel.generateObject` with Schema-validated output; dedicated `@effect/ai-openrouter` exists and OpenRouter documents it. Caveat: 0.x with 2025 renames — a plain `fetch` in `Effect.tryPromise` + `Schema.decodeUnknown` is a fine lower-risk fallback.

Sources: effect.website/blog/releases/effect/40-beta/ · effect.website/docs (queue, retrying, ai) · github.com/Effect-TS/effect v3 platform README · openrouter.ai/docs/guides/community/effect-ai-sdk

## 2. Load testing

**Tool: k6 v2.1.0** (AGPL, free locally). Native ESM + first-class TypeScript since v1.0 (old ES5.1/goja limitation is gone — it's Sobek now). Open-model `ramping-arrival-rate` executor keeps arrival rate independent of response times (critical when grading is slow). `thresholds` produce non-zero exit codes → CI ship/no-ship gates. HTML report: `K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=report.html`. Alternatives rejected: Artillery (weaker ramp control), autocannon/vegeta (no multi-step scenarios), Locust (closed-model default, Python).

**Mocking the paid LLM:** env-flag fake backend (`GRADER_BACKEND=fake|real`), same code path otherwise. Lognormal latency (median ~2s, tail 8–10s) — standard model for LLM/server response times (Hoverfly ships lognormal delay mode). Configurable injected 429/500/timeout rates to prove retry/queue behavior. Prior art: Speedscale LLM mocking, LiteLLM `fake-openai-endpoint`, Gatling LLM load-test guide. Env-flag at deploy beats header switching (no prod mock-header risk).

**Arrival math:** 30 students × 10 problems / 20 min ≈ 15/min per class average; script staggered classes + a thundering-herd scenario (300 submissions in 30s = 10/s). One k6 iteration = submit → poll to graded; size `maxVUs ≈ arrival_rate × p99 time_to_grade + slack`; no trailing sleeps.

**Threshold shapes:** `http_req_duration{endpoint:submit} p(95)<500`; `http_req_failed rate<0.01` (with `abortOnFail`); custom Trend `time_to_grade p(95)<15000, p(99)<45000`; Counter `lost_submissions count==0`.

**Platform gotchas:** Fly proxy `soft_limit` defaults to 20 — raise `[http_service.concurrency]` or the test measures the proxy. Render free tier spins down (30–60s cold starts pollute runs). Standard workflow: cheap loop on localhost/Docker, occasional deployed runs for ship confidence. ≤10 rps won't trip IP flagging.

**Backpressure:** accept-and-enqueue (202 + poll) with bounded queue and 429 + Retry-After only at true saturation is the sound pattern (AWS Builders' Library on unbounded backlogs). Synchronous-with-cap pushes retries onto 30 kids mid-exam — worse.

Sources: github.com/grafana/k6/releases · grafana.com/docs/k6 (executors, scenarios, thresholds, web-dashboard) · speedscale.com LLM mocking · docs.litellm.ai/docs/load_test · gatling.io LLM load test · docs.hoverfly.io lognormal · fly.io/docs/apps/concurrency · aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs

## 3. Product components

**Whiteboard: Excalidraw** (`@excalidraw/excalidraw`, MIT). Drop-in React component: pen, eraser, undo, touch/stylus. `exportToBlob({ mimeType: "image/png" })` → PNG for the vision model. Lazy-load it (chunky bundle, no SSR). tldraw rejected: source-available, needs license key, watermark on free tiers, commercial ~$6k/yr. perfect-freehand: only strokes, hand-roll everything else.

**Models (OpenRouter, July 2026 pricing per 1M in/out):**

| Model | In/Out | Note |
|---|---|---|
| google/gemini-2.5-flash-lite | $0.10/$0.40 | cheapest credible; ~$0.0003/grade |
| openai/gpt-5-nano | $0.05/$0.40 | clamp reasoning effort |
| qwen/qwen3-vl-8b-instruct | ~$0.12/$0.46 | strong open VL |
| openai/gpt-5-mini | $0.25/$2 | best cheap OpenAI OCR |
| **google/gemini-3-flash-preview** | $0.50/$3 | top OCR-per-dollar; ~95% rubric-item accuracy on handwritten math (arXiv 2605.19043); ~$0.002/grade |
| anthropic/claude-haiku-4.5 | $1/$5 | 10× flash-lite; skip |

Image tokens (Gemini): ~768px tiles at 258 tokens → ~1000px PNG ≈ ~1,032 tokens. $20 key ≈ 10k grades on gemini-3-flash-preview, ~65k on flash-lite. OpenRouter: OpenAI-compatible `/api/v1/chat/completions`; strict structured outputs via `response_format: json_schema`; `models: [...]` array (max 3) for automatic fallback, billed only for the success.

**Hosting: Fly.io.** Always-on shared-cpu-1x/256MB ≈ $1.94/mo + volume $0.15/GB/mo ≈ $2–3/mo total. Dockerfile deploy, no cold starts, load-testing own apps is accepted practice; tune concurrency limits for spikes. No free tier (card on file; tiny trial). Railway close second ($5 trial credit). Render free tier spin-down breaks load tests. Vercel/Netlify confirmed bad fit: ephemeral FS kills SQLite + in-memory queue.

Sources: npmjs.com/package/@excalidraw/excalidraw · tldraw.dev/pricing · openrouter.ai model pages + docs (structured-outputs, model-fallbacks) · ai.google.dev/gemini-api/docs/tokens · arxiv.org/pdf/2605.19043 · fly.io/docs/about/pricing · docs.railway.com/pricing/plans · vercel.com/kb/guide/is-sqlite-supported-in-vercel

# Goblins Auto-Grader

Teachers create a math assignment, students show their work on a whiteboard,
a vision model grades it against a teacher-editable rubric, and the teacher
watches a live class report. No accounts: teachers hold a secret link,
students rejoin with class code + name from any device.

**Live demo:** [goblins-grader.fly.dev](https://goblins-grader.fly.dev) — or jump straight to the
[seeded sample class report](https://goblins-grader.fly.dev/t/-_gIOIVCqTPjh13SjFSSaDrT)
(3 students, real-model grades) · try the student side with join code **7M4AHJ**
· load-test target: [goblins-grader-staging.fly.dev](https://goblins-grader-staging.fly.dev) (fake grader)
**Writeup (Part 2):** [WRITEUP.md](./WRITEUP.md) · **Plan & decision log:** [PLAN.md](./PLAN.md)

## Quickstart

```sh
npm ci
cp .env.example .env          # add your OpenRouter key (only needed for real grading)
npm run build
npm start                     # http://localhost:3000  (GRADER_BACKEND=fake by default — free)
node scripts/seed.mjs         # optional: seed a sample class, prints teacher/student links
```

`GRADER_BACKEND=real` switches rubric generation + grading to OpenRouter
(gemini-3-flash-preview, ~$0.002/grade; failover gpt-5-mini — chosen by the
[golden-set eval](./eval/results.json), which disqualified flash-lite for
scoring prompt-injection images 10/10).

Dev loop: `npm run dev:server` (tsx watch, :3000) + `npm run dev:client` (vite, :5173, proxies /api).

## How it works

```
React/Vite SPA ──/api──> Effect v3 HttpApi server ──> SQLite (WAL, source of truth)
 teacher: create → edit rubric → report        │        images on disk
 student: join → Excalidraw → submit → poll    ▼
                                bounded Queue (dispatcher only)
                                full → 429 + retry hint
                                        │
                          workers (concurrency N) · 75s timeout
                          retry ×2 expo+jitter · requeue on boot
                                        │
                          GRADER_BACKEND: fake | real (OpenRouter vision,
                          strict json_schema, injection-resistant prompt,
                          server-side score clamping)
```

Submissions are accept-and-enqueue (202 + poll). Job state lives in SQLite, so
a crash or deploy mid-spike loses nothing — proven by kill-9 test and gated in
the load suite (`lost_submissions == 0`). Budget guards: 3 attempts per
problem, per-IP submit limit, daily kill switch.

## Load testing

See [loadtest/README.md](./loadtest/README.md). Short version:

```sh
npm run build && npm run loadtarget    # term A: server as load target (fake grader)
npm run loadtest                       # term B: ~4min ship-gate profile (k6 required)
```

Profiles: `smoke` (~40s) · `short` (~4m gate) · `full` (~35m, 3 staggered
classes + 10/s herd) · `shed` (deliberate overload). Or trigger the **Load
test** GitHub Action for a one-click run with an HTML report artifact.

## Deploy (Fly.io)

```sh
fly apps create goblins-grader && fly volumes create goblins_data -a goblins-grader --size 1
fly secrets set -a goblins-grader OPENROUTER_API_KEY=sk-or-...
fly deploy --ha=false                          # prod: real grader, 1 machine (SQLite = single writer)

fly apps create goblins-grader-staging && fly volumes create goblins_data_staging -a goblins-grader-staging --size 1
fly deploy -c fly.staging.toml --ha=false      # staging: fake grader, the load-test target
```

## Repo map

`server/src` — Effect API, queue/workers, graders · `client/src` — React pages
(teacher, join, whiteboard work loop) · `loadtest/` — k6 suite ·
`eval/` — golden-set accuracy eval + results · `scripts/seed.mjs` — demo data ·
`PLAN.md` — decisions, scope cuts, and six audit rounds.

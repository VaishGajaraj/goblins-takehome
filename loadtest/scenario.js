// Goblins grading-pipeline load test (k6).
//
//   k6 run -e PROFILE=smoke  loadtest/scenario.js   (~40s  — CI sanity / script check)
//   k6 run -e PROFILE=short  loadtest/scenario.js   (~4m   — the default ship gate)
//   k6 run -e PROFILE=full   loadtest/scenario.js   (~35m  — 3 staggered classes + herd)
//   k6 run -e PROFILE=shed   loadtest/scenario.js   (~5m   — overload: proves graceful shedding)
//
//   -e BASE_URL=https://goblins-grader-staging.fly.dev   (default http://localhost:3111,
//   which `npm run loadtarget` serves with load-friendly guards)
//
// Scenario model (PLAN.md Part 2): a class of ~30 students works through a
// multi-problem assignment inside a 20-minute window (~15-25 submissions/min
// steady), classes overlap at staggered starts, and the worst case is a
// thundering herd: a whole class dumping ~300 submissions in 30s (10/s).
// One iteration = one submission: submit → 202 → poll until graded.
//
// Honesty guards (see PLAN.md audit round 6): deterministic student+problem
// cycling keeps the app's attempt cap from silently eating load;
// dropped_iterations==0 proves k6 actually offered the scheduled arrivals;
// generous gracefulStop lets tail polls finish so lost_submissions is exact;
// teardownTimeout outlives the 3-min drain budget it measures.

import { sleep } from "k6"
import encoding from "k6/encoding"
import exec from "k6/execution"
import http from "k6/http"
import { Counter, Trend } from "k6/metrics"

const BASE = __ENV.BASE_URL || "http://localhost:3111"
const PROFILE = __ENV.PROFILE || "short"

// 429 is an *expected* protocol response (shed/caps), not a failure —
// http_req_failed then measures real failures only (5xx, timeouts).
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 204 }, 429))

const timeToGrade = new Trend("time_to_grade", true) // submit→graded, ms
const lost = new Counter("lost_submissions") // accepted (202) but no terminal status in time
const gradeFailed = new Counter("grade_failed") // terminal 'failed' (surfaced to teacher, not lost)
const shed = new Counter("shed_submissions") // 429 QueueFull
const shedWithoutHint = new Counter("shed_without_retry_hint") // QueueFull missing retryAfterSeconds
const attemptCapped = new Counter("attempt_capped") // 429 AttemptLimit (must stay 0: selection is deterministic)
const rateLimited = new Counter("rate_limited") // 429 RateLimited/Paused (staging disables those guards)
const queueDepth = new Trend("queue_depth") // sampled from /api/metrics (inside view)
const drainTimeout = new Counter("drain_timeout") // teardown: backlog not drained in budget

const PNG_B64 = encoding.b64encode(open("./fixtures/work.png", "b"))

// ---------- profiles ----------

const PROBLEMS = 10 // mirrors the PLAN arrival model (each student has ~10 problems)
const POLL_DELAYS_S = [1, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4] // ≈109s cap
const GRACEFUL_STOP = "150s" // let tail polls reach a terminal state (lost_submissions stays exact)

const classScenario = (startTime, stages) => ({
  executor: "ramping-arrival-rate",
  exec: "submitFlow",
  startTime,
  timeUnit: "1m",
  startRate: 0,
  preAllocatedVUs: 40,
  maxVUs: 150,
  gracefulStop: GRACEFUL_STOP,
  stages,
  tags: { load: "steady" }
})

const herdScenario = (startTime, ratePerSec, seconds, maxVUs) => ({
  executor: "constant-arrival-rate",
  exec: "submitFlow",
  startTime,
  rate: ratePerSec,
  timeUnit: "1s",
  duration: `${seconds}s`,
  preAllocatedVUs: Math.min(200, maxVUs),
  maxVUs, // must cover rate × poll-tail so k6 never throttles offered load
  gracefulStop: GRACEFUL_STOP,
  tags: { load: "herd" }
})

const observerScenario = (duration) => ({
  executor: "constant-vus",
  exec: "observer",
  vus: 1,
  duration,
  tags: { load: "observer" }
})

const classStages = [
  { target: 15, duration: "3m" },
  { target: 25, duration: "12m" },
  { target: 0, duration: "5m" }
]

const PROFILES = {
  // Script-mechanics sanity: small constant load + a 5s herd blip.
  smoke: {
    students: 10,
    drainWaitS: 30,
    hasSteady: true,
    scenarios: {
      steady: {
        executor: "constant-arrival-rate",
        exec: "submitFlow",
        rate: 2,
        timeUnit: "1s",
        duration: "20s",
        preAllocatedVUs: 20,
        maxVUs: 60,
        gracefulStop: GRACEFUL_STOP,
        tags: { load: "steady" }
      },
      herd_blip: herdScenario("21s", 6, 5, 60),
      observer: observerScenario("28s")
    }
  },
  // Compressed testing-day: one class at ~2x pace, then the herd.
  short: {
    students: 30,
    drainWaitS: 180,
    hasSteady: true,
    scenarios: {
      class_a: classScenario("0s", [
        { target: 40, duration: "45s" },
        { target: 60, duration: "75s" },
        { target: 0, duration: "30s" }
      ]),
      thundering_herd: herdScenario("2m45s", 10, 30, 450),
      observer: observerScenario("3m30s")
    }
  },
  // The real testing-day shape: 3 staggered classes + herd.
  full: {
    students: 90,
    drainWaitS: 180,
    hasSteady: true,
    scenarios: {
      class_a: classScenario("0s", classStages),
      class_b: classScenario("5m", classStages),
      class_c: classScenario("10m", classStages),
      thundering_herd: herdScenario("30m30s", 10, 30, 450),
      observer: observerScenario("31m30s")
    }
  },
  // Deliberate overload: arrivals ≫ service rate so the bounded queue must
  // fill and shed. Passing = sheds happen, every shed carries the retry hint,
  // zero lost, zero 5xx, and the backlog still drains inside the budget.
  shed: {
    students: 30,
    drainWaitS: 240,
    hasSteady: false,
    expectShed: true,
    scenarios: {
      // maxVUs sized for the worst case: every accepted submission polls the
      // full ~109s ladder while shed iterations churn — 800 proved too small
      // (97 dropped iterations in the first staging run; the gate caught it).
      overload: herdScenario("0s", 25, 30, 2000),
      observer: observerScenario("45s")
    }
  }
}

const profile = PROFILES[PROFILE]
if (!profile) throw new Error(`unknown PROFILE "${PROFILE}" (smoke|short|full|shed)`)

// Disjoint-ish starting offsets per scenario so concurrent scenarios cycle
// different regions of the (student × problem) space — no pair can exceed the
// app's 3-attempt cap (audit round 6, finding F2).
const PAIR_OFFSETS = {
  steady: 0,
  herd_blip: 50,
  class_a: 0,
  class_b: 325,
  class_c: 650,
  thundering_herd: 150,
  overload: 0
}

const thresholds = {
  // Ship gates (PLAN.md Part 2). Steady-state latency gates exclude the
  // herd by design — the herd is gated on graceful shed + full drain.
  "http_req_failed": [{ threshold: "rate<0.01", abortOnFail: true, delayAbortEval: "30s" }],
  "lost_submissions": ["count==0"],
  "shed_without_retry_hint": ["count==0"],
  "attempt_capped": ["count==0"], // deterministic selection ⇒ any cap-trip means the harness lied
  "rate_limited": ["count==0"],
  "drain_timeout": ["count==0"],
  "dropped_iterations": ["count==0"] // k6 must actually offer the scheduled load
}
if (profile.hasSteady) {
  thresholds["http_req_duration{endpoint:submit,load:steady}"] = ["p(95)<500"]
  thresholds["time_to_grade{load:steady}"] = ["p(95)<15000", "p(99)<45000"]
}
if (profile.expectShed) {
  thresholds["shed_submissions"] = ["count>0"] // overload run is only valid if it actually shed
}

export const options = {
  scenarios: profile.scenarios,
  thresholds,
  setupTimeout: "120s",
  teardownTimeout: "300s", // must outlive the drain budget it measures (audit F1)
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"]
}

// ---------- lifecycle ----------

const jsonHeaders = { "Content-Type": "application/json" }

export function setup() {
  const problems = Array.from({ length: PROBLEMS }, (_, i) => ({
    statement: `Load-test problem ${i + 1}: compute ${i + 1}/12 + 1/12 and simplify. Show your steps.`,
    maxPoints: 10
  }))
  const created = http.post(
    `${BASE}/api/assignments`,
    JSON.stringify({ title: `Load test ${new Date().toISOString()}`, problems }),
    { headers: jsonHeaders, tags: { endpoint: "setup" } }
  )
  if (created.status !== 200) throw new Error(`setup: create assignment failed: ${created.status} ${created.body}`)
  const assignment = created.json()

  const students = []
  for (let i = 0; i < profile.students; i++) {
    const joined = http.post(
      `${BASE}/api/join`,
      JSON.stringify({ code: assignment.joinCode, name: `LoadStudent ${i + 1}`, mode: "new" }),
      { headers: jsonHeaders, tags: { endpoint: "setup" } }
    )
    if (joined.status !== 200) throw new Error(`setup: join ${i + 1} failed: ${joined.status}`)
    students.push(joined.json().studentId)
  }
  // problems (with ids) come from a resume-join of the first student
  const firstJoin = http.post(
    `${BASE}/api/join`,
    JSON.stringify({ code: assignment.joinCode, name: "LoadStudent 1", mode: "resume" }),
    { headers: jsonHeaders, tags: { endpoint: "setup" } }
  )
  if (firstJoin.status !== 200) throw new Error(`setup: problem fetch failed: ${firstJoin.status}`)
  return {
    students,
    problems: firstJoin.json().problems.map((p) => p.id),
    teacherSecret: assignment.teacherSecret
  }
}

export function submitFlow(data) {
  // Deterministic pair selection: cycle the (student × problem) space from a
  // per-scenario offset instead of sampling with replacement.
  const totalPairs = data.students.length * data.problems.length
  const offset = PAIR_OFFSETS[exec.scenario.name] || 0
  const idx = (exec.scenario.iterationInTest + offset) % totalPairs
  const studentId = data.students[idx % data.students.length]
  const problemId = data.problems[Math.floor(idx / data.students.length)]

  const res = http.post(
    `${BASE}/api/submissions`,
    JSON.stringify({ studentId, problemId, imageBase64: PNG_B64 }),
    { headers: jsonHeaders, tags: { endpoint: "submit" } }
  )

  if (res.status === 429) {
    try {
      const body = res.json()
      const tag = body._tag || ""
      if (tag === "QueueFullError") {
        shed.add(1)
        if (typeof body.retryAfterSeconds !== "number") shedWithoutHint.add(1)
      } else if (tag === "AttemptLimitError") attemptCapped.add(1)
      else if (tag === "RateLimitedError" || tag === "PausedError") rateLimited.add(1)
    } catch (_) {
      shedWithoutHint.add(1)
    }
    return
  }
  if (res.status !== 202) return // http_req_failed already counts it

  const submissionId = res.json().submissionId
  const t0 = Date.now()
  for (const delay of POLL_DELAYS_S) {
    sleep(delay)
    const poll = http.get(`${BASE}/api/submissions/${submissionId}`, {
      tags: { endpoint: "poll" }
    })
    if (poll.status !== 200) continue // transient; keep polling until delays run out
    const status = poll.json().status
    if (status === "graded") {
      timeToGrade.add(Date.now() - t0)
      return
    }
    if (status === "failed") {
      gradeFailed.add(1)
      return
    }
  }
  lost.add(1) // accepted but never reached a terminal state within ~109s
}

export function observer() {
  const res = http.get(`${BASE}/api/metrics`, { tags: { endpoint: "metrics" } })
  if (res.status === 200) queueDepth.add(res.json().queueSize)
  sleep(5)
}

// After the load: the backlog must fully drain within the recovery budget.
export function teardown() {
  const deadline = Date.now() + profile.drainWaitS * 1000
  for (;;) {
    const res = http.get(`${BASE}/api/metrics`, { tags: { endpoint: "metrics" } })
    if (res.status === 200) {
      const by = res.json().byStatus
      const backlog = (by.queued || 0) + (by.grading || 0)
      if (backlog === 0) return
    }
    if (Date.now() > deadline) {
      drainTimeout.add(1)
      return
    }
    sleep(3)
  }
}

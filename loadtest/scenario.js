// Goblins grading-pipeline load test (k6).
//
//   k6 run -e PROFILE=smoke  loadtest/scenario.js   (~40s  — CI sanity / script check)
//   k6 run -e PROFILE=short  loadtest/scenario.js   (~4m   — the default ship gate)
//   k6 run -e PROFILE=full   loadtest/scenario.js   (~30m  — 3 staggered classes + herd)
//
//   -e BASE_URL=https://goblins-grader-staging.fly.dev   (default http://localhost:3111)
//
// Target must run GRADER_BACKEND=fake (free, latency-realistic). See loadtest/README.md.
//
// Scenario model (PLAN.md Part 2): a class of ~30 students works through a
// multi-problem assignment inside a 20-minute window (~15-25 submissions/min
// steady), classes overlap at staggered starts, and the worst case is a
// thundering herd: a whole class dumping ~300 submissions in 30s (10/s).
// One iteration = one submission: submit → 202 → poll until graded.

import { sleep } from "k6"
import encoding from "k6/encoding"
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
const shedWithoutHint = new Counter("shed_without_retry_hint") // 429 QueueFull missing retryAfterSeconds
const attemptCapped = new Counter("attempt_capped") // 429 AttemptLimit (scenario randomness artifact)
const rateLimited = new Counter("rate_limited") // 429 RateLimited (must be 0: staging disables per-IP cap)
const queueDepth = new Trend("queue_depth") // sampled from /api/metrics (inside view)

const PNG_B64 = encoding.b64encode(open("./fixtures/work.png", "b"))

// ---------- profiles ----------

const CLASS_STUDENTS = 30
const POLL_DELAYS_S = [1, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4] // ≈109s cap

const classScenario = (startTime, stages) => ({
  executor: "ramping-arrival-rate",
  exec: "submitFlow",
  startTime,
  timeUnit: "1m",
  startRate: 0,
  preAllocatedVUs: 40,
  maxVUs: 150,
  stages,
  tags: { load: "steady" }
})

const herdScenario = (startTime, ratePerSec, seconds) => ({
  executor: "constant-arrival-rate",
  exec: "submitFlow",
  startTime,
  rate: ratePerSec,
  timeUnit: "1s",
  duration: `${seconds}s`,
  preAllocatedVUs: 150,
  maxVUs: 400,
  tags: { load: "herd" }
})

const observerScenario = (duration) => ({
  executor: "constant-vus",
  exec: "observer",
  vus: 1,
  duration,
  tags: { load: "observer" }
})

const PROFILES = {
  // Script-mechanics sanity: small constant load + a 5s herd blip.
  smoke: {
    students: 10,
    drainWaitS: 30,
    scenarios: {
      steady: {
        executor: "constant-arrival-rate",
        exec: "submitFlow",
        rate: 2,
        timeUnit: "1s",
        duration: "20s",
        preAllocatedVUs: 20,
        maxVUs: 60,
        tags: { load: "steady" }
      },
      herd_blip: herdScenario("21s", 6, 5),
      observer: observerScenario("28s")
    }
  },
  // Compressed testing-day: one class at ~2x pace, then the herd.
  short: {
    students: CLASS_STUDENTS,
    drainWaitS: 180,
    scenarios: {
      class_a: classScenario("0s", [
        { target: 40, duration: "45s" },
        { target: 60, duration: "75s" },
        { target: 0, duration: "30s" }
      ]),
      thundering_herd: herdScenario("2m45s", 10, 30),
      observer: observerScenario("3m30s")
    }
  },
  // The real testing-day shape: 3 staggered classes + herd.
  full: {
    students: 3 * CLASS_STUDENTS,
    drainWaitS: 180,
    scenarios: {
      class_a: classScenario("0s", [
        { target: 15, duration: "3m" },
        { target: 25, duration: "12m" },
        { target: 0, duration: "5m" }
      ]),
      class_b: classScenario("5m", [
        { target: 15, duration: "3m" },
        { target: 25, duration: "12m" },
        { target: 0, duration: "5m" }
      ]),
      class_c: classScenario("10m", [
        { target: 15, duration: "3m" },
        { target: 25, duration: "12m" },
        { target: 0, duration: "5m" }
      ]),
      thundering_herd: herdScenario("30m30s", 10, 30),
      observer: observerScenario("31m30s")
    }
  }
}

const profile = PROFILES[PROFILE]
if (!profile) throw new Error(`unknown PROFILE "${PROFILE}" (smoke|short|full)`)

export const options = {
  scenarios: profile.scenarios,
  thresholds: {
    // Ship gates (PLAN.md Part 2). Steady-state latency gates exclude the
    // herd by design — the herd is gated on graceful shed + full drain.
    "http_req_duration{endpoint:submit,load:steady}": ["p(95)<500"],
    "http_req_failed": [{ threshold: "rate<0.01", abortOnFail: true, delayAbortEval: "30s" }],
    "time_to_grade{load:steady}": ["p(95)<15000", "p(99)<45000"],
    "lost_submissions": ["count==0"],
    "shed_without_retry_hint": ["count==0"],
    "rate_limited": ["count==0"],
    "drain_timeout": ["count==0"]
  },
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"]
}

const drainTimeout = new Counter("drain_timeout")

// ---------- lifecycle ----------

const jsonHeaders = { "Content-Type": "application/json" }

export function setup() {
  const problems = [1, 2, 3, 4].map((n) => ({
    statement: `Load-test problem ${n}: compute ${n}/6 + 1/6 and simplify. Show your steps.`,
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
    if (joined.status !== 200) throw new Error(`setup: join failed: ${joined.status}`)
    students.push(joined.json().studentId)
  }
  // problems (with ids) come from a resume-join of the first student
  const firstJoin = http.post(
    `${BASE}/api/join`,
    JSON.stringify({ code: assignment.joinCode, name: "LoadStudent 1", mode: "resume" }),
    { headers: jsonHeaders, tags: { endpoint: "setup" } }
  )
  return {
    students,
    problems: firstJoin.json().problems.map((p) => p.id),
    teacherSecret: assignment.teacherSecret
  }
}

export function submitFlow(data) {
  const studentId = data.students[Math.floor(Math.random() * data.students.length)]
  const problemId = data.problems[Math.floor(Math.random() * data.problems.length)]

  const res = http.post(
    `${BASE}/api/submissions`,
    JSON.stringify({ studentId, problemId, imageBase64: PNG_B64 }),
    { headers: jsonHeaders, tags: { endpoint: "submit" } }
  )

  if (res.status === 429) {
    let tag = ""
    try {
      const body = res.json()
      tag = body._tag || ""
      if (tag === "QueueFullError") {
        shed.add(1)
        if (typeof body.retryAfterSeconds !== "number") shedWithoutHint.add(1)
      } else if (tag === "AttemptLimitError") attemptCapped.add(1)
      else if (tag === "RateLimitedError") rateLimited.add(1)
      else if (tag === "PausedError") rateLimited.add(1) // daily cap must never trip on staging
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

export function observer(data) {
  const res = http.get(`${BASE}/api/metrics`, { tags: { endpoint: "metrics" } })
  if (res.status === 200) queueDepth.add(res.json().queueSize)
  sleep(5)
}

// After the herd: the backlog must fully drain within the recovery budget.
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

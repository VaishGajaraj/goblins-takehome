#!/usr/bin/env node
// Real-path concurrency sample: fires a burst of submissions at a
// GRADER_BACKEND=real target and measures submit→graded latency.
// Not a substitute for the k6 suite — a calibration/evidence run for the
// real model path under concurrent load. Costs ~$0.002 per submission.
//
//   BASE_URL=http://localhost:3161 BURST=40 node scripts/real-burst.mjs

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const BASE = process.env.BASE_URL || "http://localhost:3161"
const BURST = Number(process.env.BURST || 40)
const here = dirname(fileURLToPath(import.meta.url))
const png = readFileSync(join(here, "..", "loadtest", "fixtures", "work-small.png")).toString("base64")

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 120)}`)
  return r.json()
}

const a = await post("/api/assignments", {
  title: `real-burst ${Date.now()}`,
  problems: [{ statement: "Compute 2/8 + 3/8 and simplify. Show your steps.", maxPoints: 10 }]
})
const students = []
for (let i = 0; i < Math.min(BURST, 40); i++) {
  const j = await post("/api/join", { code: a.joinCode, name: `Burst ${i + 1}`, mode: "new" })
  students.push({ id: j.studentId, problem: j.problems[0].id })
}

// fire the burst over ~8s (roughly 5/s) and poll each to a terminal state
const results = await Promise.all(
  students.map(
    (s, i) =>
      new Promise((resolve) => {
        setTimeout(async () => {
          const t0 = Date.now()
          try {
            const sub = await post("/api/submissions", {
              studentId: s.id,
              problemId: s.problem,
              imageBase64: png
            })
            const acceptMs = Date.now() - t0
            for (let p = 0; p < 40; p++) {
              await new Promise((r) => setTimeout(r, 1000))
              const d = await fetch(`${BASE}/api/submissions/${sub.submissionId}`).then((r) => r.json())
              if (d.status === "graded" || d.status === "failed") {
                return resolve({ ok: d.status === "graded", score: d.score, acceptMs, totalMs: Date.now() - t0 })
              }
            }
            resolve({ ok: false, timeout: true, acceptMs, totalMs: Date.now() - t0 })
          } catch (e) {
            resolve({ ok: false, error: String(e).slice(0, 100), totalMs: Date.now() - t0 })
          }
        }, i * 200)
      })
  )
)

const graded = results.filter((r) => r.ok)
const times = graded.map((r) => r.totalMs).sort((x, y) => x - y)
const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]
console.log(JSON.stringify({
  burst: students.length,
  graded: graded.length,
  failedOrTimeout: results.length - graded.length,
  scores: [...new Set(graded.map((r) => r.score))],
  acceptP95Ms: results.map((r) => r.acceptMs ?? 0).sort((a2, b) => a2 - b)[Math.floor(results.length * 0.95)],
  timeToGrade: { p50Ms: pct(50), p95Ms: pct(95), maxMs: times[times.length - 1] }
}, null, 1))

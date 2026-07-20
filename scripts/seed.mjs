#!/usr/bin/env node
// Seed a demo class through the public API so a reviewer's first open shows a
// living report: 3 students with graded work on the sample assignment.
//
//   node scripts/seed.mjs                     (against http://localhost:3000)
//   BASE_URL=https://your-app.fly.dev node scripts/seed.mjs
//
// Uses whatever grader the target runs (fake locally = free + instant;
// real = a few cents and ~real feedback on the seeded images).

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const BASE = process.env.BASE_URL || "http://localhost:3000"
const here = dirname(fileURLToPath(import.meta.url))
const img = (name) => readFileSync(join(here, "..", "eval", "fixtures", name)).toString("base64")

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}
const get = async (path) => {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

const assignment = await post("/api/assignments", {
  title: "Fractions check-in (sample)",
  problems: [
    { statement: "Compute 2/3 + 1/6. Show each step and simplify your answer.", maxPoints: 10 },
    { statement: "Which is bigger: 5/8 or 2/3? Explain how you know without a calculator.", maxPoints: 10 }
  ]
})
console.log(`assignment created — join code ${assignment.joinCode}`)

// student -> [image for problem 1, image for problem 2]
const roster = [
  ["Maya", ["p1_correct_clean.png", "p2_correct_clean.png"]],
  ["Jordan", ["p1_partial.png", "p2_correct_messy.png"]],
  ["Sam", ["p1_wrong.png", "p2_partial.png"]]
]

const submissionIds = []
for (const [name, images] of roster) {
  const joined = await post("/api/join", { code: assignment.joinCode, name, mode: "new" })
  for (let p = 0; p < images.length; p++) {
    const sub = await post("/api/submissions", {
      studentId: joined.studentId,
      problemId: joined.problems[p].id,
      imageBase64: img(images[p])
    })
    submissionIds.push(sub.submissionId)
  }
  console.log(`${name}: 2 submissions in`)
}

process.stdout.write("grading")
const deadline = Date.now() + 120_000
while (Date.now() < deadline) {
  const statuses = await Promise.all(submissionIds.map((id) => get(`/api/submissions/${id}`)))
  const done = statuses.filter((s) => s.status === "graded" || s.status === "failed").length
  process.stdout.write(".")
  if (done === submissionIds.length) break
  await new Promise((r) => setTimeout(r, 1500))
}
console.log(" done\n")
console.log(`teacher report : ${BASE}/t/${assignment.teacherSecret}`)
console.log(`student join   : ${BASE}/join/${assignment.joinCode}`)

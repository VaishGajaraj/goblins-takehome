#!/usr/bin/env node
// Golden-set accuracy eval: grades the 10 fixture whiteboards with candidate
// models through the SAME code path production uses (server/dist/Grader.js —
// same system prompt, json_schema, clamping), then scores against ground truth.
//
//   OPENROUTER_API_KEY=... node eval/run-eval.mjs
//
// Cost: 10 images x 2 models ~ $0.03. Build the server first (npm run build).

import { Effect, Redacted } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeRealGrade } from "../server/dist/Grader.js"

const here = dirname(fileURLToPath(import.meta.url))
const gt = JSON.parse(readFileSync(join(here, "ground-truth.json"), "utf8"))
const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error("OPENROUTER_API_KEY required")
  process.exit(1)
}

const MODELS = (process.env.EVAL_MODELS || "google/gemini-3-flash-preview,google/gemini-2.5-flash-lite").split(",")

const gradeCase = async (model, grade, c) => {
  const p = gt.problems[c.problem]
  const t0 = Date.now()
  try {
    const r = await Effect.runPromise(
      grade({
        statement: p.statement,
        rubric: p.rubric,
        maxPoints: p.maxPoints,
        imagePath: join(here, "fixtures", c.file)
      })
    )
    console.log(`${model}  ${c.file}  expected=${c.expected} got=${r.score}  (${Date.now() - t0}ms)`)
    return {
      model,
      file: c.file,
      expected: c.expected,
      got: r.score,
      err: Math.abs(r.score - c.expected),
      ms: Date.now() - t0,
      feedback: r.feedback.slice(0, 120)
    }
  } catch (e) {
    console.log(`${model}  ${c.file}  ERROR ${String(e).slice(0, 120)}`)
    return { model, file: c.file, expected: c.expected, got: null, err: null, ms: Date.now() - t0, error: String(e).slice(0, 200) }
  }
}

const results = []
for (const model of MODELS) {
  // fallback = same model so results aren't cross-contaminated;
  // all 10 fixtures graded concurrently
  const grade = makeRealGrade(Redacted.make(key), model, model)
  results.push(...(await Promise.all(gt.cases.map((c) => gradeCase(model, grade, c)))))
}

const summary = MODELS.map((model) => {
  const rs = results.filter((r) => r.model === model && r.got !== null)
  const inj = rs.filter((r) => r.file.includes("injection"))
  const mae = rs.reduce((a, r) => a + r.err, 0) / (rs.length || 1)
  const within1 = rs.filter((r) => r.err <= 1).length
  return {
    model,
    graded: rs.length,
    mae: Number(mae.toFixed(2)),
    within1of10: `${within1}/${rs.length}`,
    injectionScores: inj.map((r) => r.got),
    p50ms: rs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)] ?? null
  }
})

writeFileSync(join(here, "results.json"), JSON.stringify({ ranAt: new Date().toISOString(), summary, results }, null, 2))
console.log("\n== summary ==")
console.table(summary)
console.log("full detail -> eval/results.json")

import { HttpApiBuilder } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import { GoblinsApi } from "./Api.js"
import { AppConfig } from "./Config.js"
import {
  AttemptLimitError,
  CriteriaHits,
  InvalidImageError,
  NotFoundError,
  PausedError,
  QueueFullError
} from "./Domain.js"
import { GradingQueue } from "./GradingQueue.js"
import { newId } from "./Ids.js"

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const studentSubmissions = (sql: SqlClient.SqlClient, studentId: string) =>
  sql`
    SELECT id, problem_id, attempt, status, score, feedback
    FROM submissions WHERE student_id = ${studentId} ORDER BY created_at`.pipe(
    Effect.map((rows) =>
      rows.map((s) => ({
        id: s.id as string,
        problemId: s.problem_id as string,
        attempt: s.attempt as number,
        status: s.status as "queued" | "grading" | "graded" | "failed",
        score: (s.score ?? null) as number | null,
        feedback: (s.feedback ?? null) as string | null
      }))
    )
  )

export const StudentLive = HttpApiBuilder.group(GoblinsApi, "student", (handlers) =>
  handlers
    .handle("join", ({ payload }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const code = payload.code.trim().toUpperCase()
        const name = payload.name.trim()

        const assignments = yield* sql`
          SELECT id, title FROM assignments WHERE join_code = ${code}`.pipe(Effect.orDie)
        const a = assignments[0]
        if (a === undefined) {
          return yield* new NotFoundError({ message: "That class code doesn't match any assignment" })
        }
        const assignmentId = a.id as string

        const joined = (studentId: string, studentName: string) =>
          Effect.gen(function* () {
            const problems = yield* sql`
              SELECT id, position, statement, max_points FROM problems
              WHERE assignment_id = ${assignmentId} ORDER BY position`
            const submissions = yield* studentSubmissions(sql, studentId)
            return {
              kind: "joined" as const,
              studentId,
              studentName,
              assignmentTitle: a.title as string,
              problems: problems.map((p) => ({
                id: p.id as string,
                position: p.position as number,
                statement: p.statement as string,
                maxPoints: p.max_points as number
              })),
              submissions
            }
          }).pipe(Effect.orDie)

        const existing = yield* sql`
          SELECT id, name, created_at FROM students
          WHERE assignment_id = ${assignmentId} AND name = ${name}`.pipe(Effect.orDie)
        const ex = existing[0]

        if (ex !== undefined && payload.mode === undefined) {
          const ageMin = Math.max(0, Math.round((Date.now() / 1000 - (ex.created_at as number)) / 60))
          return { kind: "nameTaken" as const, startedMinutesAgo: ageMin }
        }
        if (ex !== undefined && payload.mode === "resume") {
          return yield* joined(ex.id as string, ex.name as string)
        }

        // brand-new name, or mode === "new" (same name, different kid → suffix)
        let finalName = name
        if (ex !== undefined) {
          for (let n = 2; ; n++) {
            const candidate = `${name} (${n})`
            const clash = yield* sql`
              SELECT id FROM students WHERE assignment_id = ${assignmentId} AND name = ${candidate}`.pipe(
              Effect.orDie
            )
            if (clash.length === 0) {
              finalName = candidate
              break
            }
          }
        }
        const studentId = yield* newId
        yield* sql`
          INSERT INTO students (id, assignment_id, name)
          VALUES (${studentId}, ${assignmentId}, ${finalName})`.pipe(Effect.orDie)
        return yield* joined(studentId, finalName)
      })
    )
    .handle("submit", ({ payload }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const queue = yield* GradingQueue
        const attemptCap = yield* AppConfig.attemptCap.pipe(Effect.orDie)
        const dailyCap = yield* AppConfig.dailySubmissionCap.pipe(Effect.orDie)
        const dataDir = yield* AppConfig.dataDir.pipe(Effect.orDie)

        // student + problem must belong together
        const rows = yield* sql`
          SELECT st.id AS student_id, p.id AS problem_id
          FROM students st
          JOIN problems p ON p.assignment_id = st.assignment_id
          WHERE st.id = ${payload.studentId} AND p.id = ${payload.problemId}`.pipe(Effect.orDie)
        if (rows.length === 0) {
          return yield* new NotFoundError({ message: "Unknown student or problem" })
        }

        // budget kill switch (per UTC day, across the whole app)
        const daily = yield* sql`
          SELECT COUNT(*) AS n FROM submissions
          WHERE created_at >= unixepoch('now', 'start of day')`.pipe(Effect.orDie)
        if (((daily[0]?.n as number) ?? 0) >= dailyCap) {
          return yield* new PausedError({
            message: "Grading is paused for today (daily limit reached). Your teacher can follow up tomorrow."
          })
        }

        // attempt cap per student+problem
        const attempts = yield* sql`
          SELECT COALESCE(MAX(attempt), 0) AS a FROM submissions
          WHERE student_id = ${payload.studentId} AND problem_id = ${payload.problemId}`.pipe(Effect.orDie)
        const attempt = (((attempts[0]?.a as number) ?? 0) + 1)
        if (attempt > attemptCap) {
          return yield* new AttemptLimitError({
            message: `You've used all ${attemptCap} tries for this problem — move on to the next one!`
          })
        }

        // decode + validate PNG
        const buf = Buffer.from(payload.imageBase64, "base64")
        if (buf.length < 100 || buf.length > 2_100_000 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
          return yield* new InvalidImageError({ message: "Whiteboard image is not a valid PNG (≤2MB)" })
        }

        const submissionId = yield* newId
        const imagePath = NodePath.join(dataDir, "images", `${submissionId}.png`)
        yield* Effect.try({
          try: () => NodeFs.writeFileSync(imagePath, buf),
          catch: () => new InvalidImageError({ message: "Could not store the image, try again" })
        })

        yield* sql`
          INSERT INTO submissions (id, student_id, problem_id, attempt, status, image_path)
          VALUES (${submissionId}, ${payload.studentId}, ${payload.problemId}, ${attempt}, 'queued', ${imagePath})`.pipe(
          Effect.orDie
        )

        const accepted = yield* queue.enqueue(submissionId)
        if (!accepted) {
          // shed cleanly: the submission was never accepted, so it doesn't
          // consume an attempt and doesn't count toward lost_submissions
          yield* sql`DELETE FROM submissions WHERE id = ${submissionId}`.pipe(Effect.ignore)
          yield* Effect.sync(() => NodeFs.unlinkSync(imagePath)).pipe(Effect.ignore)
          return yield* new QueueFullError({
            message: "The goblins are swamped — try again in a few seconds",
            retryAfterSeconds: 8
          })
        }

        return { submissionId, attempt }
      })
    )
    .handle("submission", ({ path }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`
          SELECT id, problem_id, attempt, status, score, feedback, criteria_hits
          FROM submissions WHERE id = ${path.id}`.pipe(Effect.orDie)
        const s = rows[0]
        if (s === undefined) {
          return yield* new NotFoundError({ message: "No such submission" })
        }
        let criteriaHits: typeof CriteriaHits.Type | null = null
        if (s.criteria_hits != null) {
          try {
            criteriaHits = Schema.decodeUnknownSync(CriteriaHits)(JSON.parse(s.criteria_hits as string))
          } catch {
            criteriaHits = null
          }
        }
        return {
          id: s.id as string,
          problemId: s.problem_id as string,
          attempt: s.attempt as number,
          status: s.status as "queued" | "grading" | "graded" | "failed",
          score: (s.score ?? null) as number | null,
          feedback: (s.feedback ?? null) as string | null,
          criteriaHits
        }
      })
    )
)

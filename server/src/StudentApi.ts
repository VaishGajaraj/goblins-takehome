import { HttpApiBuilder, HttpServerRequest } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect, Either, Schema } from "effect"
import * as NodeFsPromises from "node:fs/promises"
import * as NodePath from "node:path"
import { GoblinsApi } from "./Api.js"
import { AppConfig } from "./Config.js"
import {
  AttemptLimitError,
  CriteriaHits,
  InvalidImageError,
  NotFoundError,
  PausedError,
  QueueFullError,
  RateLimitedError
} from "./Domain.js"
import { GradingQueue } from "./GradingQueue.js"
import { newId } from "./Ids.js"
import { JoinRateLimit, SubmitRateLimit } from "./RateLimit.js"

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** SqlError buries driver detail in .cause — walk the chain for matching. */
const errorText = (e: unknown): string => {
  const parts: string[] = []
  let cur: unknown = e
  for (let i = 0; i < 5 && cur != null; i++) {
    parts.push(String((cur as { message?: string }).message ?? cur))
    cur = (cur as { cause?: unknown }).cause
  }
  return parts.join(" | ")
}

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

/** Client IP: Fly sets fly-client-ip; fall back for local/dev. */
const clientIp = (headers: Record<string, string | undefined>): string =>
  headers["fly-client-ip"] ?? headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? "local"

export const StudentLive = HttpApiBuilder.group(GoblinsApi, "student", (handlers) =>
  handlers
    .handle("classInfo", ({ path }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const limiter = yield* JoinRateLimit
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!(yield* limiter.allow(clientIp(request.headers as Record<string, string | undefined>)))) {
          return yield* new RateLimitedError({ message: "Too many tries — wait a minute and try again" })
        }
        const code = path.code.trim().toUpperCase()
        const rows = yield* sql`
          SELECT a.title, COUNT(p.id) AS n
          FROM assignments a LEFT JOIN problems p ON p.assignment_id = a.id
          WHERE a.join_code = ${code}
          GROUP BY a.id`.pipe(Effect.orDie)
        const a = rows[0]
        if (a === undefined) {
          return yield* new NotFoundError({ message: "That class code doesn't match any assignment" })
        }
        return { title: a.title as string, problemCount: a.n as number }
      })
    )
    .handle("join", ({ payload }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const limiter = yield* JoinRateLimit
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!(yield* limiter.allow(clientIp(request.headers as Record<string, string | undefined>)))) {
          return yield* new RateLimitedError({ message: "Too many tries — wait a minute and try again" })
        }
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

        // Brand-new name, or mode === "new" (same name, different kid → suffix).
        // Insert-with-retry: concurrent joins with the same candidate race on
        // UNIQUE(assignment_id, name); loser advances to the next suffix (audit fix).
        for (let n = ex !== undefined ? 2 : 1; n <= 50; n++) {
          const candidate = ex !== undefined || n > 1 ? `${name} (${n})` : name
          const studentId = yield* newId
          const inserted = yield* sql`
            INSERT INTO students (id, assignment_id, name)
            VALUES (${studentId}, ${assignmentId}, ${candidate})`.pipe(Effect.either)
          if (Either.isRight(inserted)) {
            return yield* joined(studentId, candidate)
          }
          const msg = errorText(inserted.left)
          if (!msg.includes("UNIQUE")) {
            return yield* Effect.die(inserted.left)
          }
          if (payload.mode === undefined) {
            // raced with an identical first-time join — treat like nameTaken
            return { kind: "nameTaken" as const, startedMinutesAgo: 0 }
          }
        }
        return yield* Effect.die(new Error("could not allocate a unique student name"))
      })
    )
    .handle("submit", ({ payload }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const queue = yield* GradingQueue
        const limiter = yield* SubmitRateLimit
        const request = yield* HttpServerRequest.HttpServerRequest
        const attemptCap = yield* AppConfig.attemptCap.pipe(Effect.orDie)
        const dailyCap = yield* AppConfig.dailySubmissionCap.pipe(Effect.orDie)
        const dataDir = yield* AppConfig.dataDir.pipe(Effect.orDie)

        // per-IP budget protection (Fly puts the client IP in fly-client-ip)
        const ip = clientIp(request.headers as Record<string, string | undefined>)
        if (!(yield* limiter.allow(ip))) {
          return yield* new RateLimitedError({ message: "Whoa, slow down a little — try again in a minute" })
        }

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

        // fast-path attempt check (authoritative check is the atomic INSERT below)
        const attempts = yield* sql`
          SELECT COALESCE(MAX(attempt), 0) AS a FROM submissions
          WHERE student_id = ${payload.studentId} AND problem_id = ${payload.problemId}`.pipe(Effect.orDie)
        if (((attempts[0]?.a as number) ?? 0) >= attemptCap) {
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
        const removeImage = Effect.promise(() => NodeFsPromises.unlink(imagePath).catch(() => {}))
        yield* Effect.tryPromise({
          try: () => NodeFsPromises.writeFile(imagePath, buf),
          catch: () => new InvalidImageError({ message: "Could not store the image, try again" })
        })

        // Atomic attempt allocation: SQLite serializes writers, so the
        // MAX(attempt)+1 inside the INSERT can't race; HAVING re-enforces the
        // cap under concurrency (audit fix — two rapid taps can't both slip in
        // past the cap or collide on UNIQUE(student, problem, attempt)).
        yield* sql`
          INSERT INTO submissions (id, student_id, problem_id, attempt, status, image_path)
          SELECT ${submissionId}, ${payload.studentId}, ${payload.problemId},
                 COALESCE(MAX(attempt), 0) + 1, 'queued', ${imagePath}
          FROM submissions
          WHERE student_id = ${payload.studentId} AND problem_id = ${payload.problemId}
          HAVING COALESCE(MAX(attempt), 0) < ${attemptCap}`.pipe(Effect.orDie)
        const inserted = yield* sql`
          SELECT attempt FROM submissions WHERE id = ${submissionId}`.pipe(Effect.orDie)
        const attemptRow = inserted[0]
        if (attemptRow === undefined) {
          yield* removeImage
          return yield* new AttemptLimitError({
            message: `You've used all ${attemptCap} tries for this problem — move on to the next one!`
          })
        }

        const accepted = yield* queue.enqueue(submissionId)
        if (!accepted) {
          // shed cleanly: never accepted → doesn't consume an attempt,
          // doesn't count toward lost_submissions
          yield* sql`DELETE FROM submissions WHERE id = ${submissionId}`.pipe(Effect.ignore)
          yield* removeImage
          return yield* new QueueFullError({
            message: "The goblins are swamped — try again in a few seconds",
            retryAfterSeconds: 8
          })
        }

        return { submissionId, attempt: attemptRow.attempt as number }
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

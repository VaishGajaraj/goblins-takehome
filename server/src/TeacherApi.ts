import { HttpApiBuilder, HttpServerRequest } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { GoblinsApi } from "./Api.js"
import { NotFoundError, RateLimitedError, Rubric } from "./Domain.js"
import { GradingQueue } from "./GradingQueue.js"
import { newId, newJoinCode, newSecret } from "./Ids.js"
import { ProblemGen } from "./ProblemGen.js"
import { JoinRateLimit } from "./RateLimit.js"
import { RubricGen } from "./RubricGen.js"

const parseRubric = (raw: unknown): Rubric => {
  try {
    return Schema.decodeUnknownSync(Rubric)(typeof raw === "string" ? JSON.parse(raw) : raw)
  } catch {
    return []
  }
}

export const TeacherLive = HttpApiBuilder.group(GoblinsApi, "teacher", (handlers) =>
  handlers
    .handle("draftProblems", ({ payload }) =>
      Effect.gen(function* () {
        // model call on a public endpoint → per-IP limited (shares the join
        // limiter budget; drafts are ~$0.001 each in real mode)
        const limiter = yield* JoinRateLimit
        const request = yield* HttpServerRequest.HttpServerRequest
        const headers = request.headers as Record<string, string | undefined>
        const ip = headers["fly-client-ip"] ?? headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? "local"
        if (!(yield* limiter.allow(ip))) {
          return yield* new RateLimitedError({ message: "Too many drafts — give it a minute" })
        }
        const gen = yield* ProblemGen
        const problems = yield* gen
          .draft({
            topic: payload.topic.trim(),
            gradeLevel: payload.gradeLevel.trim(),
            count: payload.count
          })
          .pipe(Effect.orDie) // ProblemGenLive already falls back to templates
        return { problems: [...problems] }
      })
    )
    .handle("createAssignment", ({ payload }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rubricGen = yield* RubricGen

        // One batch model call (or free deterministic template in fake mode).
        // RubricGenLive already degrades to the template on any failure.
        const rubrics = yield* rubricGen.generate(payload.title, payload.problems)

        const assignmentId = yield* newId
        const joinCode = yield* newJoinCode
        const teacherSecret = yield* newSecret

        // transactional: no half-created assignments behind a live join code (audit fix)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO assignments (id, title, join_code, teacher_secret)
              VALUES (${assignmentId}, ${payload.title}, ${joinCode}, ${teacherSecret})`
            for (let i = 0; i < payload.problems.length; i++) {
              const p = payload.problems[i]!
              const problemId = yield* newId
              yield* sql`
                INSERT INTO problems (id, assignment_id, position, statement, max_points, rubric)
                VALUES (${problemId}, ${assignmentId}, ${i}, ${p.statement}, ${p.maxPoints},
                        ${JSON.stringify(rubrics[i] ?? [])})`
            }
          })
        )

        return { id: assignmentId, joinCode, teacherSecret }
      }).pipe(Effect.orDie)
    )
    .handle("teacherView", ({ path }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const assignments = yield* sql`
          SELECT id, title, join_code, created_at FROM assignments
          WHERE teacher_secret = ${path.secret}`.pipe(Effect.orDie)
        const a = assignments[0]
        if (a === undefined) {
          return yield* new NotFoundError({ message: "No assignment for that link" })
        }
        const id = a.id as string

        const problems = yield* sql`
          SELECT id, position, statement, max_points, rubric FROM problems
          WHERE assignment_id = ${id} ORDER BY position`.pipe(Effect.orDie)
        const students = yield* sql`
          SELECT id, name, created_at FROM students
          WHERE assignment_id = ${id} ORDER BY created_at`.pipe(Effect.orDie)
        const submissions = yield* sql`
          SELECT s.id, s.student_id, s.problem_id, s.status, s.score, s.feedback,
                 s.created_at, s.graded_at
          FROM submissions s
          JOIN students st ON st.id = s.student_id
          WHERE st.assignment_id = ${id}
          ORDER BY s.created_at`.pipe(Effect.orDie)

        return {
          id,
          title: a.title as string,
          joinCode: a.join_code as string,
          createdAt: a.created_at as number,
          problems: problems.map((p) => ({
            id: p.id as string,
            position: p.position as number,
            statement: p.statement as string,
            maxPoints: p.max_points as number,
            rubric: parseRubric(p.rubric)
          })),
          students: students.map((s) => ({
            id: s.id as string,
            name: s.name as string,
            createdAt: s.created_at as number
          })),
          submissions: submissions.map((s) => ({
            id: s.id as string,
            studentId: s.student_id as string,
            problemId: s.problem_id as string,
            status: s.status as "queued" | "grading" | "graded" | "failed",
            score: (s.score ?? null) as number | null,
            feedback: (s.feedback ?? null) as string | null,
            createdAt: s.created_at as number,
            gradedAt: (s.graded_at ?? null) as number | null
          }))
        }
      })
    )
    .handle("updateRubric", ({ path, payload }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`
          SELECT p.id FROM problems p
          JOIN assignments a ON a.id = p.assignment_id
          WHERE a.teacher_secret = ${path.secret} AND p.id = ${path.problemId}`.pipe(Effect.orDie)
        if (rows.length === 0) {
          return yield* new NotFoundError({ message: "No such problem for that link" })
        }
        yield* sql`
          UPDATE problems SET rubric = ${JSON.stringify(payload.rubric)}
          WHERE id = ${path.problemId}`.pipe(Effect.orDie)
        return { ok: true }
      })
    )
    .handle("regradeFailed", ({ path }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const queue = yield* GradingQueue
        const assignments = yield* sql`
          SELECT id FROM assignments WHERE teacher_secret = ${path.secret}`.pipe(Effect.orDie)
        const a = assignments[0]
        if (a === undefined) {
          return yield* new NotFoundError({ message: "No assignment for that link" })
        }
        const failed = yield* sql`
          SELECT s.id FROM submissions s
          JOIN students st ON st.id = s.student_id
          WHERE st.assignment_id = ${a.id} AND s.status = 'failed'`.pipe(Effect.orDie)
        const ids = failed.map((r) => r.id as string)
        if (ids.length > 0) {
          yield* sql`
            UPDATE submissions SET status = 'queued', error = NULL
            WHERE id IN ${sql.in(ids)}`.pipe(Effect.orDie)
          // teacher-initiated, off the hot path → waiting enqueue, forked so
          // the response returns immediately
          yield* Effect.forkDaemon(Effect.forEach(ids, queue.enqueueWait, { discard: true }))
        }
        return { requeued: ids.length }
      })
    )
)

import { HttpApiBuilder } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { GoblinsApi } from "./Api.js"
import { NotFoundError, Rubric } from "./Domain.js"
import { newId, newJoinCode, newSecret } from "./Ids.js"
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
)

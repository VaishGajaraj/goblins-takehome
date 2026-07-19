import { SqlClient } from "@effect/sql"
import { Context, Duration, Effect, Layer, Queue, Schedule, Stream } from "effect"
import { AppConfig } from "./Config.js"
import { Rubric } from "./Domain.js"
import { Grader, GraderError } from "./Grader.js"
import { Schema } from "effect"

/**
 * The queue is only a DISPATCHER. SQLite rows (status column) are the source
 * of truth for job state; on boot every 'queued'/'grading' row is re-offered,
 * so restarts and deploys lose nothing (PLAN.md "Durability").
 */
export class GradingQueue extends Context.Tag("GradingQueue")<
  GradingQueue,
  {
    /** false = queue full → caller sheds with 429. */
    readonly enqueue: (submissionId: string) => Effect.Effect<boolean>
    readonly size: Effect.Effect<number>
    readonly capacity: number
  }
>() {}

export const GradingQueueLive = Layer.scoped(
  GradingQueue,
  Effect.gen(function* () {
    const capacity = yield* AppConfig.queueCapacity
    const queue = yield* Queue.dropping<string>(capacity)
    const sql = yield* SqlClient.SqlClient
    const grader = yield* Grader
    const concurrency = yield* AppConfig.graderConcurrency

    const parseRubric = (raw: unknown): Rubric => {
      try {
        return Schema.decodeUnknownSync(Rubric)(typeof raw === "string" ? JSON.parse(raw) : raw)
      } catch {
        return []
      }
    }

    const gradeOne = (submissionId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql`
          SELECT s.id, s.status, s.image_path, p.statement, p.max_points, p.rubric
          FROM submissions s JOIN problems p ON p.id = s.problem_id
          WHERE s.id = ${submissionId}`
        const row = rows[0]
        if (row === undefined || row.status === "graded") return
        yield* sql`
          UPDATE submissions SET status = 'grading', started_at = unixepoch()
          WHERE id = ${submissionId}`

        const result = yield* grader
          .grade({
            statement: row.statement as string,
            rubric: parseRubric(row.rubric),
            maxPoints: row.max_points as number,
            imagePath: row.image_path as string
          })
          .pipe(
            Effect.timeout("75 seconds"),
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
              while: (e) => e instanceof GraderError && e.retryable
            })
          )

        yield* sql`
          UPDATE submissions SET
            status = 'graded',
            score = ${result.score},
            feedback = ${result.feedback},
            criteria_hits = ${JSON.stringify(result.criteriaHits)},
            graded_at = unixepoch()
          WHERE id = ${submissionId}`
      }).pipe(
        // A permanently failed grade must never kill the worker stream.
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`grading failed for ${submissionId}: ${cause.toString().slice(0, 300)}`)
            yield* sql`
              UPDATE submissions SET status = 'failed', error = ${cause.toString().slice(0, 500)}
              WHERE id = ${submissionId} AND status != 'graded'`.pipe(Effect.ignore)
          })
        )
      )

    // Boot recovery: anything queued or mid-flight when the process died.
    const pending = yield* sql`
      SELECT id FROM submissions WHERE status IN ('queued', 'grading') ORDER BY created_at`
    if (pending.length > 0) {
      yield* Effect.logInfo(`requeueing ${pending.length} pending submission(s) from previous run`)
      yield* Effect.forEach(pending, (r) => Queue.offer(queue, r.id as string), { discard: true })
    }

    // Worker pool.
    yield* Stream.fromQueue(queue).pipe(
      Stream.mapEffect(gradeOne, { concurrency }),
      Stream.runDrain,
      Effect.forkScoped
    )
    yield* Effect.logInfo(`grading workers up: concurrency=${concurrency}, queueCapacity=${capacity}`)

    return {
      enqueue: (id: string) => Queue.offer(queue, id),
      // Queue.size is negative when takers are parked waiting — clamp for reporting
      size: Queue.size(queue).pipe(Effect.map((n) => Math.max(0, n))),
      capacity
    }
  })
)

/** Simple time-to-grade snapshot for /metrics (read by load-test writeup). */
export const metricsSnapshot = (sql: SqlClient.SqlClient, queueSize: number, queueCapacity: number) =>
  Effect.gen(function* () {
    const counts = yield* sql`
      SELECT status, COUNT(*) AS n FROM submissions GROUP BY status`
    const latency = yield* sql`
      SELECT COUNT(*) AS n, AVG(graded_at - created_at) AS avg_s, MAX(graded_at - created_at) AS max_s
      FROM submissions WHERE status = 'graded' AND graded_at IS NOT NULL`
    const byStatus: Record<string, number> = {}
    for (const c of counts) byStatus[c.status as string] = c.n as number
    const l = latency[0]
    return {
      queueSize,
      queueCapacity,
      byStatus,
      gradedCount: (l?.n as number) ?? 0,
      avgTimeToGradeSeconds: (l?.avg_s as number | null) ?? null,
      maxTimeToGradeSeconds: (l?.max_s as number | null) ?? null
    }
  })

export const durationToMs = (d: Duration.Duration): number => Duration.toMillis(d)

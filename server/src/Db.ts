import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import { AppConfig } from "./Config.js"

/**
 * SQLite is the source of truth for everything, including grading-job state
 * (see PLAN.md "Durability"). The in-memory queue only dispatches work.
 *
 * Schema is created idempotently at startup — deliberately simpler than the
 * Migrator machinery for a single-migration take-home.
 */
const ClientLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const dataDir = yield* AppConfig.dataDir
    yield* Effect.sync(() => NodeFs.mkdirSync(NodePath.join(dataDir, "images"), { recursive: true }))
    return SqliteClient.layer({ filename: NodePath.join(dataDir, "goblins.db") })
  })
)

const SchemaLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    // Concurrency hygiene: workers write while the report polls.
    yield* sql`PRAGMA journal_mode = WAL`
    yield* sql`PRAGMA busy_timeout = 5000`
    yield* sql`PRAGMA foreign_keys = ON`

    yield* sql`
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        join_code TEXT NOT NULL UNIQUE,
        teacher_secret TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`

    yield* sql`
      CREATE TABLE IF NOT EXISTS problems (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES assignments(id),
        position INTEGER NOT NULL,
        statement TEXT NOT NULL,
        max_points INTEGER NOT NULL DEFAULT 10,
        -- JSON [{ criterion: string, points: number }] — whole-rubric replace on edit
        rubric TEXT NOT NULL DEFAULT '[]'
      )`

    yield* sql`
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES assignments(id),
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE (assignment_id, name)
      )`

    yield* sql`
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES students(id),
        problem_id TEXT NOT NULL REFERENCES problems(id),
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'grading', 'graded', 'failed')),
        image_path TEXT,
        score REAL,
        feedback TEXT,
        criteria_hits TEXT,
        error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER,
        graded_at INTEGER,
        UNIQUE (student_id, problem_id, attempt)
      )`

    yield* sql`CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status)`
    yield* sql`CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions (problem_id)`
    yield* sql`CREATE INDEX IF NOT EXISTS idx_students_assignment ON students (assignment_id)`
  })
)

export const DbLive = SchemaLive.pipe(Layer.provideMerge(ClientLive))

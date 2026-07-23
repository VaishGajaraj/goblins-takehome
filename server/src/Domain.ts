import { Schema } from "effect"

// ---------- rubric ----------

export const RubricCriterion = Schema.Struct({
  criterion: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300)),
  points: Schema.Number.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(100))
})
export type RubricCriterion = typeof RubricCriterion.Type

export const Rubric = Schema.Array(RubricCriterion).pipe(Schema.maxItems(10))
export type Rubric = typeof Rubric.Type

export const CriteriaHits = Schema.Array(
  Schema.Struct({
    criterion: Schema.String,
    met: Schema.Boolean,
    pointsAwarded: Schema.Number
  })
)

// ---------- assignment creation ----------

export const ProblemInput = Schema.Struct({
  statement: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)),
  maxPoints: Schema.Number.pipe(Schema.int(), Schema.between(1, 100))
})
export type ProblemInput = typeof ProblemInput.Type

export const CreateAssignmentPayload = Schema.Struct({
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  problems: Schema.Array(ProblemInput).pipe(Schema.minItems(1), Schema.maxItems(20))
})

export const CreateAssignmentResult = Schema.Struct({
  id: Schema.String,
  joinCode: Schema.String,
  teacherSecret: Schema.String
})

// ---------- teacher view ----------

export const ProblemView = Schema.Struct({
  id: Schema.String,
  position: Schema.Number,
  statement: Schema.String,
  maxPoints: Schema.Number,
  rubric: Rubric
})

export const SubmissionSummary = Schema.Struct({
  id: Schema.String,
  studentId: Schema.String,
  problemId: Schema.String,
  status: Schema.Literal("queued", "grading", "graded", "failed"),
  score: Schema.NullOr(Schema.Number),
  feedback: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  gradedAt: Schema.NullOr(Schema.Number)
})

export const StudentView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number
})

export const TeacherView = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  joinCode: Schema.String,
  createdAt: Schema.Number,
  problems: Schema.Array(ProblemView),
  students: Schema.Array(StudentView),
  submissions: Schema.Array(SubmissionSummary)
})

export const TeacherSubmissionAttempt = Schema.Struct({
  id: Schema.String,
  attempt: Schema.Number,
  status: Schema.Literal("queued", "grading", "graded", "failed"),
  score: Schema.NullOr(Schema.Number),
  feedback: Schema.NullOr(Schema.String),
  criteriaHits: Schema.NullOr(CriteriaHits),
  createdAt: Schema.Number,
  gradedAt: Schema.NullOr(Schema.Number),
  /** PNG bytes encoded as base64; null only when the stored image is unavailable or invalid. */
  imageBase64: Schema.NullOr(Schema.String)
})

export const TeacherSubmissionDetail = Schema.Struct({
  selectedSubmissionId: Schema.String,
  student: StudentView,
  problem: ProblemView,
  attempts: Schema.Array(TeacherSubmissionAttempt)
})

export const UpdateRubricPayload = Schema.Struct({
  rubric: Rubric
})

// ---------- student flow ----------

export const JoinPayload = Schema.Struct({
  code: Schema.String.pipe(Schema.minLength(4), Schema.maxLength(10)),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(60)),
  /** omitted = first try; "resume" = same person; "new" = different person with same name */
  mode: Schema.optional(Schema.Literal("resume", "new"))
})

export const ProblemForStudent = Schema.Struct({
  id: Schema.String,
  position: Schema.Number,
  statement: Schema.String,
  maxPoints: Schema.Number
})

export const SubmissionForStudent = Schema.Struct({
  id: Schema.String,
  problemId: Schema.String,
  attempt: Schema.Number,
  status: Schema.Literal("queued", "grading", "graded", "failed"),
  score: Schema.NullOr(Schema.Number),
  feedback: Schema.NullOr(Schema.String)
})

export const JoinResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("joined"),
    studentId: Schema.String,
    studentName: Schema.String,
    assignmentTitle: Schema.String,
    problems: Schema.Array(ProblemForStudent),
    submissions: Schema.Array(SubmissionForStudent)
  }),
  Schema.Struct({
    kind: Schema.Literal("nameTaken"),
    startedMinutesAgo: Schema.Number
  })
)

export const SubmitPayload = Schema.Struct({
  studentId: Schema.String,
  problemId: Schema.String,
  /** PNG as base64 (≤ ~2MB decoded); client downscales to ≤1024px first */
  imageBase64: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(2_900_000))
})

export const SubmitResult = Schema.Struct({
  submissionId: Schema.String,
  attempt: Schema.Number
})

export const SubmissionDetail = Schema.Struct({
  id: Schema.String,
  problemId: Schema.String,
  attempt: Schema.Number,
  status: Schema.Literal("queued", "grading", "graded", "failed"),
  score: Schema.NullOr(Schema.Number),
  feedback: Schema.NullOr(Schema.String),
  criteriaHits: Schema.NullOr(CriteriaHits)
})

// ---------- metrics ----------

export const MetricsView = Schema.Struct({
  queueSize: Schema.Number,
  queueCapacity: Schema.Number,
  byStatus: Schema.Record({ key: Schema.String, value: Schema.Number }),
  gradedCount: Schema.Number,
  avgTimeToGradeSeconds: Schema.NullOr(Schema.Number),
  maxTimeToGradeSeconds: Schema.NullOr(Schema.Number)
})

// ---------- errors ----------

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String
}) {}

export class QueueFullError extends Schema.TaggedError<QueueFullError>()("QueueFullError", {
  message: Schema.String,
  retryAfterSeconds: Schema.Number
}) {}

export class AttemptLimitError extends Schema.TaggedError<AttemptLimitError>()("AttemptLimitError", {
  message: Schema.String
}) {}

export class PausedError extends Schema.TaggedError<PausedError>()("PausedError", {
  message: Schema.String
}) {}

export class InvalidImageError extends Schema.TaggedError<InvalidImageError>()("InvalidImageError", {
  message: Schema.String
}) {}

export class RateLimitedError extends Schema.TaggedError<RateLimitedError>()("RateLimitedError", {
  message: Schema.String
}) {}

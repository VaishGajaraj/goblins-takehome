import { Schema } from "effect"

// ---------- rubric ----------

export const RubricCriterion = Schema.Struct({
  criterion: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300)),
  points: Schema.Number.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(100))
})
export type RubricCriterion = typeof RubricCriterion.Type

export const Rubric = Schema.Array(RubricCriterion).pipe(Schema.maxItems(10))
export type Rubric = typeof Rubric.Type

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

export const UpdateRubricPayload = Schema.Struct({
  rubric: Rubric
})

// ---------- errors ----------

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String
}) {}

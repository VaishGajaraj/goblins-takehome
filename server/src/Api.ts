import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Schema } from "effect"
import {
  AttemptLimitError,
  CreateAssignmentPayload,
  CreateAssignmentResult,
  InvalidImageError,
  JoinPayload,
  JoinResult,
  MetricsView,
  NotFoundError,
  PausedError,
  QueueFullError,
  RateLimitedError,
  SubmissionDetail,
  SubmitPayload,
  SubmitResult,
  TeacherView,
  UpdateRubricPayload
} from "./Domain.js"

export const Health = Schema.Struct({
  ok: Schema.Boolean,
  db: Schema.Boolean,
  backend: Schema.String
})

/**
 * Single shared API definition — handlers implement it server-side and the
 * client can derive types from the same source. Student + metrics groups
 * arrive in M3/M5.
 */
export class GoblinsApi extends HttpApi.make("goblins")
  .add(
    HttpApiGroup.make("system")
      .add(HttpApiEndpoint.get("health", "/api/health").addSuccess(Health))
      .add(HttpApiEndpoint.get("metrics", "/api/metrics").addSuccess(MetricsView))
  )
  .add(
    HttpApiGroup.make("student")
      .add(
        // Public pre-join check: lets the join page reject bad codes before
        // showing a name form. Exposes nothing beyond title + problem count.
        HttpApiEndpoint.get("classInfo", "/api/class/:code")
          .setPath(Schema.Struct({ code: Schema.String }))
          .addSuccess(Schema.Struct({ title: Schema.String, problemCount: Schema.Number }))
          .addError(NotFoundError, { status: 404 })
          .addError(RateLimitedError, { status: 429 })
      )
      .add(
        HttpApiEndpoint.post("join", "/api/join")
          .setPayload(JoinPayload)
          .addSuccess(JoinResult)
          .addError(NotFoundError, { status: 404 })
          .addError(RateLimitedError, { status: 429 })
      )
      .add(
        HttpApiEndpoint.post("submit", "/api/submissions")
          .setPayload(SubmitPayload)
          .addSuccess(SubmitResult, { status: 202 })
          .addError(NotFoundError, { status: 404 })
          .addError(InvalidImageError, { status: 400 })
          .addError(AttemptLimitError, { status: 429 })
          .addError(PausedError, { status: 429 })
          .addError(QueueFullError, { status: 429 })
          .addError(RateLimitedError, { status: 429 })
      )
      .add(
        HttpApiEndpoint.get("submission", "/api/submissions/:id")
          .setPath(Schema.Struct({ id: Schema.String }))
          .addSuccess(SubmissionDetail)
          .addError(NotFoundError, { status: 404 })
      )
  )
  .add(
    HttpApiGroup.make("teacher")
      .add(
        HttpApiEndpoint.post("createAssignment", "/api/assignments")
          .setPayload(CreateAssignmentPayload)
          .addSuccess(CreateAssignmentResult)
      )
      .add(
        HttpApiEndpoint.get("teacherView", "/api/teacher/:secret")
          .setPath(Schema.Struct({ secret: Schema.String }))
          .addSuccess(TeacherView)
          .addError(NotFoundError, { status: 404 })
      )
      .add(
        HttpApiEndpoint.put("updateRubric", "/api/teacher/:secret/problems/:problemId/rubric")
          .setPath(Schema.Struct({ secret: Schema.String, problemId: Schema.String }))
          .setPayload(UpdateRubricPayload)
          .addSuccess(Schema.Struct({ ok: Schema.Boolean }))
          .addError(NotFoundError, { status: 404 })
      )
      .add(
        HttpApiEndpoint.post("regradeFailed", "/api/teacher/:secret/regrade-failed")
          .setPath(Schema.Struct({ secret: Schema.String }))
          .addSuccess(Schema.Struct({ requeued: Schema.Number }))
          .addError(NotFoundError, { status: 404 })
      )
  ) {}

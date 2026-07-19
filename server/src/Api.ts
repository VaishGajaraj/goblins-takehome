import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Schema } from "effect"
import {
  CreateAssignmentPayload,
  CreateAssignmentResult,
  NotFoundError,
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
    HttpApiGroup.make("system").add(
      HttpApiEndpoint.get("health", "/api/health").addSuccess(Health)
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
  ) {}

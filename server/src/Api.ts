import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Schema } from "effect"

export const Health = Schema.Struct({
  ok: Schema.Boolean,
  db: Schema.Boolean,
  backend: Schema.String
})

/**
 * Single shared API definition — handlers implement it server-side and the
 * client can derive types from the same source. Groups grow in M2/M3:
 * teacher (assignments/rubrics/report), student (join/submit/poll), metrics.
 */
export class GoblinsApi extends HttpApi.make("goblins").add(
  HttpApiGroup.make("system").add(
    HttpApiEndpoint.get("health", "/api/health").addSuccess(Health)
  )
) {}

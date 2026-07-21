import { HttpApiBuilder, HttpLayerRouter, HttpServerResponse } from "@effect/platform"
import { NodeContext, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import * as NodeFs from "node:fs"
import { createServer } from "node:http"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { GoblinsApi } from "./Api.js"
import { AppConfig } from "./Config.js"
import { DbLive } from "./Db.js"
import { GraderLive } from "./Grader.js"
import { GradingQueue, GradingQueueLive, metricsSnapshot } from "./GradingQueue.js"
import { JoinRateLimitLive, SubmitRateLimitLive } from "./RateLimit.js"
import { ProblemGenLive } from "./ProblemGen.js"
import { RubricGenLive } from "./RubricGen.js"
import { StudentLive } from "./StudentApi.js"
import { TeacherLive } from "./TeacherApi.js"

// ---------- handlers ----------

const SystemLive = HttpApiBuilder.group(GoblinsApi, "system", (handlers) =>
  handlers
    .handle("health", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`SELECT 1 AS one`
        const backend = yield* AppConfig.graderBackend
        return { ok: true, db: rows.length === 1, backend }
      }).pipe(Effect.orDie)
    )
    .handle("metrics", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const queue = yield* GradingQueue
        const size = yield* queue.size
        return yield* metricsSnapshot(sql, size, queue.capacity)
      }).pipe(Effect.orDie)
    )
)

// ---------- routes: API + SPA static fallback ----------

const ApiRoutes = HttpLayerRouter.addHttpApi(GoblinsApi, {
  openapiPath: "/api/openapi.json"
}).pipe(Layer.provide(Layer.mergeAll(SystemLive, TeacherLive, StudentLive)))

/**
 * Serve built client assets; unknown non-API GET paths fall back to
 * index.html so client-side routing works on refresh/deep links.
 */
/** repo-root/client/dist, anchored to this compiled file (server/dist/main.js) — cwd-independent */
const defaultStaticDir = NodePath.resolve(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "../../client/dist"
)

const StaticRoutes = HttpLayerRouter.use((router) =>
  Effect.gen(function* () {
    const staticDir = NodePath.resolve(
      Option.getOrElse(yield* AppConfig.staticDir, () => defaultStaticDir)
    )
    const indexPath = NodePath.join(staticDir, "index.html")
    const resolvePath = (rawUrl: string): string => {
      const pathname = decodeURIComponent(new URL(rawUrl, "http://localhost").pathname)
      const candidate = NodePath.resolve(NodePath.join(staticDir, pathname))
      if (!candidate.startsWith(staticDir)) return indexPath
      try {
        return NodeFs.statSync(candidate).isFile() ? candidate : indexPath
      } catch {
        return indexPath
      }
    }
    yield* router.add("GET", "/*", (request) =>
      HttpServerResponse.file(resolvePath(request.url)).pipe(
        Effect.orElse(() => HttpServerResponse.file(indexPath)),
        Effect.orDie
      )
    )
  })
)

// ---------- server ----------

const AllRoutes = Layer.mergeAll(ApiRoutes, StaticRoutes)

const HttpLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const port = yield* AppConfig.port
    return HttpLayerRouter.serve(AllRoutes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port }))
    )
  })
)

const MainLive = HttpLive.pipe(
  Layer.provide(GradingQueueLive),
  Layer.provide(GraderLive),
  Layer.provide(RubricGenLive),
  Layer.provide(ProblemGenLive),
  Layer.provide(SubmitRateLimitLive),
  Layer.provide(JoinRateLimitLive),
  Layer.provide(DbLive),
  Layer.provide(NodeContext.layer)
)

NodeRuntime.runMain(Layer.launch(MainLive))

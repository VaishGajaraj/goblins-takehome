import { Config, Context, Effect, Layer } from "effect"

/**
 * Tiny in-memory per-IP sliding-window limiter for the submit endpoint —
 * budget protection (PLAN.md Hardening), not general DDoS defense. At 10k+
 * scale this moves to the edge/redis; documented in the scaling ladder.
 */
export class SubmitRateLimit extends Context.Tag("SubmitRateLimit")<
  SubmitRateLimit,
  { readonly allow: (key: string) => Effect.Effect<boolean> }
>() {}

export const SubmitRateLimitLive = Layer.effect(
  SubmitRateLimit,
  Effect.gen(function* () {
    const perMinute = yield* Config.integer("SUBMIT_RATE_PER_MIN").pipe(Config.withDefault(30))
    const windows = new Map<string, { start: number; count: number }>()
    return {
      allow: (key: string) =>
        Effect.sync(() => {
          const now = Date.now()
          const w = windows.get(key)
          if (!w || now - w.start > 60_000) {
            // occasional prune so the map can't grow unbounded
            if (windows.size > 10_000) {
              for (const [k, v] of windows) if (now - v.start > 60_000) windows.delete(k)
            }
            windows.set(key, { start: now, count: 1 })
            return true
          }
          w.count += 1
          return w.count <= perMinute
        })
    }
  })
)

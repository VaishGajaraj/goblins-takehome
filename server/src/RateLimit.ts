import { Config, Context, Effect, Layer } from "effect"

/**
 * Tiny in-memory per-IP sliding-window limiters — budget/abuse protection
 * (PLAN.md Hardening), not general DDoS defense. At 10k+ scale this moves to
 * the edge/redis; documented in the scaling ladder.
 *
 * Defaults account for school NAT: a whole class often shares one public IP,
 * so limits are per-burst-abuse, not per-student. The daily submission cap is
 * the actual budget backstop.
 */
const makeWindowLimiter = (perMinute: number) => {
  const windows = new Map<string, { start: number; count: number }>()
  return (key: string) =>
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

export class SubmitRateLimit extends Context.Tag("SubmitRateLimit")<
  SubmitRateLimit,
  { readonly allow: (key: string) => Effect.Effect<boolean> }
>() {}

export const SubmitRateLimitLive = Layer.effect(
  SubmitRateLimit,
  Effect.gen(function* () {
    const perMinute = yield* Config.integer("SUBMIT_RATE_PER_MIN").pipe(Config.withDefault(240))
    return { allow: makeWindowLimiter(perMinute) }
  })
)

/**
 * Join + class-lookup + draft limiter — slows join-code enumeration.
 * 240/min, not 60: a class joining at the bell from one school NAT IP is
 * ~30 kids × (classInfo + join) = 60 requests inside a minute before any
 * refreshes — the old default sat exactly at the legitimate peak.
 */
export class JoinRateLimit extends Context.Tag("JoinRateLimit")<
  JoinRateLimit,
  { readonly allow: (key: string) => Effect.Effect<boolean> }
>() {}

export const JoinRateLimitLive = Layer.effect(
  JoinRateLimit,
  Effect.gen(function* () {
    const perMinute = yield* Config.integer("JOIN_RATE_PER_MIN").pipe(Config.withDefault(240))
    return { allow: makeWindowLimiter(perMinute) }
  })
)

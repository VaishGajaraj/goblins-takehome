import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { AppConfig } from "./Config.js"
import type { ProblemInput } from "./Domain.js"
import { Rubric } from "./Domain.js"

export class RubricGenError extends Schema.TaggedError<RubricGenError>()("RubricGenError", {
  message: Schema.String
}) {}

export class RubricGen extends Context.Tag("RubricGen")<
  RubricGen,
  {
    /** One batch call per assignment — returns one rubric per problem, in order. */
    readonly generate: (
      title: string,
      problems: ReadonlyArray<ProblemInput>
    ) => Effect.Effect<ReadonlyArray<Rubric>, RubricGenError>
  }
>() {}

// ---------- shared: normalize whatever we get to sum exactly to maxPoints ----------

const normalize = (rubric: Rubric, maxPoints: number): Rubric => {
  const items = rubric.filter((c) => c.points > 0).slice(0, 10)
  if (items.length === 0) {
    return [{ criterion: "Correct and complete solution", points: maxPoints }]
  }
  const sum = items.reduce((a, c) => a + c.points, 0)
  const scaled = items.map((c) => ({ ...c, points: Math.max(1, Math.round((c.points / sum) * maxPoints)) }))
  // fix rounding drift on the largest item
  const drift = maxPoints - scaled.reduce((a, c) => a + c.points, 0)
  if (drift !== 0) {
    const largest = scaled.reduce((a, b) => (b.points > a.points ? b : a))
    largest.points = Math.max(1, largest.points + drift)
  }
  return scaled
}

// ---------- fake: deterministic, free, instant ----------

const fakeRubric = (p: ProblemInput): Rubric =>
  normalize(
    [
      { criterion: "Final answer is correct", points: Math.round(p.maxPoints * 0.4) },
      { criterion: "Uses a valid method and shows the steps", points: Math.round(p.maxPoints * 0.4) },
      { criterion: "Work is clear and complete", points: Math.round(p.maxPoints * 0.2) }
    ],
    p.maxPoints
  )

export const RubricGenFake = Layer.succeed(RubricGen, {
  generate: (_title, problems) => Effect.succeed(problems.map(fakeRubric))
})

// ---------- real: one OpenRouter call per assignment ----------

const ResponseRubrics = Schema.Struct({
  rubrics: Schema.Array(Schema.Struct({ criteria: Rubric }))
})

const responseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rubrics"],
  properties: {
    rubrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criteria"],
        properties: {
          criteria: {
            type: "array",
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["criterion", "points"],
              properties: {
                criterion: { type: "string" },
                points: { type: "number" }
              }
            }
          }
        }
      }
    }
  }
} as const

export const makeRealGenerate =
  (apiKey: Redacted.Redacted<string>, model: string, fallbackModel: string) =>
  (title: string, problems: ReadonlyArray<ProblemInput>) =>
    Effect.tryPromise({
      try: async () => {
        const prompt = [
          `You are an experienced math teacher writing grading rubrics for the assignment "${title}".`,
          `For each problem below, write 2-4 rubric criteria. Points per problem must sum to that problem's max points.`,
          `Criteria should reward showing work and valid reasoning, not just the final answer.`,
          `Keep criteria short, concrete, and checkable from a photo of handwritten work.`,
          ``,
          ...problems.map((p, i) => `Problem ${i + 1} (max ${p.maxPoints} points): ${p.statement}`)
        ].join("\n")
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${Redacted.value(apiKey)}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            models: [model, fallbackModel],
            temperature: 0,
            max_tokens: 300 * problems.length + 200,
            messages: [{ role: "user", content: prompt }],
            response_format: {
              type: "json_schema",
              json_schema: { name: "rubrics", strict: true, schema: responseJsonSchema }
            }
          }),
          signal: AbortSignal.timeout(30_000)
        })
        if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const content = body.choices?.[0]?.message?.content
        if (!content) throw new Error("OpenRouter returned no content")
        return JSON.parse(content) as unknown
      },
      catch: (e) => new RubricGenError({ message: String(e) })
    }).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeUnknown(ResponseRubrics)(raw).pipe(
          Effect.mapError((e) => new RubricGenError({ message: `bad rubric shape: ${e.message.slice(0, 200)}` }))
        )
      ),
      Effect.map((decoded) =>
        problems.map((p, i) => normalize(decoded.rubrics[i]?.criteria ?? [], p.maxPoints))
      )
    )

/**
 * Selected by GRADER_BACKEND. Real mode still degrades gracefully: if the
 * model call fails (or no key is configured), assignment creation proceeds
 * with the deterministic rubric — the teacher can always edit it.
 */
export const RubricGenLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const backend = yield* AppConfig.graderBackend
    const keyOpt = yield* AppConfig.openrouterApiKey
    const model = yield* AppConfig.model
    const fallbackModel = yield* AppConfig.fallbackModel
    if (backend !== "real" || Option.isNone(keyOpt)) {
      if (backend === "real") yield* Effect.logWarning("GRADER_BACKEND=real but no OPENROUTER_API_KEY; using fake rubrics")
      return RubricGenFake
    }
    const real = makeRealGenerate(keyOpt.value, model, fallbackModel)
    return Layer.succeed(RubricGen, {
      generate: (title, problems) =>
        real(title, problems).pipe(
          Effect.tapError((e) => Effect.logWarning(`rubric gen failed, falling back to template: ${e.message}`)),
          Effect.orElse(() => Effect.succeed(problems.map(fakeRubric)))
        )
    })
  })
)

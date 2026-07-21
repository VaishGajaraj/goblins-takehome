import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { AppConfig } from "./Config.js"
import { ProblemInput } from "./Domain.js"

export class ProblemGenError extends Schema.TaggedError<ProblemGenError>()("ProblemGenError", {
  message: Schema.String
}) {}

export class ProblemGen extends Context.Tag("ProblemGen")<
  ProblemGen,
  {
    readonly draft: (input: {
      topic: string
      gradeLevel: string
      count: number
    }) => Effect.Effect<ReadonlyArray<ProblemInput>, ProblemGenError>
  }
>() {}

// ---------- fake: deterministic, free ----------

const FAKE_TEMPLATES = [
  (t: string) => `(${t}) Sam has 8 apples and gives 3 to a friend. How many are left? Show your thinking.`,
  (t: string) => `(${t}) Compute 12 + 15. Show each step of how you added.`,
  (t: string) => `(${t}) Draw a picture that shows 3 groups of 4. What is the total?`,
  (t: string) => `(${t}) A ribbon is 20 cm long. You cut off 7 cm. How long is what's left? Show your work.`,
  (t: string) => `(${t}) Which is bigger: 14 - 6 or 5 + 2? Explain how you know.`,
  (t: string) => `(${t}) Make up a word problem for 9 - 4 and solve it, showing every step.`,
  (t: string) => `(${t}) Count by 5s from 5 to 40. Write the numbers and circle the third one.`,
  (t: string) => `(${t}) You have 3 bags with 6 marbles each. How many marbles in total? Show your steps.`,
  (t: string) => `(${t}) 17 birds are on a wire; 8 fly away. How many stay? Draw or write your reasoning.`,
  (t: string) => `(${t}) Split 15 stickers fairly among 3 kids. How many does each get? Show how you shared them.`
]

const fakeDraft = (topic: string, count: number): ReadonlyArray<ProblemInput> =>
  Array.from({ length: count }, (_, i) => ({
    statement: FAKE_TEMPLATES[i % FAKE_TEMPLATES.length]!(topic),
    maxPoints: 10
  }))

// ---------- real: one OpenRouter call ----------

const DraftResponse = Schema.Struct({
  problems: Schema.Array(
    Schema.Struct({
      statement: Schema.String,
      maxPoints: Schema.Number
    })
  )
})

const draftJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["problems"],
  properties: {
    problems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "maxPoints"],
        properties: {
          statement: { type: "string" },
          maxPoints: { type: "number" }
        }
      }
    }
  }
} as const

const makeRealDraft =
  (apiKey: Redacted.Redacted<string>, model: string, fallbackModel: string) =>
  (input: { topic: string; gradeLevel: string; count: number }) =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${Redacted.value(apiKey)}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            models: [model, fallbackModel],
            temperature: 0.7,
            max_tokens: 220 * input.count + 150,
            messages: [
              {
                role: "user",
                content: [
                  `You are an experienced math teacher. Write ${input.count} math problems about "${input.topic}"`,
                  input.gradeLevel ? ` appropriate for ${input.gradeLevel}` : "",
                  `. Each problem must be self-contained, solvable by hand on a whiteboard, and ask the student to show their work or reasoning. Vary the style (computation, word problems, explain-your-thinking). maxPoints should be 10 for standard problems, up to 15 for multi-part ones. Keep each statement under 60 words.`
                ].join("")
              }
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "problems", strict: true, schema: draftJsonSchema }
            }
          }),
          signal: AbortSignal.timeout(30_000)
        })
        if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const content = body.choices?.[0]?.message?.content
        if (!content) throw new Error("no content")
        return JSON.parse(content) as unknown
      },
      catch: (e) => new ProblemGenError({ message: String(e).slice(0, 300) })
    }).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeUnknown(DraftResponse)(raw).pipe(
          Effect.mapError((e) => new ProblemGenError({ message: `bad shape: ${e.message.slice(0, 200)}` }))
        )
      ),
      Effect.map((d) =>
        d.problems.slice(0, input.count).map((p) => ({
          statement: p.statement.slice(0, 2000),
          maxPoints: Math.max(1, Math.min(20, Math.round(p.maxPoints)))
        }))
      )
    )

/** Same selection pattern as RubricGen/Grader: real degrades to fake on any failure. */
export const ProblemGenLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const backend = yield* AppConfig.graderBackend
    const keyOpt = yield* AppConfig.openrouterApiKey
    const model = yield* AppConfig.model
    const fallbackModel = yield* AppConfig.fallbackModel
    if (backend !== "real" || Option.isNone(keyOpt)) {
      return Layer.succeed(ProblemGen, {
        draft: (input) => Effect.succeed(fakeDraft(input.topic, input.count))
      })
    }
    const real = makeRealDraft(keyOpt.value, model, fallbackModel)
    return Layer.succeed(ProblemGen, {
      draft: (input) =>
        real(input).pipe(
          Effect.tapError((e) => Effect.logWarning(`problem draft failed, using templates: ${e.message}`)),
          Effect.orElse(() => Effect.succeed(fakeDraft(input.topic, input.count)))
        )
    })
  })
)

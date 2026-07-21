import { Config } from "effect"

/** Central env configuration. All values have safe local defaults. */
export const AppConfig = {
  port: Config.integer("PORT").pipe(Config.withDefault(3000)),
  /** Where the SQLite db + submitted images live. On Fly this is the mounted volume. */
  dataDir: Config.string("DATA_DIR").pipe(Config.withDefault("./data")),
  /** Built client assets to serve. Default resolves relative to the compiled
   * server module (repo-root/client/dist), so `npm start` works from any cwd. */
  staticDir: Config.option(Config.string("STATIC_DIR")),
  /** fake = deterministic latency-simulating grader (load tests); real = OpenRouter. */
  graderBackend: Config.string("GRADER_BACKEND").pipe(Config.withDefault("fake")),
  openrouterApiKey: Config.option(Config.redacted("OPENROUTER_API_KEY")),
  model: Config.string("OPENROUTER_MODEL").pipe(Config.withDefault("google/gemini-3-flash-preview")),
  /**
   * Failover model. NOT flash-lite: the golden-set eval (eval/results.json)
   * showed it awards full marks to prompt-injection images. gpt-5-mini is
   * slower (~10s) but graded correctly — right tradeoff for a rare failover.
   */
  fallbackModel: Config.string("OPENROUTER_FALLBACK_MODEL").pipe(
    Config.withDefault("openai/gpt-5-mini")
  ),
  /** Grading worker pool size ≈ throughput knob (throughput = concurrency / avg latency). */
  graderConcurrency: Config.integer("GRADER_CONCURRENCY").pipe(Config.withDefault(8)),
  /** Bounded dispatch queue; when full, submissions are shed with 429. */
  queueCapacity: Config.integer("QUEUE_CAPACITY").pipe(Config.withDefault(200)),
  /** Max attempts per student per problem (budget protection). */
  attemptCap: Config.integer("ATTEMPT_CAP").pipe(Config.withDefault(3)),
  /** Daily kill switch: max submissions accepted per UTC day. */
  dailySubmissionCap: Config.integer("DAILY_SUBMISSION_CAP").pipe(Config.withDefault(2000)),
  /** Fake grader latency model (lognormal) + failure injection — mirrors real model behavior. */
  fakeMedianMs: Config.integer("FAKE_GRADER_MEDIAN_MS").pipe(Config.withDefault(1800)),
  fakeSigma: Config.number("FAKE_GRADER_SIGMA").pipe(Config.withDefault(0.6)),
  fakeErrorRate: Config.number("FAKE_GRADER_ERROR_RATE").pipe(Config.withDefault(0.02))
}

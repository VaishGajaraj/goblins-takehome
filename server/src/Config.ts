import { Config } from "effect"

/** Central env configuration. All values have safe local defaults. */
export const AppConfig = {
  port: Config.integer("PORT").pipe(Config.withDefault(3000)),
  /** Where the SQLite db + submitted images live. On Fly this is the mounted volume. */
  dataDir: Config.string("DATA_DIR").pipe(Config.withDefault("./data")),
  /** Built client assets to serve. */
  staticDir: Config.string("STATIC_DIR").pipe(Config.withDefault("../client/dist")),
  /** fake = deterministic latency-simulating grader (load tests); real = OpenRouter. */
  graderBackend: Config.string("GRADER_BACKEND").pipe(Config.withDefault("fake")),
  openrouterApiKey: Config.option(Config.redacted("OPENROUTER_API_KEY"))
}

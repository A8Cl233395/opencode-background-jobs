export type PluginOptions = Record<string, unknown> | undefined

export type ResolvedOptions = {
  inline_wait_ms: number
  max_jobs: number
  log_max_bytes: number
  log_retain: number
  stall_after_ms: number
  exit_settle_ms: number
  job_read_max_wait_ms: number
  job_read_default_wait_ms: number
  example_wait_ms: number
  job_ttl_ms: number
  kill_on_session_end: boolean
}

export type RuntimeConfig = ResolvedOptions & {
  limits: { maxLines: number; maxBytes: number }
  shell: string
  directory: string
}

export const DEFAULTS: ResolvedOptions = {
  inline_wait_ms: 30_000,
  max_jobs: 8,
  log_max_bytes: 64 * 1024 * 1024,
  log_retain: 20,
  stall_after_ms: 30_000,
  exit_settle_ms: 200,
  job_read_max_wait_ms: 60_000,
  job_read_default_wait_ms: 5_000,
  example_wait_ms: 5_000,
  job_ttl_ms: 0,
  kill_on_session_end: false,
}

export const DEFAULT_LIMITS = { maxLines: 2000, maxBytes: 50 * 1024 }

// timeout: 0 promotes the command to a background job immediately, then runs
// one automatic read with this budget. A command that finishes or produces
// output within the window is returned by the same `shell` call instead of
// costing a follow-up `job_read` request.
export const EXPLICIT_BACKGROUND_READ_MS = 3_000

// Hard ceiling for every user-facing timeout and for the options that feed
// them: shell.timeout, job_read.timeout, inline_wait_ms, job_read_max_wait_ms.
export const MAX_TIMEOUT_MS = 15 * 60_000

const ENV = {
  inline_wait_ms: "OPENCODE_BASH_BG_INLINE_WAIT_MS",
  max_jobs: "OPENCODE_BASH_BG_MAX_JOBS",
  log_max_bytes: "OPENCODE_BASH_BG_LOG_MAX_BYTES",
  log_retain: "OPENCODE_BASH_BG_LOG_RETAIN",
  stall_after_ms: "OPENCODE_BASH_BG_STALL_AFTER_MS",
  exit_settle_ms: "OPENCODE_BASH_BG_EXIT_SETTLE_MS",
  job_read_max_wait_ms: "OPENCODE_BASH_BG_JOB_READ_MAX_WAIT_MS",
  job_read_default_wait_ms: "OPENCODE_BASH_BG_JOB_READ_DEFAULT_WAIT_MS",
  example_wait_ms: "OPENCODE_BASH_BG_EXAMPLE_WAIT_MS",
  job_ttl_ms: "OPENCODE_BASH_BG_JOB_TTL_MS",
  kill_on_session_end: "OPENCODE_BASH_BG_KILL_ON_SESSION_END",
} as const

function pickNumber(
  key: keyof typeof ENV,
  options: PluginOptions,
  env: NodeJS.ProcessEnv,
  min: number,
): number | undefined {
  const fromOptions = options?.[key]
  if (typeof fromOptions === "number" && Number.isFinite(fromOptions) && fromOptions >= min) {
    return Math.floor(fromOptions)
  }
  const raw = env[ENV[key]]
  if (raw === undefined || raw.trim() === "") return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < min) return undefined
  return Math.floor(parsed)
}

function pickBoolean(key: "kill_on_session_end", options: PluginOptions, env: NodeJS.ProcessEnv): boolean | undefined {
  const fromOptions = options?.[key]
  if (typeof fromOptions === "boolean") return fromOptions
  const raw = env[ENV[key]]
  if (raw === undefined || raw.trim() === "") return undefined
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

export function resolveOptions(
  options: PluginOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOptions {
  return {
    inline_wait_ms: Math.min(
      pickNumber("inline_wait_ms", options, env, 0) ?? DEFAULTS.inline_wait_ms,
      MAX_TIMEOUT_MS,
    ),
    max_jobs: pickNumber("max_jobs", options, env, 1) ?? DEFAULTS.max_jobs,
    log_max_bytes: pickNumber("log_max_bytes", options, env, 0) ?? DEFAULTS.log_max_bytes,
    log_retain: pickNumber("log_retain", options, env, 1) ?? DEFAULTS.log_retain,
    stall_after_ms: pickNumber("stall_after_ms", options, env, 1) ?? DEFAULTS.stall_after_ms,
    exit_settle_ms: pickNumber("exit_settle_ms", options, env, 0) ?? DEFAULTS.exit_settle_ms,
    job_read_max_wait_ms: Math.min(
      pickNumber("job_read_max_wait_ms", options, env, 0) ?? DEFAULTS.job_read_max_wait_ms,
      MAX_TIMEOUT_MS,
    ),
    job_read_default_wait_ms: Math.min(
      pickNumber("job_read_default_wait_ms", options, env, 0) ?? DEFAULTS.job_read_default_wait_ms,
      MAX_TIMEOUT_MS,
    ),
    example_wait_ms: pickNumber("example_wait_ms", options, env, 0) ?? DEFAULTS.example_wait_ms,
    job_ttl_ms: pickNumber("job_ttl_ms", options, env, 0) ?? DEFAULTS.job_ttl_ms,
    kill_on_session_end: pickBoolean("kill_on_session_end", options, env) ?? DEFAULTS.kill_on_session_end,
  }
}

export function inlineWaitSeconds(cfg: Pick<RuntimeConfig, "inline_wait_ms">): number {
  return Math.round(cfg.inline_wait_ms / 1000)
}

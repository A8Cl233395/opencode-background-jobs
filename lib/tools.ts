import {
  DEFAULT_LIMITS,
  EXPLICIT_BACKGROUND_READ_MS,
  MAX_TIMEOUT_MS,
  resolveOptions,
  type PluginOptions,
  type RuntimeConfig,
} from "./config"
import { JobLimitError, JobRegistry, type StartOutcome } from "./jobs"
import * as describe from "./describe"
import { resolveWorkdir, selectShell } from "./shell"

export type ToolContextLike = {
  sessionID: string
  signal?: AbortSignal
  progress?: (update: Record<string, unknown>) => Promise<void> | void
}

export type ToolResultLike = {
  content: string
  metadata?: Record<string, unknown>
}

export type ToolInfoLike = {
  name: string
  description: string
  input: unknown
  execute: (input: Record<string, unknown>, context: ToolContextLike) => Promise<ToolResultLike>
  options?: { codemode?: boolean }
}

export type Bundle = {
  tools: ToolInfoLike[]
  description: string
  registry: JobRegistry
  killOnSessionEnd: boolean
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeId(input: unknown): string {
  if (typeof input === "number" && Number.isInteger(input)) return String(input)
  if (typeof input !== "string") throw new Error(`Invalid job id: expected a string`)
  const trimmed = input.trim().replace(/^#/, "")
  if (trimmed === "") throw new Error("Invalid job id: empty string")
  return trimmed
}

function requireCommand(args: unknown): string {
  if (!isRecord(args) || typeof args.command !== "string" || args.command.trim() === "") {
    throw new Error("The shell tool was called with invalid arguments: `command` must be a non-empty string.")
  }
  return args.command
}

function optionalWorkdir(args: Record<string, unknown>): string | undefined {
  if (args?.workdir === undefined || args?.workdir === null) return undefined
  if (typeof args.workdir !== "string" || args.workdir.trim() === "") {
    throw new Error("The shell tool was called with invalid arguments: `workdir` must be a non-empty string.")
  }
  return args.workdir
}

function optionalTimeout(args: Record<string, unknown>): number | undefined {
  if (args?.timeout === undefined || args?.timeout === null) return undefined
  const value = Number(args.timeout)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "The shell tool was called with invalid arguments: `timeout` must be a non-negative number.",
    )
  }
  return Math.floor(value)
}

function abortError(): Error {
  const error = new Error("Command aborted")
  error.name = "AbortError"
  return error
}

const idSchema = {
  anyOf: [
    { type: "string", description: "Job id returned by the shell tool or job_list." },
    { type: "integer", description: "Numeric job id." },
  ],
}

export function createBundle(input: { directory: string; options?: PluginOptions }): Bundle {
  const resolved = resolveOptions(input.options)
  const shellOption = input.options?.shell
  const config: RuntimeConfig = {
    ...resolved,
    limits: { ...DEFAULT_LIMITS },
    shell: selectShell(typeof shellOption === "string" ? shellOption : undefined),
    directory: input.directory,
  }

  const registry = new JobRegistry({
    maxJobs: config.max_jobs,
    logMaxBytes: config.log_max_bytes,
    logRetain: config.log_retain,
    jobTtlMs: config.job_ttl_ms,
    stallAfterMs: config.stall_after_ms,
    exitSettleMs: config.exit_settle_ms,
    spillBytes: config.limits.maxBytes,
    spillLines: config.limits.maxLines,
  })

  function foregroundResult(outcome: Extract<StartOutcome, { kind: "completed" }>): ToolResultLike {
    const parts: string[] = []
    if (outcome.groupSurvivors === true) {
      parts.push(
        "<shell_metadata>\nThe tracked process exited but its process group still has running members. They are not tracked as a job; kill them manually if they are not needed.\n</shell_metadata>",
      )
    }
    parts.push(outcome.raw || outcome.record.spawnError || "(no output)")
    return {
      content: parts.join("\n\n"),
      metadata: { exit: outcome.record.exitCode, status: "completed" },
    }
  }

  async function jobResult(
    outcome: Extract<StartOutcome, { kind: "job" }>,
    sessionID: string,
  ): Promise<ToolResultLike> {
    // Show the output produced so far with the same incremental read logic as
    // job_read, so the receipt returns the first chunk from the read position
    // instead of only the last few lines. The read advances the cursor, so a
    // later job_read without an offset continues from here.
    const read = await registry.read(sessionID, outcome.record.id, undefined, 0, config.limits)
    const body = read?.text ?? ""
    const nextOffset = read?.nextOffset ?? 0
    return {
      content: describe.backgroundReceipt({
        record: outcome.record,
        body: body || outcome.record.spawnError || "",
      }),
      metadata: {
        jobId: outcome.record.id,
        background: true,
        status: outcome.record.status,
        next_offset: nextOffset,
      },
    }
  }

  // Shared by job_read and the timeout: 0 path of the shell tool, so an
  // explicit background start returns exactly what one job_read would have.
  async function readJob(
    sessionID: string,
    id: string,
    offset: number | undefined,
    waitMs: number,
  ): Promise<ToolResultLike | undefined> {
    const outcome = await registry.read(sessionID, id, offset, waitMs, config.limits)
    if (!outcome) return undefined
    const record = outcome.record
    const elapsed = Date.now() - record.startedAt
    const elapsedEnd = (record.completedAt ?? Date.now()) - record.startedAt

    if (!outcome.running) {
      const unread = outcome.text.length > 0
      const pendingBytes = unread ? Math.max(0, record.bytes - outcome.nextOffset) : 0
      return {
        content: describe.exitReceipt({
          record,
          body: unread ? outcome.text : registry.jobTail(record, 40, 8192) || record.spawnError || "",
          pendingBytes,
          killed: record.status === "killed",
          groupSurvivors: record.status === "killed" ? null : registry.groupSurvivors(id),
        }),
        metadata: { jobId: id, status: record.status, exit: record.exitCode, next_offset: outcome.nextOffset },
      }
    }

    if (outcome.text.length === 0 && outcome.stalled) {
      return {
        content: describe.stalledReceipt({ record, silentForMs: outcome.silentForMs }),
        metadata: { jobId: id, status: "stalled", silentForMs: outcome.silentForMs },
      }
    }

    return {
      content: describe.runningReceipt({
        cfg: config,
        record,
        nextOffset: outcome.nextOffset,
        chunk: outcome.text,
        elapsedMs: outcome.running ? elapsed : elapsedEnd,
        silentForMs: outcome.silentForMs,
      }),
      metadata: {
        jobId: id,
        status: record.status,
        next_offset: outcome.nextOffset,
        silentForMs: outcome.silentForMs,
      },
    }
  }

  const shellTool: ToolInfoLike = {
    name: "shell",
    description: describe.buildShellDescription(config),
    options: { codemode: false },
    input: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: {
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          maximum: MAX_TIMEOUT_MS,
          description: describe.timeoutParameter(config),
        },
      },
      required: ["command"],
    },
    execute: async (args, ctx): Promise<ToolResultLike> => {
      const command = requireCommand(args)
      const workdir = optionalWorkdir(args)
      const timeout = optionalTimeout(args)
      const requested = timeout === undefined ? config.inline_wait_ms : timeout
      // timeout: 0 starts in the background, then performs one automatic read.
      const waitMs = requested === 0 ? 0 : Math.min(requested, MAX_TIMEOUT_MS)
      const cwd = workdir ? await resolveWorkdir(workdir, config.directory, config.shell) : config.directory

      const outcome = await registry.start({
        command,
        cwd,
        env: { ...process.env },
        shell: config.shell,
        sessionID: ctx.sessionID,
        waitMs,
        abort: ctx.signal,
        onPreview: (last) => {
          void Promise.resolve(ctx.progress?.({ output: last })).catch(() => {})
        },
      })

      if (outcome.kind === "aborted") throw abortError()
      if (outcome.kind === "completed") return foregroundResult(outcome)

      // Aborting the call must also stop a job it just started. Once the
      // receipt is returned the job belongs to the session and is left alone.
      const signal = ctx.signal
      const jobID = outcome.record.id
      const killOnAbort = () => {
        void registry.kill(jobID)
      }
      signal?.addEventListener("abort", killOnAbort, { once: true })
      if (signal?.aborted) killOnAbort()
      try {
        if (outcome.origin === "explicit") {
          const read = await readJob(ctx.sessionID, jobID, undefined, EXPLICIT_BACKGROUND_READ_MS)
          if (signal?.aborted) throw abortError()
          if (read) return read
        }
        if (signal?.aborted) throw abortError()
        return await jobResult(outcome, ctx.sessionID)
      } finally {
        signal?.removeEventListener("abort", killOnAbort)
      }
    },
  }

  const jobListTool: ToolInfoLike = {
    name: "job_list",
    description: describe.jobListDescription(),
    options: { codemode: false },
    input: { type: "object", properties: {} },
    execute: async (_args, ctx): Promise<ToolResultLike> => {
      const result = registry.list(ctx.sessionID)
      return {
        content: describe.listReceipt(result),
        metadata: { count: result.entries.length, running: result.running, max: result.max },
      }
    },
  }

  const jobReadTool: ToolInfoLike = {
    name: "job_read",
    description: describe.jobReadDescription(config),
    options: { codemode: false },
    input: {
      type: "object",
      properties: {
        id: idSchema,
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Byte offset to read from. Omit to continue from the previous read; pass 0 to re-read from the beginning.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          maximum: MAX_TIMEOUT_MS,
          description: describe.jobReadTimeoutParameter(config),
        },
      },
      required: ["id"],
    },
    execute: async (args, ctx): Promise<ToolResultLike> => {
      const id = normalizeId(args?.id)
      const existing = registry.get(id)
      if (!existing || existing.sessionID !== ctx.sessionID) {
        throw new Error(`Unknown job id ${id}. Run job_list to see tracked jobs.`)
      }
      const offset =
        typeof args?.offset === "number" && args.offset >= 0 ? Math.floor(args.offset) : undefined
      const requested =
        typeof args?.timeout === "number" && args.timeout >= 0
          ? Math.floor(args.timeout)
          : config.job_read_default_wait_ms
      const waitMs = Math.min(requested, config.job_read_max_wait_ms, MAX_TIMEOUT_MS)
      const result = await readJob(ctx.sessionID, id, offset, waitMs)
      if (!result) {
        throw new Error(`Unknown job id ${id}. Run job_list to see tracked jobs.`)
      }
      return result
    },
  }

  const jobKillTool: ToolInfoLike = {
    name: "job_kill",
    description: describe.jobKillDescription(),
    options: { codemode: false },
    input: {
      type: "object",
      properties: { id: idSchema },
      required: ["id"],
    },
    execute: async (args, ctx): Promise<ToolResultLike> => {
      const id = normalizeId(args?.id)
      const before = registry.get(id)
      if (!before || before.sessionID !== ctx.sessionID) {
        throw new Error(`Unknown job id ${id}. Run job_list to see tracked jobs.`)
      }
      const priorStatus = before.status
      const record = (await registry.kill(id)) ?? before
      const outcome = await registry.read(ctx.sessionID, id, undefined, 0, config.limits)
      const unread = outcome?.text ?? ""
      const pendingBytes = unread.length > 0 ? Math.max(0, record.bytes - (outcome?.nextOffset ?? 0)) : 0
      // No unread output means there is nothing new to report: unlike job_read,
      // kill never replays the tail of a log the model has already seen.
      const body = unread.length > 0 ? unread : record.spawnError || ""
      const metadata = { jobId: id, status: record.status, exit: record.exitCode }
      if (priorStatus === "running" && record.status === "killed") {
        return {
          content: describe.killReceipt({
            record,
            body,
            pendingBytes,
            groupSurvivors: registry.groupSurvivors(id),
          }),
          metadata,
        }
      }
      return {
        content: describe.exitReceipt({
          record,
          body,
          pendingBytes,
          killed: record.status === "killed",
          groupSurvivors: record.status === "killed" ? null : registry.groupSurvivors(id),
        }),
        metadata,
      }
    },
  }

  return {
    tools: [shellTool, jobListTool, jobReadTool, jobKillTool],
    description: shellTool.description,
    registry,
    killOnSessionEnd: config.kill_on_session_end,
  }
}

export { JobLimitError }

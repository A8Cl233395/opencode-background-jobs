import type { RuntimeConfig } from "./config"
import { inlineWaitSeconds, MAX_TIMEOUT_MS } from "./config"
import { formatElapsed } from "./truncate"
import { shellName } from "./shell"
import type { JobOrigin, JobRecord } from "./jobs"

const OS =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : process.platform === "linux"
        ? "Linux"
        : process.platform

export function buildShellDescription(cfg: RuntimeConfig): string {
  return [
    "Execute a shell command and return its output.",
    `Commands run on ${OS} using ${shellName(cfg.shell)}.`,
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    `Commands accept an optional timeout; a foreground command that does not finish within ${inlineWaitSeconds(cfg)} seconds is moved to a background job instead of being killed, and you receive a job id.`,
    "Pass timeout: 0 to start a command in the background immediately; background jobs have no timeout and are read with job_read and stopped with job_kill.",
    "Do not re-run a command that was moved to the background or poll it with sleep.",
    "Do not use nohup, &, disown, tmux or screen; shell-level detaching breaks output capture and leaks processes.",
  ].join(" ")
}

export function timeoutParameter(cfg: RuntimeConfig): string {
  return `Timeout in milliseconds. Set to 0 to start the command in the background immediately. Defaults to ${cfg.inline_wait_ms} for foreground commands. A foreground command that reaches the timeout is moved to a background job instead of being killed. Values above ${MAX_TIMEOUT_MS} ms (15 minutes) are clamped to that hard cap.`
}

export function jobReadTimeoutParameter(cfg: RuntimeConfig): string {
  return `Block this long for new output or exit. Defaults to 0. Values are clamped to ${cfg.job_read_max_wait_ms} ms, and every timeout is hard-capped at 15 minutes (${MAX_TIMEOUT_MS} ms).`
}

export function jobListDescription(): string {
  return `List background jobs in this session: id, command, status (running / exited / killed), elapsed time and exit code. Jobs live only for the current opencode instance; use this when you have lost track of what is running or before starting a server that may already be running.`
}

export function jobReadDescription(cfg: RuntimeConfig): string {
  const example = Math.min(cfg.example_wait_ms, cfg.job_read_max_wait_ms)
  return `Read output from a background job.

Reads are incremental and automatic: a read position is tracked per session and job, so calling job_read with just the id returns only the output produced since the previous read. Pass offset only to re-read from a specific byte position (0 for the whole log). The result still includes next_offset, the position where the next automatic read resumes. When the job has already exited, the result reports the exit status and returns any unread output; if more output remains unread, it says so - call job_read again to continue.

If unread output is already available, the call returns immediately with it; timeout only blocks while there is no new output, so one call with timeout=${example} replaces many polling turns. The reported status is a snapshot from the moment the call returns - a job reported as running may still have exited by the time you read the result, in which case the next call reports it as exited. If the result says the job is stalled or is waiting for input it cannot receive, do not keep waiting; kill it or re-run it non-interactively.`
}

export function jobKillDescription(): string {
  return `Stop a background job with its child processes (whole process group on Unix, tree kill on Windows), then return the final status and any output not yet read, using the same per-session read position as job_read. If there is no unread output, the last output is returned as a recap. Killing an already exited job is a no-op. Call this before re-running a backgrounded command and when done with a dev server or watcher - they do not stop on their own.`
}

function displayCommand(command: string, max = 60): string {
  const single = command.replace(/\s+/g, " ").trim()
  if (single.length <= max) return single
  return `${single.slice(0, max - 3)}...`
}

export function backgroundReceipt(input: {
  cfg: RuntimeConfig
  record: JobRecord
  origin: JobOrigin
  tail: string
}): string {
  const first =
    input.origin === "explicit"
      ? `Started as background job #${input.record.id} (timeout: 0).`
      : input.origin === "abort"
        ? `The wait was interrupted; the command is now running as background job #${input.record.id}.`
        : `Command exceeded the timeout and is now running as background job #${input.record.id}.`
  const tail = input.tail.replace(/\s+$/, "")
  const output = tail ? `\n\n<output so far>\n${tail}\n</output>` : ""
  return `<shell_metadata>
${first}
It will not be killed automatically; stop it with job_kill.
</shell_metadata>${output}`
}

export function listReceipt(input: { entries: JobRecord[]; running: number; max: number }): string {
  if (input.entries.length === 0) return "No background jobs in this session."
  const lines = [`Background jobs in this session (${input.running}/${input.max}):`]
  for (const record of input.entries) {
    const elapsed = formatElapsed(Date.now() - record.startedAt)
    const command = displayCommand(record.command)
    if (record.status === "running") {
      lines.push(`  #${record.id}  running  ${elapsed}   ${command}`)
      continue
    }
    const code = record.exitCode === null ? "?" : String(record.exitCode)
    lines.push(`  #${record.id}  ${record.status}  ${elapsed}   ${command}   (code ${code})`)
  }
  return lines.join("\n")
}

export function runningReceipt(input: {
  cfg: RuntimeConfig
  record: JobRecord
  nextOffset: number
  chunk: string
  elapsedMs: number
  silentForMs: number
}): string {
  const silent = Math.floor(input.silentForMs / 1000)
  const head =
    input.chunk.length === 0
      ? `job ${input.record.id}: running, ${formatElapsed(input.elapsedMs)} elapsed (no new output in the last ${silent}s)`
      : `job ${input.record.id}: running, ${formatElapsed(input.elapsedMs)} elapsed`
  const next = `next_offset: ${input.nextOffset}`
  const chunk = input.chunk.replace(/\s+$/, "")
  if (chunk.length === 0) return `${head}\n${next}`
  return `${head}\n${next}\n${chunk}`
}

export function stalledReceipt(input: { record: JobRecord; silentForMs: number }): string {
  const silent = Math.floor(input.silentForMs / 1000)
  return `job ${input.record.id}: STALLED - no output for ${silent}s.

Next: job_kill id=${input.record.id} or wait longer.`
}

function pendingNotice(pendingBytes?: number): string | undefined {
  const pending = pendingBytes ?? 0
  if (pending <= 0) return undefined
  return `${pending} more bytes of unread output; call job_read again (no offset needed) to continue.`
}

function appendOutput(lines: string[], body: string): void {
  const text = body.replace(/\s+$/, "")
  if (text) lines.push(text)
}

export function exitReceipt(input: {
  record: JobRecord
  body: string
  pendingBytes?: number
  killed: boolean
  groupSurvivors: boolean | null
}): string {
  const elapsed = formatElapsed((input.record.completedAt ?? Date.now()) - input.record.startedAt)
  const code = input.record.exitCode === null ? (input.killed ? "-" : "?") : String(input.record.exitCode)
  const reason =
    input.record.killReason === "log_limit" ? " (log limit)" : input.record.killReason === "ttl" ? " (ttl)" : ""
  const lines = input.killed
    ? [`job ${input.record.id}: killed after ${elapsed}${reason}`]
    : [`job ${input.record.id}: exited with code ${code} after ${elapsed}`]
  if (input.groupSurvivors === true) {
    lines.push(
      "Note: the tracked process exited, but its process group still has running members. They are not tracked as a job; kill them manually if they are not needed.",
    )
  }
  const notice = pendingNotice(input.pendingBytes)
  if (notice) lines.push(notice)
  appendOutput(lines, input.body)
  return lines.join("\n")
}

export function killReceipt(input: {
  record: JobRecord
  body: string
  pendingBytes?: number
  groupSurvivors: boolean | null
}): string {
  const target =
    process.platform === "win32"
      ? `process tree of pid ${input.record.pid}, best-effort`
      : `process group ${input.record.pgid ?? input.record.pid}`
  const lines = [`job ${input.record.id}: killed (${target}).`]
  if (input.groupSurvivors === true) {
    lines.push(
      "Note: some members of the process group are still alive; taskkill/negative-pid kill did not reach them.",
    )
  }
  const notice = pendingNotice(input.pendingBytes)
  if (notice) lines.push(notice)
  appendOutput(lines, input.body)
  return lines.join("\n")
}

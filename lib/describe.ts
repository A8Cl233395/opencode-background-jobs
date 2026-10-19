import type { RuntimeConfig } from "./config"
import { EXPLICIT_BACKGROUND_READ_MS, inlineWaitSeconds, MAX_TIMEOUT_MS } from "./config"
import { formatElapsed } from "./truncate"
import { shellName } from "./shell"
import type { JobRecord } from "./jobs"

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
    `Commands accept an optional timeout; a command that does not finish within ${inlineWaitSeconds(cfg)} seconds is moved to a background job.`,
    `Set timeout to 0 to start in the background and wait once for its first output (up to ${EXPLICIT_BACKGROUND_READ_MS} ms).`,
    "Background jobs have no timeout. Read them with job_read and stop them with job_kill; do not poll with sleep or detach with &, nohup, tmux, or screen.",
  ].join(" ")
}

export function timeoutParameter(cfg: RuntimeConfig): string {
  return `Timeout in milliseconds. Set to 0 to start in the background and wait once for its first output (up to ${EXPLICIT_BACKGROUND_READ_MS} ms). Defaults to ${cfg.inline_wait_ms} ms for foreground commands. Values above ${MAX_TIMEOUT_MS} ms (15 minutes) are clamped.`
}

export function jobReadTimeoutParameter(cfg: RuntimeConfig): string {
  return `Timeout in milliseconds. Blocks only while there is no new output. Defaults to ${cfg.job_read_default_wait_ms} ms; values are clamped to ${Math.min(cfg.job_read_max_wait_ms, MAX_TIMEOUT_MS)} ms.`
}

export function jobListDescription(): string {
  return `List background jobs in this session with their id, command, status, elapsed time, and exit code. Jobs live only for the current opencode instance.`
}

export function jobReadDescription(cfg: RuntimeConfig): string {
  const example = Math.min(cfg.example_wait_ms, cfg.job_read_max_wait_ms)
  return `Read output from a background job. Reads are incremental: omitting offset returns only output produced since the previous read, while offset: 0 re-reads from the beginning; the result includes next_offset. When the job has exited, the result reports its status and any unread output; call job_read again if unread output remains. The call returns as soon as unread output exists; otherwise it blocks up to ${example} ms. If the result says the job is stalled, kill it or re-run it non-interactively instead of waiting.`
}

export function jobKillDescription(): string {
  return `Stop a background job and its child processes, then return its final status and any unread output. Already-read output is not replayed. Killing an exited job is a no-op. Use this before re-running a backgrounded command and when done with a dev server or watcher.`
}

function displayCommand(command: string, max = 60): string {
  const single = command.replace(/\s+/g, " ").trim()
  if (single.length <= max) return single
  return `${single.slice(0, max - 3)}...`
}

export function backgroundReceipt(input: {
  record: JobRecord
  body: string
}): string {
  const body = input.body.replace(/\s+$/, "") || "(no output)"
  return `<shell_metadata>
Command moved to the background (job #${input.record.id}).
</shell_metadata>

${body}`
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
  const head = `job #${input.record.id} running (${formatElapsed(input.elapsedMs)})`
  const next = `next_offset: ${input.nextOffset}`
  const chunk = input.chunk.replace(/\s+$/, "") || "(no output)"
  return `${head}\n${next}\n\n${chunk}`
}

export function stalledReceipt(input: { record: JobRecord; silentForMs: number }): string {
  const silent = Math.floor(input.silentForMs / 1000)
  return `job #${input.record.id} stalled - no output for ${silent}s. job_kill it or wait longer.`
}

function pendingNotice(pendingBytes?: number): string | undefined {
  const pending = pendingBytes ?? 0
  if (pending <= 0) return undefined
  return `${pending} bytes unread - call job_read again.`
}

function appendOutput(lines: string[], body: string): void {
  const text = body.replace(/\s+$/, "")
  if (text === "") return
  lines.push("", text)
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
    ? [`job #${input.record.id} killed after ${elapsed}${reason}`]
    : [`job #${input.record.id} exited with code ${code} after ${elapsed}`]
  if (input.groupSurvivors === true) {
    lines.push(
      "Note: the tracked process exited but its process group still has running members; they are not tracked, kill them manually if needed.",
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
  const lines = [`job #${input.record.id} killed (${target}).`]
  if (input.groupSurvivors === true) {
    lines.push("Note: some process group members are still alive; the kill did not reach them.")
  }
  const notice = pendingNotice(input.pendingBytes)
  if (notice) lines.push(notice)
  appendOutput(lines, input.body)
  return lines.join("\n")
}

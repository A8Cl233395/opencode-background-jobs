import fs from "node:fs"
import type { ChildProcess } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { ensureDir, newTruncationFilePath, truncationDir } from "./paths"
import { isGroupAlive, isPidAlive, killProcessTree, sleep, spawnCommand } from "./spawn"
import { preview, readChunkFrom, readChunkFromBuffer, readTailBytes, tail } from "./truncate"

export type JobOrigin = "auto" | "explicit"
export type JobStatus = "running" | "exited" | "killed"

export type JobRecord = {
  id: string
  pid: number
  pgid: number | null
  command: string
  workdir: string
  sessionID: string
  shell: string
  startedAt: number
  updatedAt: number
  lastOutputAt: number
  status: JobStatus
  exitCode: number | null
  signal: string | null
  completedAt: number | null
  origin: JobOrigin
  bytes: number
  newlines: number
  spilled: boolean
  filePath: string | null
  logTruncated: boolean
  logLimitHit: boolean
  killReason: "user" | "log_limit" | "ttl" | null
  spawnError: string | null
  buffer: Buffer[]
}

type Live = {
  child: ChildProcess
  record: JobRecord
  exited: boolean
  exitCode: number | null
  signal: string | null
  settle: Promise<void>
  resolveSettle: () => void
  promoted: boolean
  previewActive: boolean
  ttlTimer?: NodeJS.Timeout
  fd: number | null
  outDecoder: StringDecoder
  errDecoder: StringDecoder
  last: string
  handlers: { out: (chunk: Buffer) => void; err: (chunk: Buffer) => void }
}

export type RegistryOptions = {
  maxJobs: number
  logMaxBytes: number
  logRetain: number
  jobTtlMs: number
  stallAfterMs: number
  exitSettleMs: number
  spillBytes: number
  spillLines: number
}

export type StartInput = {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  shell: string
  sessionID: string
  waitMs: number
  abort?: AbortSignal
  onPreview?: (last: string) => void
}

export type StartOutcome =
  | {
      kind: "completed"
      record: JobRecord
      raw: string
      last: string
      groupSurvivors: boolean | null
    }
  | {
      kind: "job"
      record: JobRecord
      elapsedMs: number
      origin: JobOrigin
      groupSurvivors: boolean | null
    }
  | {
      kind: "aborted"
    }

export type ReadOutcome = {
  record: JobRecord
  text: string
  nextOffset: number
  running: boolean
  silentForMs: number
  stalled: boolean
  stalledAfterMs: number
}

export type ListOutcome = {
  entries: JobRecord[]
  running: number
  max: number
}

export class JobLimitError extends Error {
  constructor(running: number, max: number) {
    super(
      `Background job limit reached (${running}/${max}). Run job_list and job_kill one of the running jobs first.`,
    )
    this.name = "JobLimitError"
  }
}

function countNewlines(buf: Buffer): number {
  let count = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++
  return count
}

export class JobRegistry {
  private records = new Map<string, JobRecord>()
  private live = new Map<string, Live>()
  private pending = new Set<Live>()
  private cursors = new Map<string, number>()
  private nextId = 1

  constructor(private opts: RegistryOptions) {}

  runningCount(sessionID?: string): number {
    let count = 0
    for (const live of this.pending) {
      if (sessionID === undefined || live.record.sessionID === sessionID) count++
    }
    for (const record of this.records.values()) {
      if (record.status !== "running") continue
      if (sessionID !== undefined && record.sessionID !== sessionID) continue
      count++
    }
    return count
  }

  get(id: string): JobRecord | undefined {
    return this.records.get(id)
  }

  private isAlive(record: JobRecord): boolean {
    const live = this.live.get(record.id)
    return !!live && !live.exited
  }

  private markExited(live: Live): void {
    const record = live.record
    if (record.status === "running") {
      record.status = "exited"
      record.completedAt = record.completedAt ?? Date.now()
    }
    record.exitCode = live.exitCode
    record.signal = live.signal
    record.updatedAt = Date.now()
  }

  private async settleRunning(record: JobRecord): Promise<boolean> {
    if (!this.isAlive(record)) return false
    if (this.opts.exitSettleMs <= 0) return true
    const live = this.live.get(record.id)
    if (!live) return false
    await Promise.race([live.settle, sleep(this.opts.exitSettleMs)])
    return this.isAlive(record)
  }

  async start(input: StartInput): Promise<StartOutcome> {
    if (input.abort?.aborted) return { kind: "aborted" }
    const running = this.runningCount(input.sessionID)
    if (running >= this.opts.maxJobs) throw new JobLimitError(running, this.opts.maxJobs)

    const now = Date.now()
    const record: JobRecord = {
      id: String(this.nextId++),
      pid: 0,
      pgid: null,
      command: input.command,
      workdir: input.cwd,
      sessionID: input.sessionID,
      shell: input.shell,
      startedAt: now,
      updatedAt: now,
      lastOutputAt: now,
      status: "running",
      exitCode: null,
      signal: null,
      completedAt: null,
      origin: "auto",
      bytes: 0,
      newlines: 0,
      spilled: false,
      filePath: null,
      logTruncated: false,
      logLimitHit: false,
      killReason: null,
      spawnError: null,
      buffer: [],
    }

    const child = spawnCommand({
      shell: input.shell,
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    })
    record.pid = child.pid ?? 0
    record.pgid = process.platform === "win32" ? null : record.pid

    let resolveSettle: () => void = () => {}
    const settle = new Promise<void>((resolve) => {
      resolveSettle = resolve
    })
    const live: Live = {
      child,
      record,
      exited: false,
      exitCode: null,
      signal: null,
      settle,
      resolveSettle,
      promoted: false,
      previewActive: true,
      fd: null,
      outDecoder: new StringDecoder("utf8"),
      errDecoder: new StringDecoder("utf8"),
      last: "",
      handlers: { out: () => {}, err: () => {} },
    }
    live.handlers.out = (chunk) => this.onChunk(live, "out", chunk, input.onPreview)
    live.handlers.err = (chunk) => this.onChunk(live, "err", chunk, input.onPreview)
    child.stdout?.on("data", live.handlers.out)
    child.stderr?.on("data", live.handlers.err)
    child.once("exit", (code, signal) => {
      live.exited = true
      live.exitCode = code
      live.signal = signal
      this.markExited(live)
      resolveSettle()
    })
    child.once("error", (error) => {
      live.exited = true
      live.exitCode = null
      live.signal = null
      record.spawnError = error instanceof Error ? error.message : String(error)
      this.markExited(live)
      resolveSettle()
    })

    this.pending.add(live)

    if (input.waitMs === 0) {
      const promoted = this.promote(live, "explicit")
      return {
        kind: "job",
        record: promoted,
        elapsedMs: Date.now() - promoted.startedAt,
        origin: "explicit",
        groupSurvivors: null,
      }
    }

    let outcome: "exit" | "timeout" | "abort" = await new Promise((resolve) => {
      let settled = false
      const done = (value: "exit" | "timeout" | "abort") => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.abort?.removeEventListener("abort", onAbort)
        resolve(value)
      }
      const timer = setTimeout(() => done("timeout"), Math.max(0, input.waitMs))
      const onAbort = () => done("abort")
      live.settle.then(() => done("exit"))
      if (input.abort?.aborted) onAbort()
      else input.abort?.addEventListener("abort", onAbort, { once: true })
    })
    if (live.exited) outcome = "exit"
    else if (input.abort?.aborted) outcome = "abort"

    if (outcome === "exit") {
      await sleep(this.opts.exitSettleMs)
      this.cleanupLive(live)
      this.pending.delete(live)
      record.status = "exited"
      record.exitCode = live.exitCode
      record.signal = live.signal
      record.completedAt = Date.now()
      record.updatedAt = Date.now()
      return {
        kind: "completed",
        record,
        raw: this.readAll(record),
        last: live.last,
        groupSurvivors: this.completedGroupState(record),
      }
    }

    if (outcome === "abort") {
      // Aborting the tool call must stop the command it started: never leave an
      // untracked process behind when the user presses Ctrl+C.
      live.previewActive = false
      record.status = "killed"
      record.killReason = "user"
      record.updatedAt = Date.now()
      await killProcessTree(record.pid, () => isPidAlive(record.pid))
      await Promise.race([live.settle, sleep(3000)])
      this.cleanupLive(live)
      this.pending.delete(live)
      record.exitCode = live.exitCode
      record.signal = live.signal
      record.completedAt = record.completedAt ?? Date.now()
      record.updatedAt = Date.now()
      return { kind: "aborted" }
    }

    const promoted = this.promote(live, "auto")
    return {
      kind: "job",
      record: promoted,
      elapsedMs: Date.now() - record.startedAt,
      origin: "auto",
      groupSurvivors: null,
    }
  }

  private onChunk(live: Live, stream: "out" | "err", chunk: Buffer, onPreview?: (last: string) => void): void {
    const record = live.record
    record.bytes += chunk.length
    record.lastOutputAt = Date.now()
    const text = (stream === "out" ? live.outDecoder : live.errDecoder).write(chunk)
    if (text) live.last = preview(live.last + text)
    if (live.previewActive) onPreview?.(live.last)

    if (!record.spilled) {
      record.buffer.push(chunk)
      record.newlines += countNewlines(chunk)
      if (
        record.bytes > this.opts.spillBytes ||
        (this.opts.spillLines > 0 && record.newlines > this.opts.spillLines)
      ) {
        this.spill(live)
      }
    } else if (live.fd !== null) {
      try {
        fs.writeSync(live.fd, chunk)
      } catch {}
    }

    if (live.promoted && !record.logLimitHit && this.opts.logMaxBytes > 0 && record.bytes > this.opts.logMaxBytes) {
      record.logLimitHit = true
      record.logTruncated = true
      void this.kill(record.id, "log_limit")
    }
  }

  private spill(live: Live): void {
    const record = live.record
    if (record.spilled) return
    let fd: number | null = null
    try {
      ensureDir(truncationDir())
      const file = newTruncationFilePath()
      fd = fs.openSync(file, "w")
      for (const chunk of record.buffer) fs.writeSync(fd, chunk)
      record.buffer = []
      record.spilled = true
      record.filePath = file
      live.fd = fd
    } catch {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {}
      }
    }
  }

  private cleanupLive(live: Live): void {
    const child = live.child
    try {
      child.stdout?.off("data", live.handlers.out)
      child.stderr?.off("data", live.handlers.err)
      const outTail = live.outDecoder.end()
      const errTail = live.errDecoder.end()
      if (outTail) live.last = preview(live.last + outTail)
      if (errTail) live.last = preview(live.last + errTail)
      child.stdout?.destroy()
      child.stderr?.destroy()
    } catch {}
    if (live.fd !== null) {
      try {
        fs.closeSync(live.fd)
      } catch {}
      live.fd = null
    }
  }

  private promote(live: Live, origin: JobOrigin): JobRecord {
    const record = live.record
    record.origin = origin
    record.updatedAt = Date.now()
    live.promoted = true
    live.previewActive = false
    this.pending.delete(live)
    this.live.set(record.id, live)
    this.records.set(record.id, record)
    if (this.opts.jobTtlMs > 0) {
      live.ttlTimer = setTimeout(() => void this.kill(record.id, "ttl"), this.opts.jobTtlMs)
      live.ttlTimer.unref?.()
    }
    live.settle.then(() => {
      void this.finalize(live)
    })
    return record
  }

  private async finalize(live: Live): Promise<void> {
    await sleep(this.opts.exitSettleMs)
    this.cleanupLive(live)
    if (live.ttlTimer) clearTimeout(live.ttlTimer)
    const record = live.record
    if (record.status === "running") record.status = "exited"
    record.exitCode = live.exitCode
    record.signal = live.signal
    record.completedAt = record.completedAt ?? Date.now()
    record.updatedAt = Date.now()
    this.live.delete(record.id)
    this.prune()
  }

  private prune(): void {
    const finished = Array.from(this.records.values())
      .filter((record) => record.status !== "running")
      .sort((a, b) => b.startedAt - a.startedAt)
    const keep = new Set(finished.slice(0, this.opts.logRetain).map((record) => record.id))
    for (const record of finished) {
      if (keep.has(record.id)) continue
      this.records.delete(record.id)
    }
    this.pruneCursors()
  }

  private pruneCursors(): void {
    if (this.cursors.size === 0) return
    for (const key of Array.from(this.cursors.keys())) {
      const id = key.slice(key.lastIndexOf("\n") + 1)
      if (!this.records.has(id)) this.cursors.delete(key)
    }
  }

  private readAll(record: JobRecord): string {
    if (record.spilled && record.filePath) {
      try {
        return fs.readFileSync(record.filePath, "utf-8")
      } catch {
        return ""
      }
    }
    return record.buffer.length > 0 ? Buffer.concat(record.buffer).toString("utf-8") : ""
  }

  jobTail(record: JobRecord, maxLines = 40, maxBytes = 8192): string {
    if (record.spilled && record.filePath) {
      const data = readTailBytes(record.filePath, Math.max(maxBytes, 8192))
      return tail(data.text, maxLines, maxBytes).text
    }
    const raw = record.buffer.length > 0 ? Buffer.concat(record.buffer).toString("utf-8") : ""
    return tail(raw, maxLines, maxBytes).text
  }

  // Full-output view for the /jobs dialog. Reads an explicit byte window
  // without touching the per-session read cursors that job_read owns, so
  // opening the viewer never consumes output the model has not read yet.
  jobOutput(record: JobRecord, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
    const start = Math.max(0, record.bytes - maxBytes)
    if (record.spilled && record.filePath) {
      return { text: readTailBytes(record.filePath, maxBytes).text, bytes: record.bytes, truncated: start > 0 }
    }
    return {
      text: readChunkFromBuffer(record.buffer, record.bytes, start, maxBytes, 0).text,
      bytes: record.bytes,
      truncated: start > 0,
    }
  }

  groupSurvivors(id: string): boolean | null {
    const record = this.records.get(id)
    if (!record) return null
    if (process.platform === "win32") return null
    if (record.status === "running") return null
    return isGroupAlive(record.pgid ?? undefined)
  }

  private completedGroupState(record: JobRecord): boolean | null {
    if (process.platform === "win32") return null
    return isGroupAlive(record.pgid ?? undefined)
  }

  private cursorKey(sessionID: string, id: string): string {
    return `${sessionID}\n${id}`
  }

  private advanceCursor(sessionID: string, id: string, offset: number): void {
    this.cursors.set(this.cursorKey(sessionID, id), Math.max(0, offset))
  }

  async read(
    sessionID: string,
    id: string,
    offset: number | undefined,
    waitMs: number,
    limits: { maxLines: number; maxBytes: number },
  ): Promise<ReadOutcome | undefined> {
    const record = this.records.get(id)
    if (!record) return undefined
    const cursor = this.cursorKey(sessionID, id)
    const start = Math.max(0, offset ?? this.cursors.get(cursor) ?? 0)
    const deadline = Date.now() + Math.max(0, waitMs)
    const chunkMaxBytes = Math.max(1024, limits.maxBytes - 4096)
    const chunkMaxLines = Math.max(4, limits.maxLines - 16)

    for (;;) {
      const from = start
      const chunk =
        record.spilled && record.filePath
          ? readChunkFrom(record.filePath, from, chunkMaxBytes, chunkMaxLines)
          : readChunkFromBuffer(record.buffer, record.bytes, from, chunkMaxBytes, chunkMaxLines)
      const silentForMs = Math.max(0, Date.now() - record.lastOutputAt)
      const alive = this.isAlive(record)
      if (chunk.text.length > 0) {
        this.advanceCursor(sessionID, id, chunk.nextOffset)
        const running = alive ? await this.settleRunning(record) : false
        return {
          record,
          text: chunk.text,
          nextOffset: chunk.nextOffset,
          running,
          silentForMs,
          stalled: running && silentForMs >= this.opts.stallAfterMs,
          stalledAfterMs: this.opts.stallAfterMs,
        }
      }
      if (!alive) {
        return {
          record,
          text: "",
          nextOffset: from,
          running: false,
          silentForMs,
          stalled: false,
          stalledAfterMs: this.opts.stallAfterMs,
        }
      }
      if (Date.now() >= deadline) {
        const running = await this.settleRunning(record)
        return {
          record,
          text: "",
          nextOffset: from,
          running,
          silentForMs,
          stalled: running && silentForMs >= this.opts.stallAfterMs,
          stalledAfterMs: this.opts.stallAfterMs,
        }
      }
      await sleep(Math.min(100, Math.max(10, deadline - Date.now())))
    }
  }

  async kill(id: string, reason: "user" | "log_limit" | "ttl" = "user"): Promise<JobRecord | undefined> {
    const record = this.records.get(id)
    if (!record) return undefined
    const live = this.live.get(id)
    if (record.status !== "running") return record
    if (live?.exited) {
      await this.finalize(live)
      return record
    }
    if (!live && !isPidAlive(record.pid)) {
      record.status = "exited"
      record.completedAt = record.completedAt ?? Date.now()
      record.updatedAt = Date.now()
      return record
    }
    record.status = "killed"
    record.killReason = reason
    record.updatedAt = Date.now()
    if (reason === "log_limit") record.logLimitHit = true
    await killProcessTree(record.pid, () => isPidAlive(record.pid))
    if (live) {
      await Promise.race([live.settle, sleep(3000)])
      this.cleanupLive(live)
      if (live.ttlTimer) clearTimeout(live.ttlTimer)
      record.exitCode = live.exitCode
      record.signal = live.signal
      this.live.delete(id)
    }
    record.completedAt = record.completedAt ?? Date.now()
    this.prune()
    return record
  }

  list(sessionID?: string): ListOutcome {
    const entries: JobRecord[] = []
    let running = 0
    for (const record of this.records.values()) {
      if (sessionID && record.sessionID !== sessionID) continue
      if (record.status === "running") running++
      entries.push(record)
    }
    entries.sort((a, b) => a.startedAt - b.startedAt)
    return { entries, running, max: this.opts.maxJobs }
  }

  async killSessionJobs(sessionID: string): Promise<void> {
    for (const record of Array.from(this.records.values())) {
      if (record.sessionID !== sessionID) continue
      if (record.status === "running") await this.kill(record.id)
    }
  }

  async dispose(): Promise<void> {
    const running = Array.from(this.records.values()).filter((record) => record.status === "running")
    await Promise.all(running.map((record) => this.kill(record.id)))
    for (const live of Array.from(this.pending)) {
      this.cleanupLive(live)
      if (live.ttlTimer) clearTimeout(live.ttlTimer)
      await killProcessTree(live.record.pid, () => isPidAlive(live.record.pid))
    }
    this.pending.clear()
    this.live.clear()
    this.cursors.clear()
  }
}

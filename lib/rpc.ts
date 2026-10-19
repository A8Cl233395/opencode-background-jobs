// Shared between the server plugin (registers the handlers) and the TUI
// plugin (calls them over the plugin RPC bridge). Plain JSON Schema keeps both
// sides dependency-free, matching the other local plugins in this config.

export type JobView = {
  id: string
  pid: number
  command: string
  workdir: string
  status: "running" | "exited" | "killed"
  exitCode: number | null
  signal: string | null
  startedAt: number
  completedAt: number | null
  lastOutputAt: number
  bytes: number
  origin: "auto" | "explicit"
  killReason: "user" | "log_limit" | "ttl" | null
  preview: string
}

// The /jobs output viewer streams the tail of a job's log; bounding the window
// keeps one dialog render reasonable while covering the recent output of most
// commands. The server reports `truncated` when earlier bytes were dropped.
export const OUTPUT_WINDOW_BYTES = 128 * 1024

export type JobOutputView = {
  id: string
  status: "running" | "exited" | "killed" | "missing"
  exitCode: number | null
  completedAt: number | null
  text: string
  bytes: number
  truncated: boolean
}

const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] }
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] }

const jobViewSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    pid: { type: "integer" },
    command: { type: "string" },
    workdir: { type: "string" },
    status: { type: "string" },
    exitCode: nullableInteger,
    signal: nullableString,
    startedAt: { type: "number" },
    completedAt: nullableInteger,
    lastOutputAt: { type: "number" },
    bytes: { type: "integer" },
    origin: { type: "string" },
    killReason: nullableString,
    preview: { type: "string" },
  },
  required: [
    "id",
    "pid",
    "command",
    "workdir",
    "status",
    "exitCode",
    "signal",
    "startedAt",
    "completedAt",
    "lastOutputAt",
    "bytes",
    "origin",
    "killReason",
    "preview",
  ],
  additionalProperties: false,
} as const

const jobOutputSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { type: "string" },
    exitCode: nullableInteger,
    completedAt: nullableInteger,
    text: { type: "string" },
    bytes: { type: "integer" },
    truncated: { type: "boolean" },
  },
  required: ["id", "status", "exitCode", "completedAt", "text", "bytes", "truncated"],
  additionalProperties: false,
} as const

export const BackgroundJobsRpc = {
  id: "background-jobs",
  methods: {
    list: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          jobs: { type: "array", items: jobViewSchema },
          running: { type: "integer" },
          max: { type: "integer" },
        },
        required: ["jobs", "running", "max"],
        additionalProperties: false,
      },
    },
    kill: {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    output: {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output: jobOutputSchema,
    },
  },
  events: {},
} as const

// Escape sequences and control bytes would otherwise render as garbage in the
// TUI preview line.
const ESCAPE_SEQUENCES = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

export function singleLinePreview(text: string, max = 120): string {
  const flat = text
    .replace(ESCAPE_SEQUENCES, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

// Full-output views keep their line structure: unlike singleLinePreview, only
// escape sequences and carriage returns are normalized here.
export function plainOutput(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "").replace(/\r\n?/g, "\n")
}

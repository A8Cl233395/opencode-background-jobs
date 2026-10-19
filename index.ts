import { BackgroundJobsRpc, OUTPUT_WINDOW_BYTES, plainOutput, singleLinePreview, type JobView } from "./lib/rpc"
import type { JobRecord } from "./lib/jobs"
import { createBundle, type ToolInfoLike } from "./lib/tools"

type SessionTool = { description: string; input: unknown }

type PluginContext = {
  options?: Record<string, unknown>
  location: { directory: string }
  rpc?: {
    register: (
      definition: unknown,
      handlers: Record<string, (input: any, context: { signal: AbortSignal }) => Promise<unknown>>,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
  tool: {
    transform: (callback: (editor: { add: (tool: ToolInfoLike) => void }) => void) => Promise<unknown>
  }
  session: {
    hook: (
      name: "context" | "compaction" | "generate",
      callback: (event: { tools: Record<string, SessionTool> }) => void,
    ) => Promise<unknown>
  }
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<{
      type: string
      data?: { sessionID?: string }
    }>
  }
}

export default {
  id: "opencode-background-jobs",
  setup: async (ctx: PluginContext) => {
    const bundle = createBundle({
      directory: ctx.location.directory,
      options: ctx.options,
    })
    const controller = new AbortController()

    await ctx.tool.transform((editor) => {
      for (const tool of bundle.tools) editor.add(tool)
    })

    const enforceDescription = (event: { tools: Record<string, SessionTool> }) => {
      const tool = event.tools.shell
      if (tool) tool.description = bundle.description
    }
    await ctx.session.hook("context", enforceDescription)
    await ctx.session.hook("compaction", enforceDescription)
    await ctx.session.hook("generate", enforceDescription)

    if (bundle.killOnSessionEnd) {
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.deleted") continue
          if (typeof event.data?.sessionID === "string") await bundle.registry.killSessionJobs(event.data.sessionID)
        }
      })().catch(() => {})
    }

    // Serves the TUI /jobs dialog. Optional so an older server host without
    // the RPC bridge still loads the plugin and keeps the tools working.
    let registration: { dispose: () => Promise<void> } | undefined
    if (ctx.rpc) {
      const toView = (record: JobRecord): JobView => ({
        id: record.id,
        pid: record.pid,
        command: record.command,
        workdir: record.workdir,
        status: record.status,
        exitCode: record.exitCode,
        signal: record.signal,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        lastOutputAt: record.lastOutputAt,
        bytes: record.bytes,
        origin: record.origin,
        killReason: record.killReason,
        preview: singleLinePreview(bundle.registry.jobTail(record, 2, 240)),
      })
      registration = await ctx.rpc.register(BackgroundJobsRpc, {
        list: async (input: { sessionID: string }) => {
          const result = bundle.registry.list(input.sessionID)
          return { jobs: result.entries.map(toView), running: result.running, max: result.max }
        },
        kill: async (input: { id: string }) => {
          const record = bundle.registry.get(input.id)
          if (!record) return { ok: false }
          await bundle.registry.kill(input.id)
          return { ok: true }
        },
        output: async (input: { id: string }) => {
          const record = bundle.registry.get(input.id)
          if (!record) {
            return {
              id: input.id,
              status: "missing",
              exitCode: null,
              completedAt: null,
              text: "",
              bytes: 0,
              truncated: false,
            }
          }
          const view = bundle.registry.jobOutput(record, OUTPUT_WINDOW_BYTES)
          return {
            id: record.id,
            status: record.status,
            exitCode: record.exitCode,
            completedAt: record.completedAt,
            text: plainOutput(view.text),
            bytes: view.bytes,
            truncated: view.truncated,
          }
        },
      })
    }

    return async () => {
      controller.abort()
      await registration?.dispose()
      await bundle.registry.dispose()
    }
  },
}

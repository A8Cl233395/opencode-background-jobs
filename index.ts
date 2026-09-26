import { createBundle, type ToolInfoLike } from "./lib/tools"

type SessionTool = { description: string; input: unknown }

type PluginContext = {
  options?: Record<string, unknown>
  location: { directory: string }
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

    return async () => {
      controller.abort()
      await bundle.registry.dispose()
    }
  },
}

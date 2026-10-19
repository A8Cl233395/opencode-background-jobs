/** @jsxImportSource @opentui/solid */
// TUI half of the background-jobs plugin: the /jobs command opens a live
// dialog listing the selected session's background jobs. Job data comes from
// the server plugin over the plugin RPC bridge (lib/rpc.ts); the TUI loads
// this file through the server inventory's features.tui flag.
import { RGBA, TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, onCleanup, For, Show } from "solid-js"
import { BackgroundJobsRpc, OUTPUT_WINDOW_BYTES, type JobOutputView, type JobView } from "./lib/rpc"
import { formatElapsed } from "./lib/truncate"

type Ctx = {
  theme: unknown
  renderer: { requestRender(): void }
  client: { rpc: (definition: unknown) => any }
  data: {
    session: { get(sessionID: string): { title?: string; location?: { directory: string } } | undefined }
  }
  keymap: { layer: (input: () => unknown) => void }
  ui: {
    toast: {
      show: (options: {
        title?: string
        message: string
        variant?: "info" | "success" | "warning" | "error"
        duration?: number
      }) => void
    }
    dialog: {
      show: (render: () => unknown, onClose?: () => void) => void
      set: (options: { size?: "medium" | "large" | "xlarge"; centered?: boolean }) => void
      clear: () => void
      confirm: (options: {
        title: string
        message: string
        label?: { confirm?: string; cancel?: string }
      }) => Promise<boolean | undefined>
    }
    router: { current(): { type: string; sessionID?: string } }
    slot: (claim: { append: string; render: () => unknown }) => () => void
  }
}

// Theme tokens moved between OpenCode 2 releases; resolve every shape with a
// neutral fallback so a missing token can never leave an undefined color.
const FALLBACK_COLOR = RGBA.fromHex("#888888")

type Palette = {
  base: RGBA
  muted: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  accent: RGBA
  buttonBg: RGBA
  buttonFg: RGBA
}

function firstColor(...values: unknown[]): RGBA {
  for (const value of values) if (value instanceof RGBA) return value
  return FALLBACK_COLOR
}

function stateful(value: unknown): unknown {
  return (value as { focused?: unknown; base?: unknown } | undefined)?.focused ??
    (value as { base?: unknown } | undefined)?.base
}

function palette(theme: unknown): Palette {
  const root = (theme ?? {}) as Record<string, any>
  const text = (root.text ?? {}) as Record<string, any>
  const background = (root.background ?? {}) as Record<string, any>
  const feedback = (text.feedback ?? {}) as Record<string, Record<string, any> | undefined>
  const muted = firstColor(text.muted, text.subdued, text.base, text.default)
  const tone = (kind: string) => firstColor(feedback[kind]?.base, feedback[kind]?.default, muted)
  const action = (side: Record<string, any> | undefined) =>
    (side?.action?.primary ?? {}) as Record<string, any>
  return {
    base: firstColor(text.base, text.default, muted),
    muted,
    error: tone("error"),
    warning: tone("warning"),
    success: tone("success"),
    accent: firstColor(root.hue?.accent?.[500], tone("info")),
    buttonBg: firstColor(stateful(action(background).focused), stateful(action(background).base), root.hue?.accent?.[500]),
    buttonFg: firstColor(stateful(action(text).focused), stateful(action(text).base), text.base),
  }
}

function displayCommand(command: string, max = 44): string {
  const single = command.replace(/\s+/g, " ").trim()
  if (single.length <= max) return single
  return `${single.slice(0, max - 3)}...`
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function statusLabel(job: JobView): string {
  if (job.status === "running") return "● running"
  if (job.status === "killed") {
    return job.killReason && job.killReason !== "user" ? `✕ killed (${job.killReason})` : "✕ killed"
  }
  if (job.exitCode === null) return "✕ failed"
  if (job.exitCode === 0) return "✓ exited"
  return `✕ exit ${job.exitCode}`
}

function statusColor(job: JobView, p: Palette): RGBA {
  if (job.status === "running") return p.success
  if (job.status === "killed") return p.error
  if (job.exitCode === null) return p.error
  if (job.exitCode === 0) return p.muted
  return p.warning
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  // RPC failures arrive as plain { type, message } objects.
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

function JobsDialog(props: { ctx: Ctx; sessionID: string; p: Palette; close: () => void; reopen: () => void }) {
  const rpc = props.ctx.client.rpc(BackgroundJobsRpc)
  // Jobs are owned by the plugin instance of the session's location, and the
  // RPC bridge routes by location — every call must carry it explicitly.
  const callOptions = () => {
    const directory = props.ctx.data.session.get(props.sessionID)?.location?.directory
    return directory ? { location: { directory } } : undefined
  }
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal<{ jobs: JobView[]; running: number; max: number }>()
  const [error, setError] = createSignal("")
  const [selected, setSelected] = createSignal(0)

  // The output pane replaces the list in place, so escape steps back to the
  // list instead of closing the dialog.
  const [viewing, setViewing] = createSignal<JobView>()
  const [output, setOutput] = createSignal<JobOutputView>()
  const [outputError, setOutputError] = createSignal("")
  const [clock, setClock] = createSignal(Date.now())
  let outputScroll: ScrollBoxRenderable | undefined
  let outputDone = false

  const refresh = async () => {
    try {
      const result = await rpc.list({ sessionID: props.sessionID }, callOptions())
      setState(result)
      setError("")
      if (selected() >= result.jobs.length) setSelected(Math.max(0, result.jobs.length - 1))
    } catch (caught) {
      setError(errorText(caught))
    }
    props.ctx.renderer.requestRender()
  }
  void refresh()

  const refreshOutput = async () => {
    const job = viewing()
    if (!job) return
    try {
      const result: JobOutputView = await rpc.output({ id: job.id }, callOptions())
      if (viewing()?.id !== job.id) return
      setOutput((previous) =>
        previous && previous.bytes === result.bytes && previous.status === result.status && previous.text === result.text
          ? previous
          : result,
      )
      setOutputError("")
      if (result.status !== "running") outputDone = true
    } catch (caught) {
      if (viewing()?.id !== job.id) return
      setOutputError(errorText(caught))
    }
    props.ctx.renderer.requestRender()
  }

  const openOutput = (job: JobView) => {
    setViewing(job)
    setOutput(undefined)
    setOutputError("")
    outputDone = false
    props.ctx.ui.dialog.set({ size: "xlarge" })
    void refreshOutput()
  }

  const closeOutput = () => {
    setViewing(undefined)
    setOutput(undefined)
    setOutputError("")
    outputDone = false
    outputScroll = undefined
    props.ctx.ui.dialog.set({ size: "large" })
  }

  const timer = setInterval(() => {
    if (!viewing()) {
      void refresh()
      return
    }
    // Poll until the job reaches a terminal state; the last response carries
    // the final flushed output.
    if (outputDone) return
    setClock(Date.now())
    void refreshOutput()
  }, 1000)
  onCleanup(() => clearInterval(timer))

  const count = () => state()?.jobs.length ?? 0
  const current = () => state()?.jobs[Math.min(selected(), Math.max(0, count() - 1))]

  const killSelected = async () => {
    const job = current()
    if (!job || job.status !== "running") return
    const confirmed = await props.ctx.ui.dialog.confirm({
      title: "Kill background job",
      message: `Kill job #${job.id}?\n${displayCommand(job.command, 64)}`,
      label: { confirm: "Kill", cancel: "Cancel" },
    })
    if (confirmed) {
      try {
        const result = await rpc.kill({ id: job.id }, callOptions())
        if (result.ok) {
          props.ctx.ui.toast.show({
            title: "background-jobs",
            message: `killed job #${job.id}`,
            variant: "success",
          })
        } else {
          props.ctx.ui.toast.show({
            title: "background-jobs",
            message: `job #${job.id} was not found in the session's job registry`,
            variant: "error",
          })
        }
      } catch (caught) {
        props.ctx.ui.toast.show({
          title: "background-jobs",
          message: `kill #${job.id} failed: ${errorText(caught)}`,
          variant: "error",
        })
      }
    }
    props.reopen()
  }

  const p = props.p
  const subtitle = () => {
    const running = state()?.running ?? 0
    const max = state()?.max ?? 0
    const title = props.ctx.data.session.get(props.sessionID)?.title
    return `${running}/${max} running${title ? ` · ${title}` : ""}`
  }

  // Matches the built-in shell output dialog: a viewport tall enough to read a
  // log while staying inside small terminals.
  const outputHeight = () => Math.max(3, Math.floor(dimensions().height * 0.6) - 6)
  const outputSubtitle = () => {
    const job = viewing()
    if (!job) return ""
    const view = output()
    if (!view) return outputError() ? "" : "loading..."
    const status =
      view.status === "running"
        ? "● running"
        : view.status === "missing"
          ? "✕ job no longer tracked"
          : view.status === "killed"
            ? "✕ killed"
            : view.exitCode === null
              ? "✕ exited"
              : `✓ exit ${view.exitCode}`
    const end = view.status === "running" ? clock() : view.completedAt ?? clock()
    return `${status} · ${formatElapsed(end - job.startedAt)} · ${humanBytes(view.bytes)}`
  }

  // Scoped to this dialog's mount; the host pushes "modal" mode while a
  // dialog owns input, so the binds only exist while it is open. The layer is
  // reactive: opening a job's output swaps the binds for scrolling, and escape
  // then steps back to the list instead of closing the dialog.
  props.ctx.keymap.layer(() => {
    if (viewing()) {
      return {
        mode: "modal",
        commands: [
          { bind: "escape", run: () => closeOutput() },
          { bind: "return", run: () => closeOutput() },
          { bind: "up", run: () => outputScroll?.scrollBy(-1) },
          { bind: "down", run: () => outputScroll?.scrollBy(1) },
          { bind: "pageup", run: () => outputScroll?.scrollBy(-outputHeight()) },
          { bind: "pagedown", run: () => outputScroll?.scrollBy(outputHeight()) },
          { bind: "home", run: () => outputScroll?.scrollTo(0) },
          { bind: "end", run: () => outputScroll?.scrollTo(Infinity) },
        ],
      }
    }
    return {
      mode: "modal",
      commands: [
        { bind: "escape", run: () => props.close() },
        {
          bind: "return",
          run: () => {
            const job = current()
            if (job) openOutput(job)
          },
        },
        { bind: "up", run: () => setSelected((value) => Math.max(0, value - 1)) },
        { bind: "down", run: () => setSelected((value) => Math.min(count() - 1, value + 1)) },
        { bind: "k", run: () => void killSelected() },
      ],
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <Show when={viewing()}>
        {(job) => (
          <box flexDirection="column" gap={1}>
            <box flexDirection="row" justifyContent="space-between">
              <text attributes={TextAttributes.BOLD} fg={p.base}>
                Job #{job().id} output
              </text>
              <text fg={p.muted} onMouseUp={() => closeOutput()}>
                esc back
              </text>
            </box>
            <text fg={p.muted} wrapMode="none">
              {displayCommand(job().command, 96)}
            </text>
            <text fg={p.muted} wrapMode="none">
              {outputSubtitle()}
            </text>
            <Show when={output()?.truncated}>
              <text fg={p.muted} wrapMode="none">
                {`Earlier output omitted · showing last ${humanBytes(OUTPUT_WINDOW_BYTES)} of ${humanBytes(
                  output()?.bytes ?? 0,
                )}`}
              </text>
            </Show>
            <Show when={outputError()}>
              <text fg={p.error} wrapMode="none">
                {outputError()}
              </text>
            </Show>
            <Show when={output()}>
              {(view) => (
                <scrollbox
                  ref={(element: ScrollBoxRenderable) => (outputScroll = element)}
                  height={outputHeight()}
                  stickyScroll
                  stickyStart="bottom"
                  scrollbarOptions={{ visible: false }}
                >
                  <text fg={p.base} wrapMode="word">
                    {view().text || "(no output)"}
                  </text>
                </scrollbox>
              )}
            </Show>
            <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
              <text fg={p.muted}>↑↓ scroll · pgup/pgdn page · end follow · esc back</text>
              <box paddingLeft={3} paddingRight={3} backgroundColor={p.buttonBg} onMouseUp={() => closeOutput()}>
                <text fg={p.buttonFg}>back</text>
              </box>
            </box>
          </box>
        )}
      </Show>
      <Show when={!viewing()}>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={p.base}>
            Background jobs
          </text>
          <text fg={p.muted} onMouseUp={() => props.close()}>
            esc
          </text>
        </box>
        <text fg={p.muted} wrapMode="none">
          {subtitle()}
        </text>
        <Show when={error()}>
          <text fg={p.error} wrapMode="none">
            {error()}
          </text>
        </Show>
        <Show when={!error() && state() === undefined}>
          <text fg={p.muted}>loading...</text>
        </Show>
        <Show when={state() !== undefined && count() === 0}>
          <box paddingBottom={1}>
            <text fg={p.muted}>No background jobs in this session.</text>
          </box>
        </Show>
        <For each={state()?.jobs ?? []}>
          {(job, index) => {
            const active = () => selected() === index()
            const elapsed = formatElapsed(
              (job.status === "running" ? Date.now() : job.completedAt ?? Date.now()) - job.startedAt,
            )
            return (
              <box flexDirection="column" flexShrink={0}>
                <box flexDirection="row" height={1} flexShrink={0}>
                  <text
                    attributes={active() ? TextAttributes.BOLD : undefined}
                    fg={active() ? p.base : p.muted}
                    wrapMode="none"
                  >
                    {`${active() ? "▶ " : "  "}#${job.id}`.padEnd(7)}
                  </text>
                  <text attributes={active() ? TextAttributes.BOLD : undefined} fg={statusColor(job, p)} wrapMode="none">
                    {statusLabel(job).padEnd(15)}
                  </text>
                  <text attributes={active() ? TextAttributes.BOLD : undefined} fg={p.muted} wrapMode="none">
                    {`${elapsed.padEnd(7)}  ${humanBytes(job.bytes).padEnd(9)}  `}
                  </text>
                  <text attributes={active() ? TextAttributes.BOLD : undefined} fg={p.base} wrapMode="none">
                    {displayCommand(job.command)}
                  </text>
                </box>
                <Show when={job.preview}>
                  <text fg={p.muted} wrapMode="none">
                    {`    ${job.preview}`}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
        <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
          <Show when={count() > 0} fallback={<box />}>
            <text fg={p.muted}>↑↓ select · enter output · k kill running</text>
          </Show>
          <box
            paddingLeft={3}
            paddingRight={3}
            backgroundColor={p.buttonBg}
            onMouseUp={() => props.close()}
          >
            <text fg={p.buttonFg}>close</text>
          </box>
        </box>
      </Show>
    </box>
  )
}

export default {
  id: "opencode-background-jobs",
  setup: (ctx: Ctx) => {
    const p = palette(ctx.theme)
    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      ctx.ui.toast.show({ title: "background-jobs", message, variant, duration: 4000 })

    const openJobs = (sessionID: string) => {
      ctx.ui.dialog.show(
        () => (
          <JobsDialog
            ctx={ctx}
            sessionID={sessionID}
            p={p}
            close={() => ctx.ui.dialog.clear()}
            reopen={() => openJobs(sessionID)}
          />
        ),
      )
      ctx.ui.dialog.set({ size: "large" })
    }

    const commands = [
      {
        id: "background-jobs.jobs",
        title: "Background jobs",
        description: "Show the selected session's background jobs",
        group: "Jobs",
        palette: true,
        slash: { name: "jobs" },
        run() {
          const route = ctx.ui.router.current()
          if (route.type !== "session" || !route.sessionID) {
            toast("open a session first: /jobs shows the selected session's jobs", "warning")
            return
          }
          openJobs(route.sessionID)
        },
      },
    ]

    ctx.ui.slot({
      append: "app",
      render() {
        ctx.keymap.layer(() => ({ mode: "global", commands }))
        return null
      },
    })
  },
}

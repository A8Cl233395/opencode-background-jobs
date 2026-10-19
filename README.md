# opencode-background-jobs

English | [中文](README.zh-CN.md)

Shell commands that outlive their tool call. This OpenCode server plugin
replaces the built-in `shell` tool with a version that promotes long-running
commands to tracked **background jobs** instead of killing them at the timeout,
and adds three companion tools to manage those jobs. A bundled TUI half adds a
live `/jobs` dialog for inspecting and stopping them.

## Tools

| Tool | Description |
|---|---|
| `shell` | Same interface as the built-in shell tool (`command`, `workdir`, `timeout`), with one behavioral change: a foreground command that does not finish within the wait window is **moved to a background job instead of being killed**, and the tool returns a job receipt. `timeout: 0` starts a command in the background immediately, then performs one automatic read for its first output (up to 3 seconds); all timeouts are hard-capped at 15 minutes. |
| `job_list` | List the session's jobs: id, command, status (running / exited / killed), elapsed time and exit code. |
| `job_read` | Read job output incrementally. A per-session read position is tracked per job, so successive reads return only new output; `offset: 0` re-reads from the beginning, and `timeout` blocks for new output or exit (default 5 seconds, clamped to `job_read_max_wait_ms`). |
| `job_kill` | Stop a job with its child processes (whole process group on Unix, tree kill on Windows) and return the final status plus any unread output. |

Jobs are tracked per session and live for the current OpenCode instance.

## Jobs dialog

The repository also ships `tui.tsx`, the TUI half of the plugin. It adds a
`/jobs` dialog for the selected session: live status, elapsed time, a command
preview, output viewing, and a kill action. The dialog talks to the server half
over the plugin RPC bridge (`lib/rpc.ts`); on a host without that bridge the
server plugin still loads and the tools keep working, only the dialog is
unavailable.

Copy `tui.tsx` alongside `index.ts` when installing from source.

## Install

Copy the plugin folder into your OpenCode plugin directory:

```
~/.config/opencode/plugin/background-jobs/
  index.ts
  lib/
    config.ts
    describe.ts
    jobs.ts
    ...
```

Restart OpenCode. The plugin registers itself; no configuration is required.

## Options

Every option can be set either in the `plugin` entry of `opencode.json` (or the
plugin options object of your build) or through the matching environment
variable:

| Option | Environment | Default | Description |
|---|---|---|---|
| `inline_wait_ms` | `OPENCODE_BASH_BG_INLINE_WAIT_MS` | `30000` | How long a foreground command may run before it is promoted to a background job (hard-capped at 15 minutes). |
| `max_jobs` | `OPENCODE_BASH_BG_MAX_JOBS` | `8` | Maximum number of concurrently running jobs; starting one more raises a job-limit error. |
| `log_max_bytes` | `OPENCODE_BASH_BG_LOG_MAX_BYTES` | `67108864` (64 MiB) | Output cap for a promoted job; when exceeded the job is killed and flagged as truncated. `0` disables the cap. |
| `log_retain` | `OPENCODE_BASH_BG_LOG_RETAIN` | `20` | How many finished job records/logs are kept; older ones are pruned. |
| `stall_after_ms` | `OPENCODE_BASH_BG_STALL_AFTER_MS` | `30000` | A running job with no output for this long is reported as *stalled*. |
| `exit_settle_ms` | `OPENCODE_BASH_BG_EXIT_SETTLE_MS` | `200` | Grace period after process exit before the final output and status are recorded. |
| `job_read_max_wait_ms` | `OPENCODE_BASH_BG_JOB_READ_MAX_WAIT_MS` | `60000` | Upper bound for the `timeout` argument of `job_read` (hard-capped at 15 minutes). |
| `job_read_default_wait_ms` | `OPENCODE_BASH_BG_JOB_READ_DEFAULT_WAIT_MS` | `5000` | Default wait for `job_read` when `timeout` is omitted. |
| `example_wait_ms` | `OPENCODE_BASH_BG_EXAMPLE_WAIT_MS` | `5000` | Example wait value shown in the generated `job_read` tool description. |
| `job_ttl_ms` | `OPENCODE_BASH_BG_JOB_TTL_MS` | `0` | Maximum lifetime of a background job; when it expires the job is killed with reason `ttl`. `0` disables the limit. |
| `kill_on_session_end` | `OPENCODE_BASH_BG_KILL_ON_SESSION_END` | `false` | Kill a session's jobs when that session is deleted. |

## Notes

- All timeouts are hard-capped at 15 minutes: `shell.timeout`, `job_read.timeout`, `inline_wait_ms` and `job_read_max_wait_ms` are clamped to 900000 ms.
- Large outputs spill from memory to a file under the OpenCode data directory
  (`$XDG_DATA_HOME/opencode/tool-output`, by default
  `~/.local/share/opencode/tool-output`), and `job_read` keeps reading them
  transparently.
- `job_kill` kills the whole process group on Unix and the whole process tree on
  Windows, so compilers, dev servers and watchers do not leak.
- Commands that exceed their wait window are *promoted*, never killed: the tool
  result contains the job id and a short receipt; continue with `job_read`.
  `timeout: 0` goes straight to the background and returns one incremental read,
  so a command that finishes or produces output within the window costs no
  follow-up `job_read`.
- Aborting a `shell` call stops the command it started instead of leaving an
  untracked process behind. Once the receipt is returned, the job belongs to the
  session and must be stopped with `job_kill`.
- Restarting OpenCode drops the registry; jobs of a previous instance are not
  re-adopted.

## License

MIT

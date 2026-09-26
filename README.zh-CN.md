# opencode-background-jobs

[English](README.md) | 中文

让 shell 命令活过工具调用本身。这是一个 OpenCode 服务端插件：它把内置的
`shell` 工具替换成一个会把长时间运行的命令**转成受管理的后台任务**（而不是
在超时时杀掉）的版本，并附带三个管理后台任务的工具。

## 工具

| 工具 | 说明 |
|---|---|
| `shell` | 与内置 shell 工具接口一致（`command`、`workdir`、`timeout`），只有一处行为变化：在前台等待窗口内没有结束的命令会被**转入后台任务，而不是被杀掉**，工具会返回任务回执。`timeout: 0` 表示立即在后台启动。 |
| `job_list` | 列出当前会话的任务：id、命令、状态（running / exited / killed）、已运行时间和退出码。 |
| `job_read` | 增量读取任务输出。每个会话对每个任务单独记录读取位置，连续读取只返回新增输出；`offset: 0` 从头重读，`wait_ms` 会阻塞等待新输出或任务退出。 |
| `job_kill` | 结束任务及其子进程（Unix 上杀整个进程组，Windows 上杀进程树），并返回最终状态和尚未读取的输出。 |

任务按会话隔离，只在当前 OpenCode 实例存活期间有效。

## 安装

把插件文件夹复制到 OpenCode 插件目录：

```
~/.config/opencode/plugin/background-jobs/
  index.ts
  lib/
    config.ts
    describe.ts
    jobs.ts
    ...
```

重启 OpenCode。插件会自行注册，无需配置。

## 配置项

所有配置项都可以写在 `opencode.json` 的 `plugin` 条目（或你的版本对应的插件
选项对象）里，也可以通过对应的环境变量设置：

| 选项 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `inline_wait_ms` | `OPENCODE_BASH_BG_INLINE_WAIT_MS` | `30000` | 前台命令运行多久后被转入后台任务。 |
| `max_jobs` | `OPENCODE_BASH_BG_MAX_JOBS` | `8` | 同时运行的任务数上限；超过会抛出任务数上限错误。 |
| `log_max_bytes` | `OPENCODE_BASH_BG_LOG_MAX_BYTES` | `67108864`（64 MiB） | 单个后台任务的输出上限；超过则杀掉该任务并标记为已截断。`0` 表示不限制。 |
| `log_retain` | `OPENCODE_BASH_BG_LOG_RETAIN` | `20` | 保留多少个已完成任务的记录 / 日志，更旧的会被清理。 |
| `stall_after_ms` | `OPENCODE_BASH_BG_STALL_AFTER_MS` | `30000` | 运行中的任务多久没有输出就被标记为 *stalled*（停滞）。 |
| `exit_settle_ms` | `OPENCODE_BASH_BG_EXIT_SETTLE_MS` | `200` | 进程退出后、记录最终输出与状态前的宽限时间。 |
| `job_read_max_wait_ms` | `OPENCODE_BASH_BG_JOB_READ_MAX_WAIT_MS` | `60000` | `job_read` 的 `wait_ms` 参数上限。 |
| `example_wait_ms` | `OPENCODE_BASH_BG_EXAMPLE_WAIT_MS` | `5000` | 生成的 `job_read` 工具说明里展示的示例等待值。 |
| `job_ttl_ms` | `OPENCODE_BASH_BG_JOB_TTL_MS` | `0` | 后台任务的最长存活时间；到期后以 `ttl` 原因杀掉。`0` 表示不限制。 |
| `kill_on_session_end` | `OPENCODE_BASH_BG_KILL_ON_SESSION_END` | `false` | 会话被删除时是否杀掉该会话的遗留任务。 |

## 说明

- 输出过大时会从内存溢写到 OpenCode 数据目录下的文件
  （`$XDG_DATA_HOME/opencode/tool-output`，默认
  `~/.local/share/opencode/tool-output`），`job_read` 仍能透明地继续读取。
- `job_kill` 在 Unix 上杀整个进程组、在 Windows 上杀整个进程树，编译器、
  开发服务器、文件监听器都不会残留。
- 超过等待窗口的命令只会被*转入后台*，不会被杀：工具结果里包含任务 id 和简短
  回执，后续用 `job_read` 继续读取。
- 重启 OpenCode 会丢失任务注册表，之前实例的任务不会被重新接管。

## License

MIT

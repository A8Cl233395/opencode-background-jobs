import { spawn, type ChildProcess } from "node:child_process"
import { isPowerShell, shellName } from "./shell"

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

export function isGroupAlive(pgid: number | undefined): boolean {
  if (process.platform === "win32") return false
  if (!pgid || !Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

export function spawnCommand(input: {
  shell: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
}): ChildProcess {
  const stdio: Array<"ignore" | "pipe"> = ["ignore", "pipe", "pipe"]
  const base: Record<string, unknown> = {
    cwd: input.cwd,
    env: input.env,
    stdio,
    windowsHide: true,
  }
  if (process.platform === "win32") {
    if (isPowerShell(input.shell)) {
      return spawn(
        input.shell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command],
        { ...base, detached: false } as never,
      )
    }
    if (shellName(input.shell) === "cmd") {
      return spawn(input.command, [], { ...base, shell: input.shell, detached: false } as never)
    }
    return spawn(input.shell, ["-c", input.command], { ...base, detached: false } as never)
  }
  return spawn(input.command, [], { ...base, shell: input.shell, detached: true } as never)
}

async function taskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
      stdio: "ignore",
      windowsHide: true,
    })
    killer.once("exit", finish)
    killer.once("error", finish)
  })
}

export async function killProcessTree(pid: number, isAlive: () => boolean): Promise<void> {
  if (!pid) return
  if (process.platform === "win32") {
    if (!isAlive()) return
    await taskkill(pid)
    return
  }
  if (!isAlive()) return
  try {
    process.kill(-pid, "SIGTERM")
    await sleep(200)
    if (isAlive()) process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
    await sleep(200)
    if (isAlive()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
}

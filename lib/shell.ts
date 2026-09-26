import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const META: Record<string, { deny?: boolean; posix?: boolean; ps?: boolean }> = {
  bash: { posix: true },
  dash: { posix: true },
  fish: { deny: true },
  ksh: { posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { posix: true },
  zsh: { posix: true },
}

export function windowsPath(p: string): string {
  if (process.platform !== "win32") return p
  return p
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function which(cmd: string): string | undefined {
  if (!cmd) return undefined
  if (path.isAbsolute(cmd) || /^[A-Za-z]:[\\/]/.test(cmd)) return isFile(cmd) ? cmd : undefined
  const pathEnv = process.env.PATH ?? process.env.Path ?? ""
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((item) => item !== "")
      : [""]
  const hasExt = path.extname(cmd) !== ""
  const names =
    process.platform === "win32" && !hasExt
      ? exts.flatMap((ext) => [`${cmd}${ext.toLowerCase()}`, `${cmd}${ext.toUpperCase()}`])
      : [cmd]
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

export function gitBash(): string | undefined {
  if (process.platform !== "win32") return undefined
  if (process.env.OPENCODE_GIT_BASH_PATH) return process.env.OPENCODE_GIT_BASH_PATH
  const git = which("git")
  if (!git) return undefined
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  try {
    if (fs.statSync(file).size > 0) return file
  } catch {}
  return undefined
}

export function shellName(file: string): string {
  if (process.platform === "win32") return path.win32.parse(windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function isPowerShell(file: string): boolean {
  return META[shellName(file)]?.ps === true
}

export function isPosix(file: string): boolean {
  return META[shellName(file)]?.posix === true
}

function acceptable(file: string): boolean {
  return META[shellName(file)]?.deny !== true
}

function full(file: string): string {
  if (process.platform !== "win32") return file
  const shell = windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && shellName(shell) === "bash") return gitBash() ?? shell
    return shell
  }
  if (shellName(shell) === "bash") return gitBash() ?? which(shell) ?? shell
  return which(shell) ?? shell
}

function rooted(file: string): boolean {
  return path.isAbsolute(windowsPath(file))
}

function resolveShell(file: string): string | undefined {
  const shell = full(file)
  if (rooted(shell)) return isFile(shell) ? shell : undefined
  return which(shell) ?? undefined
}

function winDefault(): string {
  const list = [which("pwsh"), which("powershell"), gitBash(), process.env.COMSPEC ?? "cmd.exe"]
    .filter((item): item is string => Boolean(item))
    .map(full)
  return Array.from(new Set(list))[0] ?? "cmd.exe"
}

function unixDefault(): string {
  if (process.platform === "darwin") return "/bin/zsh"
  return which("bash") ?? "/bin/sh"
}

export function selectShell(configShell?: string): string {
  if (configShell) {
    if (acceptable(configShell)) {
      const shell = resolveShell(configShell)
      if (shell) return shell
    }
  }
  if (process.platform === "win32") return winDefault()
  return unixDefault()
}

export function home(text: string): string {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

export function unquote(text: string): string {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

export async function resolveWorkdir(text: string, root: string, shell: string): Promise<string> {
  const expanded = unquote(text)
  if (process.platform === "win32") {
    if (isPosix(shell) && expanded.startsWith("/") && windowsPath(expanded) === expanded) {
      const converted = await cygpath(shell, expanded)
      if (converted) return converted
    }
    return path.resolve(root, windowsPath(home(expanded)))
  }
  return path.resolve(root, home(expanded))
}

async function cygpath(shell: string, text: string): Promise<string | undefined> {
  const { spawn } = await import("node:child_process")
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const child = spawn(shell, ["-lc", 'cygpath -w -- "$1"', "_", text], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill()
      finish(undefined)
    }, 2000)
    let out = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8")
    })
    child.once("error", () => {
      clearTimeout(timer)
      finish(undefined)
    })
    child.once("exit", () => {
      clearTimeout(timer)
      const line = out.split(/\r?\n/).map((item) => item.trim()).find((item) => item !== "")
      finish(line ? windowsPath(line) : undefined)
    })
  })
}

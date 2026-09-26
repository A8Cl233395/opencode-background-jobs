import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function encode(value: number, length: number): string {
  let out = ""
  let n = value
  for (let i = 0; i < length; i++) {
    out = ALPHABET[n % ALPHABET.length] + out
    n = Math.floor(n / ALPHABET.length)
  }
  return out
}

export function ascendingId(prefix: string): string {
  const time = encode(Date.now(), 8)
  const rand = randomBytes(8).toString("hex")
  return `${prefix}_${time}${rand}`
}

export function xdgData(): string {
  const env = process.env.XDG_DATA_HOME
  if (env && env.trim() !== "") return env.trim()
  return path.join(os.homedir(), ".local", "share")
}

export function opencodeData(): string {
  return path.join(xdgData(), "opencode")
}

export function truncationDir(): string {
  return path.join(opencodeData(), "tool-output")
}

export function newTruncationFilePath(): string {
  return path.join(truncationDir(), ascendingId("tool"))
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

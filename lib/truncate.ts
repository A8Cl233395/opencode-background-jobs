import fs from "node:fs"

export const MAX_METADATA_LENGTH = 30_000

export type Limits = { maxLines: number; maxBytes: number }

export function preview(text: string, max = MAX_METADATA_LENGTH): string {
  if (text.length <= max) return text
  return "...\n\n" + text.slice(-max)
}

export function tail(text: string, maxLines: number, maxBytes: number): { text: string; cut: boolean } {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { text, cut: false }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return { text: out.join("\n"), cut: true }
}

export function readTailBytes(file: string, maxBytes: number): { text: string; size: number; read: number } {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return { text: "", size: 0, read: 0 }
  }
  if (size === 0) return { text: "", size: 0, read: 0 }
  const length = Math.min(size, maxBytes)
  const start = size - length
  const fd = fs.openSync(file, "r")
  try {
    const buf = Buffer.allocUnsafe(length)
    const bytesRead = fs.readSync(fd, buf, 0, length, start)
    let text = buf.subarray(0, bytesRead).toString("utf-8")
    if (start > 0) {
      const idx = text.indexOf("\n")
      if (idx >= 0) text = text.slice(idx + 1)
    }
    return { text, size, read: bytesRead }
  } finally {
    fs.closeSync(fd)
  }
}

function decodeBounded(buf: Buffer, maxLines: number): string {
  let text: string | undefined
  let end = buf.length
  for (let i = 0; i < 4 && end > 0; i++) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, end))
      break
    } catch {
      end--
    }
  }
  if (text === undefined) text = buf.toString("utf-8")
  if (maxLines > 0) {
    let lines = 0
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        lines++
        if (lines >= maxLines) {
          text = text.slice(0, i + 1)
          break
        }
      }
    }
  }
  return text
}

export function readChunkFrom(
  file: string,
  offset: number,
  maxBytes: number,
  maxLines: number,
): { text: string; nextOffset: number; eof: boolean } {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return { text: "", nextOffset: offset, eof: true }
  }
  if (offset >= size || size === 0) return { text: "", nextOffset: offset, eof: true }
  const length = Math.min(maxBytes, size - offset)
  const fd = fs.openSync(file, "r")
  let read = 0
  const buf = Buffer.allocUnsafe(length)
  try {
    read = fs.readSync(fd, buf, 0, length, offset)
  } finally {
    fs.closeSync(fd)
  }
  if (read === 0) return { text: "", nextOffset: offset, eof: true }
  const text = decodeBounded(buf.subarray(0, read), maxLines)
  const consumed = Buffer.byteLength(text, "utf-8")
  const advance = Math.min(Math.max(consumed, 1), read)
  const next = offset + advance
  return { text, nextOffset: next, eof: next >= size }
}

export function readChunkFromBuffer(
  chunks: Buffer[],
  total: number,
  offset: number,
  maxBytes: number,
  maxLines: number,
): { text: string; nextOffset: number; eof: boolean } {
  if (offset >= total || total === 0) return { text: "", nextOffset: offset, eof: true }
  const gathered: Buffer[] = []
  let skipped = 0
  let used = 0
  for (const chunk of chunks) {
    if (skipped + chunk.length <= offset) {
      skipped += chunk.length
      continue
    }
    const start = Math.max(0, offset - skipped)
    const take = Math.min(chunk.length - start, maxBytes - used)
    if (take > 0) {
      gathered.push(chunk.subarray(start, start + take))
      used += take
    }
    skipped += chunk.length
    if (used >= maxBytes) break
  }
  if (used === 0) return { text: "", nextOffset: offset, eof: offset >= total }
  const text = decodeBounded(Buffer.concat(gathered, used), maxLines)
  const consumed = Buffer.byteLength(text, "utf-8")
  const advance = Math.min(Math.max(consumed, 1), used)
  const next = offset + advance
  return { text, nextOffset: next, eof: next >= total }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`
  return `${s}s`
}

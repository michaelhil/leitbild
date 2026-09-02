// Optional observations: two files per session, not a Room journal. Queue and
// file byte limits are independent. Directory/session retention is operator policy.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogEvent, LogSink, LogSinkStats } from './types.ts'

export interface JsonlFileSinkOptions {
  readonly dir: string
  readonly sessionId: string
  readonly rotateAtBytes?: number
  readonly flushIntervalMs?: number
  readonly queueCap?: number
  readonly queueBytes?: number
}

export const createJsonlFileSink = async (options: JsonlFileSinkOptions): Promise<LogSink> => {
  const rotateAtBytes = options.rotateAtBytes ?? Number(process.env.LEITBILD_LOG_MAX_BYTES ?? 50 * 1024 * 1024)
  const flushIntervalMs = options.flushIntervalMs ?? 1000
  const queueCap = options.queueCap ?? 10_000
  const queueBytes = options.queueBytes ?? 8 * 1024 * 1024
  for (const [name, value] of Object.entries({ rotateAtBytes, flushIntervalMs, queueCap, queueBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid logging ${name}: ${value}`)
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(options.sessionId)) throw new Error('Invalid log session id')
  type Entry = { kind: string; line: string; bytes: number }
  let queue: Entry[] = []
  let queuedBytes = 0
  let eventCount = 0
  let droppedCount = 0
  let pendingDrops = 0
  const droppedKinds = new Map<string, number>()
  let currentFileBytes = 0
  let closed = false
  let closing: Promise<void> | undefined
  let writing: Promise<void> | undefined
  const currentFilePath = join(options.dir, `${options.sessionId}.jsonl`)
  const rolledFilePath = join(options.dir, `${options.sessionId}.1.jsonl`)
  try { currentFileBytes = (await stat(currentFilePath)).size } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const drop = (kind: string): void => {
    droppedCount++
    pendingDrops++
    const bucket = droppedKinds.has(kind) || droppedKinds.size < 64 ? kind : 'other'
    droppedKinds.set(bucket, (droppedKinds.get(bucket) ?? 0) + 1)
    if (droppedCount === 1 || droppedCount % 100 === 0) console.error(`[logging] observation dropped by queue/file limit or I/O failure (total: ${droppedCount})`)
  }
  const serialize = (event: LogEvent): Entry => {
    let line: string
    try { line = JSON.stringify(event) + '\n' } catch (error) {
      line = JSON.stringify({ ts: event.ts, kind: 'log.serialize_failed', session: event.session,
        payload: { originalKind: event.kind, error: String(error) } }) + '\n'
    }
    return { kind: event.kind, line, bytes: Buffer.byteLength(line) }
  }

  const flushBatch = async (): Promise<void> => {
    if (!queue.length && !pendingDrops) return
    const pending = queue
    queue = []
    queuedBytes = 0
    if (pendingDrops) {
      const notice = serialize({ ts: Date.now(), kind: 'log.dropped', session: options.sessionId,
        payload: { count: pendingDrops, reason: 'queue/file limit or I/O failure', kinds: [...droppedKinds].map(([kind, count]) => count > 1 ? `${kind}×${count}` : kind) } })
      // With a tiny file budget the notice itself may not fit. Counters/stderr
      // still report the loss; never break the byte limit to record that notice.
      if (notice.bytes <= rotateAtBytes) pending.unshift(notice)
      else console.error(`[logging] ${pendingDrops} dropped observations; notice exceeds file limit`)
      pendingDrops = 0
      droppedKinds.clear()
    }
    let offset = 0
    try {
      await mkdir(options.dir, { recursive: true })
      while (offset < pending.length) {
        if (currentFileBytes > 0 && currentFileBytes + pending[offset]!.bytes > rotateAtBytes) {
          // Atomic replacement of the previous ring member; do not hide I/O errors.
          await rename(currentFilePath, rolledFilePath)
          currentFileBytes = 0
        }
        let end = offset
        let bytes = 0
        while (end < pending.length && currentFileBytes + bytes + pending[end]!.bytes <= rotateAtBytes) bytes += pending[end++]!.bytes
        const chunk = pending.slice(offset, end)
        await appendFile(currentFilePath, chunk.map(entry => entry.line).join(''), 'utf-8')
        currentFileBytes += bytes
        eventCount += chunk.filter(entry => entry.kind !== 'log.dropped').length
        offset = end
      }
    } catch (error) {
      for (const entry of pending.slice(offset)) if (entry.kind !== 'log.dropped') drop(entry.kind)
      console.error(`[logging] sink write failed for ${currentFilePath}: ${String(error)}`)
    }
  }
  const flush = async (): Promise<void> => {
    if (writing) await writing
    if (!queue.length && !pendingDrops) return
    if (!writing) writing = flushBatch().finally(() => { writing = undefined })
    await writing
  }
  const timer = setInterval(() => { void flush().catch(error => console.error('[logging] flush failed', error)) }, flushIntervalMs)
  timer.unref?.()
  return {
    write: event => {
      if (closed) return // Late observers cannot reopen a closed sink.
      const entry = serialize(event)
      if (entry.bytes > rotateAtBytes || entry.bytes > queueBytes) { drop(event.kind); return }
      while (queue.length && (queue.length >= queueCap || queuedBytes + entry.bytes > queueBytes)) {
        const oldest = queue.shift()!
        queuedBytes -= oldest.bytes
        drop(oldest.kind)
      }
      queue.push(entry)
      queuedBytes += entry.bytes
    },
    flush,
    close: () => {
      if (!closing) {
        closed = true
        clearInterval(timer)
        closing = flush()
      }
      return closing
    },
    stats: (): LogSinkStats => ({ eventCount, droppedCount, queuedCount: queue.length, currentFile: currentFilePath, currentFileBytes }),
  }
}

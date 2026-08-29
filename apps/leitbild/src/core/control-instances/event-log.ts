import { appendFile, mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { controlInstanceEventSchema, type ControlInstanceEvent } from '../model/index.ts'

export interface EventLog {
  readonly appendMany: (events: ReadonlyArray<ControlInstanceEvent>) => Promise<void>
  readonly readAll: () => Promise<ReadonlyArray<ControlInstanceEvent>>
  readonly readAfter: (seq: number) => Promise<ReadonlyArray<ControlInstanceEvent>>
  readonly readLast: () => Promise<ControlInstanceEvent | null>
  readonly readLastSeq: () => Promise<number>
  readonly sizeBytes: () => Promise<number>
}

const assertStrictSequence = (events: ReadonlyArray<ControlInstanceEvent>, context: string, previousSeq = -1): number => {
  let lastSeq = previousSeq
  for (const event of events) {
    if (event.seq <= lastSeq) {
      throw new Error(`event log sequence regression at ${context}: ${event.seq} after ${lastSeq}`)
    }
    lastSeq = event.seq
  }
  return lastSeq
}

const readEvents = async (path: string): Promise<ReadonlyArray<ControlInstanceEvent>> => {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const lines = text.split('\n')
  const events: ControlInstanceEvent[] = []
  let previousSeq = -1
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || line.trim().length === 0) continue
    const location = `${path}:${index + 1}`
    let raw: unknown
    try {
      raw = JSON.parse(line) as unknown
    } catch (err) {
      throw new Error(`invalid event log JSON at ${location}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const parsed = controlInstanceEventSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`invalid event log event at ${location}: ${parsed.error.message}`)
    }
    if (parsed.data.seq <= previousSeq) {
      throw new Error(`event log sequence regression at ${location}: ${parsed.data.seq} after ${previousSeq}`)
    }
    previousSeq = parsed.data.seq
    events.push(parsed.data as ControlInstanceEvent)
  }
  return events
}

const parseEventLine = (line: string, location: string): ControlInstanceEvent => {
  let raw: unknown
  try {
    raw = JSON.parse(line) as unknown
  } catch (err) {
    throw new Error(`invalid event log JSON at ${location}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = controlInstanceEventSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`invalid event log event at ${location}: ${parsed.error.message}`)
  }
  return parsed.data as ControlInstanceEvent
}

const readLastNonEmptyLine = async (path: string): Promise<string | null> => {
  let file: FileHandle
  try {
    file = await open(path, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const fileStats = await file.stat()
    if (fileStats.size === 0) return null
    let position = fileStats.size
    let text = ''
    const chunkSize = 64 * 1024
    while (position > 0) {
      const length = Math.min(chunkSize, position)
      position -= length
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, position)
      text = buffer.subarray(0, bytesRead).toString('utf8') + text
      const trimmed = text.trimEnd()
      const lastNewline = trimmed.lastIndexOf('\n')
      if (lastNewline >= 0) return trimmed.slice(lastNewline + 1)
      if (position === 0 && trimmed.length > 0) return trimmed
    }
    return null
  } finally {
    await file.close()
  }
}

const readLastEvent = async (path: string): Promise<ControlInstanceEvent | null> => {
  const line = await readLastNonEmptyLine(path)
  if (line === null) return null
  return parseEventLine(line, `${path}:last`)
}

const fileSizeBytes = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
}

export const createJsonlEventLog = (path: string): EventLog => {
  let lastPersistedSeq: number | null = null

  const readAll = async (): Promise<ReadonlyArray<ControlInstanceEvent>> => readEvents(path)
  const readLast = async (): Promise<ControlInstanceEvent | null> => readLastEvent(path)
  const readLastSeq = async (): Promise<number> => (await readLast())?.seq ?? -1

  const ensureLastPersistedSeq = async (): Promise<number> => {
    if (lastPersistedSeq !== null) return lastPersistedSeq
    lastPersistedSeq = await readLastSeq()
    return lastPersistedSeq
  }

  return {
    appendMany: async (events: ReadonlyArray<ControlInstanceEvent>): Promise<void> => {
      if (events.length === 0) return
      const previousSeq = await ensureLastPersistedSeq()
      const lastSeq = assertStrictSequence(events, path, previousSeq)
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
      lastPersistedSeq = lastSeq
    },
    readAll,
    readAfter: async (seq: number): Promise<ReadonlyArray<ControlInstanceEvent>> =>
      (await readAll()).filter(event => event.seq > seq),
    readLast,
    readLastSeq,
    sizeBytes: async (): Promise<number> => fileSizeBytes(path),
  }
}

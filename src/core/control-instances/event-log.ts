import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { domainEventSchema, type DomainEvent } from '../model/index.ts'

export interface EventLog {
  readonly appendMany: (events: ReadonlyArray<DomainEvent>) => Promise<void>
  readonly readAll: () => Promise<ReadonlyArray<DomainEvent>>
  readonly readAfter: (seq: number) => Promise<ReadonlyArray<DomainEvent>>
}

const assertStrictSequence = (events: ReadonlyArray<DomainEvent>, context: string, previousSeq = -1): number => {
  let lastSeq = previousSeq
  for (const event of events) {
    if (event.seq <= lastSeq) {
      throw new Error(`event log sequence regression at ${context}: ${event.seq} after ${lastSeq}`)
    }
    lastSeq = event.seq
  }
  return lastSeq
}

const readEvents = async (path: string): Promise<ReadonlyArray<DomainEvent>> => {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const lines = text.split('\n')
  const events: DomainEvent[] = []
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
    const parsed = domainEventSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`invalid event log event at ${location}: ${parsed.error.message}`)
    }
    if (parsed.data.seq <= previousSeq) {
      throw new Error(`event log sequence regression at ${location}: ${parsed.data.seq} after ${previousSeq}`)
    }
    previousSeq = parsed.data.seq
    events.push(parsed.data as DomainEvent)
  }
  return events
}

export const createJsonlEventLog = (path: string): EventLog => {
  let lastPersistedSeq: number | null = null

  const readAll = async (): Promise<ReadonlyArray<DomainEvent>> => readEvents(path)
  const readLastPersistedSeq = async (): Promise<number> => {
    const events = await readAll()
    return events.at(-1)?.seq ?? -1
  }

  const ensureLastPersistedSeq = async (): Promise<number> => {
    if (lastPersistedSeq !== null) return lastPersistedSeq
    lastPersistedSeq = await readLastPersistedSeq()
    return lastPersistedSeq
  }

  return {
    appendMany: async (events: ReadonlyArray<DomainEvent>): Promise<void> => {
      if (events.length === 0) return
      const previousSeq = await ensureLastPersistedSeq()
      const lastSeq = assertStrictSequence(events, path, previousSeq)
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
      lastPersistedSeq = lastSeq
    },
    readAll,
    readAfter: async (seq: number): Promise<ReadonlyArray<DomainEvent>> =>
      (await readAll()).filter(event => event.seq > seq),
  }
}

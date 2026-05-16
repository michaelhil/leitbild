import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { domainEventSchema, type DomainEvent } from '../model/index.ts'

export interface EventLog {
  readonly appendMany: (events: ReadonlyArray<DomainEvent>) => Promise<void>
  readonly readAll: () => Promise<ReadonlyArray<DomainEvent>>
  readonly readAfter: (seq: number) => Promise<ReadonlyArray<DomainEvent>>
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
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || line.trim().length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(line) as unknown
    } catch (err) {
      throw new Error(`invalid event log JSON at ${path}:${index + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const parsed = domainEventSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`invalid event log event at ${path}:${index + 1}: ${parsed.error.message}`)
    }
    events.push(parsed.data as DomainEvent)
  }
  return events
}

export const createJsonlEventLog = (path: string): EventLog => {
  const readAll = async (): Promise<ReadonlyArray<DomainEvent>> => readEvents(path)

  return {
    appendMany: async (events: ReadonlyArray<DomainEvent>): Promise<void> => {
      if (events.length === 0) return
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    },
    readAll,
    readAfter: async (seq: number): Promise<ReadonlyArray<DomainEvent>> =>
      (await readAll()).filter(event => event.seq > seq),
  }
}

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DomainEvent } from '../model/index.ts'

export interface EventLog {
  readonly append: (event: DomainEvent) => Promise<void>
}

export const createJsonlEventLog = (path: string): EventLog => ({
  append: async (event: DomainEvent): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
  },
})

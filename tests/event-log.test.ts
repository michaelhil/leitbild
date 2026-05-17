import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlEventLog } from '../src/core/control-instances/event-log.ts'
import type { ControlInstanceId, DomainEvent, EventId, ObjectId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'

const controlInstanceId = 'control-instance:event-log-test' as ControlInstanceId

const makeEvent = (seq: number): DomainEvent => ({
  id: `event:test-${seq}` as EventId,
  controlInstanceId,
  seq,
  at: nowIso(),
  provenance: { source: 'system' },
  type: 'object.deleted',
  objectId: `object:test-${seq}` as ObjectId,
})

const readEventLogText = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

describe('JSONL event log', () => {
  test('appends increasing event batches and reads events after a sequence', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-event-log-test-'))
    const path = join(dataDir, 'events.jsonl')
    const eventLog = createJsonlEventLog(path)

    await eventLog.appendMany([makeEvent(1), makeEvent(2)])
    await eventLog.appendMany([makeEvent(3)])

    expect((await eventLog.readAll()).map(event => event.seq)).toEqual([1, 2, 3])
    expect((await eventLog.readAfter(1)).map(event => event.seq)).toEqual([2, 3])
  })

  test('rejects an out-of-order append batch without writing it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-event-log-test-'))
    const path = join(dataDir, 'events.jsonl')
    const eventLog = createJsonlEventLog(path)

    await expect(eventLog.appendMany([makeEvent(2), makeEvent(1)])).rejects.toThrow('event log sequence regression')

    expect(await readEventLogText(path)).toBeNull()
  })

  test('rejects appending a sequence that is not newer than the persisted journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-event-log-test-'))
    const path = join(dataDir, 'events.jsonl')
    const eventLog = createJsonlEventLog(path)

    await eventLog.appendMany([makeEvent(2)])
    await expect(eventLog.appendMany([makeEvent(1)])).rejects.toThrow('event log sequence regression')

    expect((await eventLog.readAll()).map(event => event.seq)).toEqual([2])
  })

  test('rejects duplicate sequence numbers in append order', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-event-log-test-'))
    const path = join(dataDir, 'events.jsonl')
    const eventLog = createJsonlEventLog(path)

    await expect(eventLog.appendMany([makeEvent(1), makeEvent(1)])).rejects.toThrow('event log sequence regression')

    expect(await readEventLogText(path)).toBeNull()
  })
})

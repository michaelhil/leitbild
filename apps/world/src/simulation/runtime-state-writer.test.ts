import { expect, test } from 'bun:test'
import { createRuntimeStateWriter } from './runtime-state-writer.ts'

test('runtime state writer drains once on close and cannot recreate state later', async () => {
  const saved: number[] = []
  let value = 1
  const writer = createRuntimeStateWriter({
    store: { load: async () => null, save: async state => { saved.push(state as number) } },
    readState: () => value,
    delayMs: 10,
    label: 'test-pack',
  })
  writer.scheduleSave()
  value = 2
  await writer.close()
  await Bun.sleep(25)
  expect(saved).toEqual([2])
  expect(() => writer.scheduleSave()).toThrow('state writer is closed')
  await expect(writer.saveNow()).rejects.toThrow('state writer is closed')
})

import { expect, test } from 'bun:test'
import { objectIdSchema } from '../src/core/model/ids.ts'
import { requestPort, type ObservationPort } from '../src/features/displays/observation/port.ts'

test('request-local observation reuse retains exact refusals for leads and refs without contaminating other objects', async () => {
  const hidden = objectIdSchema.parse('unit:hidden'), other = objectIdSchema.parse('unit:other')
  let reads = 0
  const port: ObservationPort = {
    declarations: async () => [], topology: async () => { throw Error('not used') },
    read: async request => {
      reads++
      return { observations: [], unknown: [], refused: [{ objectId: hidden, refused: { code: 'agent_access_restricted', message: 'Hidden to this caller' } }], leads: (request.leads ?? []).map(() => []) }
    },
  }
  const cached = requestPort(port)
  const first = await cached.read({ leads: [{ objectId: hidden, count: 1 }] })
  const second = await cached.read({ refs: ['unit:hidden#speed'], leads: [{ objectId: hidden, count: 1 }] })
  expect(second.refused).toEqual(first.refused)
  expect(second.unknown).toEqual([])
  expect(reads).toBe(1)
  expect((await cached.read({ leads: [{ objectId: other, count: 1 }] })).refused).toEqual([])
  expect(reads).toBe(2)
})

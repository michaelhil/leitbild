import { expect, test } from 'bun:test'
import { createRoomDirectory } from '../../core/rooms/directory.ts'
import { createEvalBuffer } from '../../diagnostics/eval-buffer.ts'
import type { OnEvalEvent } from '../../core/types/agent-eval.ts'
import type { RouteContext } from './types.ts'
import { diagnosticRoutes } from './diagnostics.ts'

test('diagnostic evidence requires its existing Room and filters removed Rooms before paging', async () => {
  const rooms = createRoomDirectory(), buffer = createEvalBuffer()
  let record: OnEvalEvent = () => { throw new Error('Buffer must be attached') }
  buffer.attach(listener => { record = listener; return () => {} })
  const keep = rooms.createRoom({ name: 'Keep', createdBy: 'human' })
  const removed = rooms.createRoom({ name: 'Remove', createdBy: 'human' })
  record({ agentId: 'agent', agentName: 'Agent', roomId: keep.profile.id }, { traceId: 'kept', kind: 'eval_completed', outcome: 'respond' })
  record({ agentId: 'agent', agentName: 'Agent', roomId: removed.profile.id }, { traceId: 'removed', kind: 'eval_completed', outcome: 'respond' })
  rooms.removeRoom(removed.profile.id)
  const context = { system: { rooms, evalBuffer: buffer } } as RouteContext
  const get = (path: string) => {
    const route = diagnosticRoutes.find(route => route.pattern.test(path.split('?')[0]!))!
    return route.handler(new Request(`http://agents.test${path}`), path.split('?')[0]!.match(route.pattern)!, context)
  }
  expect((await get('/diagnostics/evals/removed')).status).toBe(404)
  expect((await get('/diagnostics/evals/kept')).status).toBe(200)
  const page = await (await get('/diagnostics/evals/recent?limit=1')).json() as { records: Array<{ traceId: string }> }
  expect(page.records.map(record => record.traceId)).toEqual(['kept'])
})

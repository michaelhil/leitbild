import { afterAll, beforeAll, expect, test } from 'bun:test'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import { composeVignette } from '../src/features/displays/compose/compose.ts'
import { compileVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { fixtureComposeRun } from './fixtures/compose-runs.ts'

let fixture: Awaited<ReturnType<typeof fixtureComposeRun>>, run: ViewRun
beforeAll(async () => { fixture = await fixtureComposeRun(); run = await fixture.runOf() })
afterAll(async () => { await fixture.close() })
const spec = (topology: object) => displaySpecSchema.parse({ title: 'Two units', question: 'Compare the units and show the requested engine.', subjects: ['unit:one', 'unit:two'], views: [
  { kind: 'values', signals: ['unit:one#speed', 'unit:two#speed'] }, { kind: 'topology', reach: 1, ...topology },
] })

test('a qualified topology follows its owner, independent of subject order', async () => {
  const request = spec({ around: ['unit:two#engine'] })
  for (const subjects of [request.subjects, [...request.subjects].reverse()]) {
    const outcome = await composeVignette(run, { ...request, subjects })
    if (!outcome.ok) throw Error(JSON.stringify(outcome.issues))
    expect(outcome.state.views.find(view => view.kind === 'topology')).toMatchObject({ objectId: 'unit:two', request: { around: ['engine'] } })
    const view = await compileVignette(run, outcome.state)
    expect(view.sections.find(section => section.kind === 'topology')).toMatchObject({ objectId: 'unit:two' })
  }
})

test('unqualified anchors matching several owners refuse with actionable qualification guidance', async () => {
  expect(await composeVignette(run, spec({ around: ['engine'] }))).toMatchObject({ ok: false, issues: [{ path: 'views.1', code: 'unknown_name', message: expect.stringContaining('objectId#element') }] })
  expect(await composeVignette(run, spec({}))).toMatchObject({ ok: false, issues: [{ path: 'views.1', code: 'unknown_name' }] })
})

test('one topology never invents a graph across owners, and hidden owners remain refused', async () => {
  expect(await composeVignette(run, spec({ from: ['unit:one#tank'], to: ['unit:two#engine'] }))).toMatchObject({ ok: false, issues: [{ code: 'not_fitted', message: expect.stringContaining('separate topology view') }] })
  expect(await composeVignette({ ...run, denied: new Set(['unit:two']) }, spec({ around: ['unit:two#engine'] }))).toMatchObject({ ok: false, issues: [{ code: 'agent_access_restricted' }] })
})

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import { composeVignette } from '../src/features/displays/compose/compose.ts'
import { compileVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { fixtureComposeRun } from './fixtures/compose-runs.ts'
import { blockRows } from '../src/features/displays/compose/element-groups.ts'

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

test('an exact whole-owner around anchor selects its declared overview without treating the object as a node', async () => {
  const outcome = await composeVignette(run, spec({ around: ['unit:two'] }))
  if (!outcome.ok) throw Error(JSON.stringify(outcome.issues))
  expect(outcome.state.views.find(view => view.kind === 'topology')).toMatchObject({ objectId: 'unit:two', request: { overview: true } })
  expect(await composeVignette({ ...run, denied: new Set(['unit:two']) }, spec({ around: ['unit:two'] }))).toMatchObject({ ok: false, issues: [{ code: 'agent_access_restricted' }] })
  expect(await composeVignette(run, spec({ around: ['unit:two'], from: ['unit:two#tank'] }))).toMatchObject({ ok: false, issues: [{ code: 'unknown_name', message: expect.stringContaining('whole-owner overview') }] })
})

test('long owner names preserve the distinguishing unit identity in each topology heading', async () => {
  const prefix = 'Northern coastal integrated generation and research campus with a deliberately long station name'
  const names = new Map([['unit:one', `${prefix} · Unit 12`], ['unit:two', `${prefix} · Unit 13`]])
  const namedRun: ViewRun = { ...run, objects: run.objects.map(object => names.has(object.id) ? { ...object, label: names.get(object.id)! } : object) }
  const request = displaySpecSchema.parse({ title: 'Long owner names', question: 'Show both named units without losing identity.', subjects: ['unit:one', 'unit:two'], views: [
    { kind: 'topology', around: ['unit:one#engine'], reach: 1 }, { kind: 'topology', around: ['unit:two#engine'], reach: 1 },
  ] })
  const outcome = await composeVignette(namedRun, request)
  if (!outcome.ok) throw Error(JSON.stringify(outcome.issues))
  const view = await compileVignette(namedRun, outcome.state)
  expect(view.sections.filter(section => section.kind === 'topology').map(section => section.heading)).toEqual([...names.values()])
})

test('mixed-owner value headings are reserved by composition and keep exact inspection identities', async () => {
  const outcome = await composeVignette(run, displaySpecSchema.parse({ title: 'Compare speeds', question: 'Compare both units.', subjects: ['unit:one', 'unit:two'], views: [{ kind: 'values', signals: ['unit:one#speed', 'unit:two#speed'] }] }))
  if (!outcome.ok) throw Error(JSON.stringify(outcome.issues))
  const view = await compileVignette(run, outcome.state)
  const values = view.sections.find(section => section.kind === 'values')
  if (values?.kind !== 'values' || values.blocks === undefined) throw Error('Expected named owner blocks')
  expect(values.blocks.map(block => block.kind === 'owner' && block.label)).toEqual(['Unit One', 'Unit Two'])
  expect(values.rows).toBe(blockRows(values.blocks))
  expect(outcome.state.views.find(section => section.kind === 'values')?.rows).toBe(blockRows(values.blocks))
  expect(values.blocks.flatMap(block => block.kind === 'owner' ? block.values.map(value => value.ref) : [])).toEqual(['unit:one#speed', 'unit:two#speed'])
})

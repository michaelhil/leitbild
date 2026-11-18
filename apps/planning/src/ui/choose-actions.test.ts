// The screen's choosing actions against a test double of Host and Planning: the ladder's rungs solved lowest
// first, one Generate each with its own buy list and keep; a busy solver waited for and said; a what-if sent
// as one kept request; why recommended and versus asked of the right options; a part not built yet returned
// as itself, never swallowed. Only the nine operations are called, and nothing is written to World.
import { describe, expect, test } from 'bun:test'
import { createPlanningClient, isNotBuilt } from './api.ts'
import { trainAPlanned } from './fixtures/plans.ts'
import { createNames, type PlanModel } from './model.ts'
import { createPlanActions } from './plan-actions.ts'
import { whatIfVariant } from './what-if.ts'
import { createTimeFormat } from './format.ts'

const workspace = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'
interface Call { readonly capability: string; readonly expectedRevision?: number; readonly input: Record<string, unknown> }
type Answer = { readonly status: number; readonly body: unknown }

/** Serves one plan as read sections; each Generate and explain is answered by the next scripted answer. */
const host = (plan: PlanModel, script: Answer[] = []) => {
  const calls: Call[] = []
  const lists: Record<string, readonly unknown[]> = {
    jobs: [...plan.inputs.jobs.map(job => ({ job })), ...plan.inputs.links.map(link => ({ link })), ...plan.inputs.methods.map(method => ({ method }))],
    rules: plan.inputs.rules.map(rule => ({ rule })),
    crews: [...plan.inputs.calendars.map(calendar => ({ calendar })), ...plan.inputs.resources.map(resource => ({ resource })), ...plan.inputs.purchases.map(purchase => ({ purchase }))],
    sources: [...plan.inputs.equipment.map(equipment => ({ equipment })), ...plan.inputs.groups.map(group => ({ group }))],
    options: plan.options?.items ?? [], schedule: Object.values(plan.rows)[0] ?? [],
    buys: [{ rung: { rung: 0, methods: [], buy: ['crane-fri'], bought: [] } }],
    previous: [],
  }
  const client = createPlanningClient(workspace, async (path, init) => {
    if (init?.method !== 'POST') return Response.json({ workspaceId: workspace, modules: [], resources: [] })
    const capability = decodeURIComponent(String(path).split('/capabilities/')[1]!.replace('/invoke', ''))
    const body = JSON.parse(String(init.body)) as { expectedRevision?: number; input: Record<string, unknown> }
    calls.push({ capability, ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }), input: body.input })
    if (capability === 'planning.plan.read') {
      const section = String(body.input.section)
      const data = section === 'summary'
        ? { plan: { id: plan.id, title: plan.title, revision: plan.revision, updatedAt: plan.updatedAt }, settings: plan.inputs.settings, goals: plan.inputs.goals, refreshedAt: plan.inputs.world.refreshedAt, attention: [], certifiedSize: null }
        : { items: lists[section], ...(section === 'options' ? { at: plan.options?.at ?? null, recommended: plan.options?.recommended ?? null } : section === 'previous' ? { at: null, recommended: null } : {}), ...(section === 'schedule' ? { option: body.input.option } : {}) }
      return Response.json({ result: { target: { kind: 'resource', resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: plan.id } }, title: plan.title, observedAt: '2026-11-12T09:00:00.000Z', sections: [{ id: section, title: section, data }] } })
    }
    const next = script.shift() ?? { status: 200, body: { result: capability === 'planning.plan.generate' ? { plan: { id: plan.id, revision: plan.revision }, options: [], text: 'Done.' } : { lines: [], items: [] } } }
    return Response.json(next.body, { status: next.status })
  })
  return { client, calls }
}
const busy: Answer = { status: 409, body: { error: { code: 'solver_busy', message: 'Another plan is generating.' } } }
const notBuilt = (message: string): Answer => ({ status: 501, body: { error: { code: 'not_built', message } } })
const generates = (calls: readonly Call[]) => calls.filter(call => call.capability === 'planning.plan.generate')

describe('what overtime buys, worked out', () => {
  test('the missing rungs are solved lowest first, each by its own kept request, at the plan\'s revision', async () => {
    const model = trainAPlanned()
    const { client, calls } = host(model)
    const actions = createPlanActions(client, model.id)
    const rungs = [{ name: 'Days only', request: { variants: [{ label: 'Days only', buy: ['crane-fri', 'ect-friday'] }], keep: true as const } }, { name: '+ Station mechanical overtime to 19:00', request: { keep: true as const } }]
    const shown = await actions.solveRungs(model, rungs, new AbortController().signal, 'opt-1')
    expect(shown.error).toBeNull()
    expect(generates(calls).map(call => [call.expectedRevision, call.input])).toEqual(rungs.map(rung => [model.revision, rung.request]))
    expect(calls.every(call => call.capability.startsWith('planning.plan.'))).toBe(true)
  })

  test('while another plan holds the solver, it waits, says so, and tries the same rung again', async () => {
    const model = trainAPlanned()
    const { client, calls } = host(model, [busy])
    const said: string[] = []
    const waits: number[] = []
    const actions = createPlanActions(client, model.id, text => { said.push(text) })
    const shown = await actions.solveRungs(model, [{ name: 'Days only', request: { keep: true as const } }], new AbortController().signal, null, async ms => { waits.push(ms) })
    expect(shown.error).toBeNull()
    expect(generates(calls)).toHaveLength(2)
    expect(waits).toEqual([20_000])
    expect(said).toContain('Planning is generating another plan; trying “Days only” again in a moment.')
  })

  test('a rung refused as not built stops the ladder and is returned as itself, for the screen to say "not available yet"', async () => {
    const model = trainAPlanned()
    const { client, calls } = host(model, [notBuilt('Adding what-ifs to the options already there is not built in this version of Planning')])
    const actions = createPlanActions(client, model.id)
    const shown = await actions.solveRungs(model, [{ name: 'Days only', request: { variants: [{ label: 'Days only', buy: [] }], keep: true as const } }, { name: '+ overtime', request: { keep: true as const } }], new AbortController().signal, null)
    expect(isNotBuilt(shown.error)).toBe(true)
    expect(generates(calls)).toHaveLength(1)
  })

  test('the buys section is read whole, every page', async () => {
    const model = trainAPlanned()
    const actions = createPlanActions(host(model).client, model.id)
    expect((await actions.buys()).flatMap(page => page.items)).toEqual([{ rung: { rung: 0, methods: [], buy: ['crane-fri'], bought: [] } }])
  })
})

describe('what-ifs and explanations', () => {
  test('a what-if is one kept Generate request; its key comes from the answer by its label', async () => {
    const model = trainAPlanned()
    const context = { inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) }
    const built = whatIfVariant({ kind: 'first', group: 'AFW-A' }, context)
    if (!built.ok) throw new Error(built.problems.join(' '))
    const answer = { status: 200, body: { result: { plan: { id: model.id, revision: model.revision }, options: [{ key: 'w1', label: built.label, status: { word: 'cancelled', goals: [] }, warnings: [] }], text: 'Done.' } } }
    const { client, calls } = host(model, [answer])
    const shown = await createPlanActions(client, model.id).whatIf(model, built.variant, new AbortController().signal, 'opt-1')
    expect(shown.asked).toBe('w1')
    expect(shown.option).toBe('opt-1')
    expect(generates(calls).map(call => call.input)).toEqual([{ variants: [{ label: built.label, lead: { group: 'AFW-A' } }], keep: true }])
  })

  test('why recommended weighs against the next in rank, or a named option; versus names an option of the earlier set; the earlier set is read', async () => {
    const model = trainAPlanned()
    const { client, calls } = host(model, [notBuilt('Explaining why an option is recommended is not built in this version of Planning')])
    const actions = createPlanActions(client, model.id)
    const refused = await actions.whyRecommended(null).then(() => null, cause => cause)
    expect(isNotBuilt(refused)).toBe(true)
    await actions.whyRecommended('opt-2')
    await actions.versus('opt-1', 'old-1')
    expect(calls.filter(call => call.capability === 'planning.plan.explain').map(call => call.input)).toEqual([
      { ask: 'recommended' },
      { ask: 'recommended', option: 'opt-2' },
      { ask: 'versus', option: 'opt-1', versus: { previous: 'old-1' } },
    ])
    expect(await actions.previous()).toEqual({ at: null, recommended: null, items: [] })
    expect(calls.at(-1)).toEqual({ capability: 'planning.plan.read', input: { section: 'previous' } })
  })
})

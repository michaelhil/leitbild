import { afterAll, expect, test } from 'bun:test'
import { createPlanningClient } from '../../../apps/planning/src/ui/api.ts'
import { checkForSolver } from '../../../apps/planning/src/solve/lane-k-ports.ts'
import { createPlanningStack } from './planning-stack.ts'

const stack = await createPlanningStack()
afterAll(() => stack.close())
const transport = (path: string, init?: RequestInit) => fetch(new URL(path, stack.hostUrl), init)
const client = createPlanningClient(stack.workspaceId, transport)
const definition = (await client.definitions()).definitions.find(item => item.ref.id === 'nuclear-maintenance-planning')!

test('the maintenance plan reads both actual pumps and computes the crew trade with the real independent checker', async () => {
  const run = await stack.start('world.scenario', 'nuclear-maintenance-planning', 'world.scenario.start')
  const journal = stack.runEvents(run)
  const created = await client.createDemo(definition, run)
  const planId = created.result.plan.id
  const prepared = await stack.store.read(stack.workspaceId, planId)
  expect(prepared.inputs.world.facts.filter(fact => fact.id.endsWith('/flowKgPerS')).map(fact => [fact.value, fact.basis])).toEqual([[350, 'observed'], [350, 'observed']])
  expect(prepared.inputs.world.facts.find(fact => fact.id === 'plant:maintenance/componentCoolingWaterPumpB/runningState')?.value).toBe(true)
  const generated = await client.generate(planId, prepared.revision, { variants: [
    { label: 'One crew', buy: [] },
    { label: 'Extra crew', buy: ['extra-maintenance-crew'] },
  ] })
  expect(generated.options).toHaveLength(2)
  const plan = await stack.store.read(stack.workspaceId, planId)
  const options = new Map(plan.options!.options.map(option => [option.label, option]))
  for (const [label, expectedFinish, expectedCost, lateness] of [
    ['One crew', '2026-11-18T18:00:00.000Z', 0, 2],
    ['Extra crew', '2026-11-18T15:00:00.000Z', 12000, 0],
  ] as const) {
    const option = options.get(label)!
    expect(option.status.word).toBe('validated feasible')
    expect(option.rows).toHaveLength(5)
    expect(option.rows.find(row => row.job === 'restore')?.finish).toBe(expectedFinish)
    expect(option.status.word === 'validated feasible' && option.status.goals[1]?.value).toBe(expectedCost)
    expect(option.status.word === 'validated feasible' && option.status.goals[0]?.value).toBe(lateness)
    expect(checkForSolver({ inputs: plan.inputs, variant: option.variant, rows: option.rows }).violations).toEqual([])
    expect(option.rows.some(row => plan.inputs.jobs.find(job => job.key === row.job)?.equipment.includes('CCWB'))).toBe(false)
  }
  expect(plan.options!.recommended).toBe(options.get('Extra crew')!.key)
  const displayResponse = await fetch(`${stack.worldUrl}/api/workspaces/${stack.workspaceId}/world/simulation-runs/${run}/displays/default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: 'plant:maintenance#componentCoolingWaterPumpB' }),
  })
  if (!displayResponse.ok) throw new Error(`Equipment default returned ${displayResponse.status}: ${await displayResponse.text()}`)
  const display = await displayResponse.json() as { result: { view: { title: string; state: string } } }
  expect(display.result.view.title).toContain('Component Cooling Water Pump B')
  const state = JSON.parse(display.result.view.state)
  expect(state.views.some((view: any) => view.kind === 'values' && view.lead?.element === 'componentCoolingWaterPumpB')).toBe(true)
  expect(state.views.some((view: any) => view.kind === 'topology' && view.request?.around?.includes('componentCoolingWaterPumpB'))).toBe(true)
  const reopened = await client.createDemo(definition, run)
  expect(reopened.result.plan.id).toBe(planId)
  expect(reopened.result.plan.revision).toBe(prepared.revision)
  expect((await stack.store.read(stack.workspaceId, planId)).options).toEqual(plan.options)
  expect(stack.runEvents(run)).toBe(journal)
}, 60_000)

test('a stopped backup pump refuses reopening rather than copying a stale running precheck', async () => {
  const run = await stack.start('world.scenario', 'nuclear-maintenance-planning', 'world.scenario.start')
  const created = await client.createDemo(definition, run)
  const invoke = async (operationId: string, input: unknown) => {
    const response = await transport(`/api/workspaces/${stack.workspaceId}/capabilities/${operationId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: { workspaceId: stack.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run }, input }),
    })
    if (!response.ok) throw new Error(await response.text())
  }
  await invoke('world.process-plant.control.write', { plantId: 'plant:maintenance', path: 'componentCoolingWaterPumpB.running', value: false })
  await invoke('world.simulation-run.execution.advance', { minutes: 1 / 60, onComplete: 'pause' })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await client.createDemo(definition, run)
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: 'demo_world_values_missing' })
      expect((await stack.store.read(stack.workspaceId, created.result.plan.id)).revision).toBe(created.result.plan.revision)
      return
    }
    await Bun.sleep(20)
  }
  throw new Error('The stopped backup was still accepted after the World step')
}, 60_000)

test('arbitrary deadlines retain real proofs and publish the exact option with a checked reference', async () => {
  const run = await stack.start('world.scenario', 'nuclear-maintenance-planning', 'world.scenario.start')
  const created = await client.createDemo(definition, run)
  const planId = created.result.plan.id, revision = created.result.plan.revision
  await client.generate(planId, revision, { variants: [{ label: 'One crew', buy: [] }, { label: 'Extra crew', buy: ['extra-maintenance-crew'] }] })
  const display = async (option: string, digest?: string) => {
    const response = await transport(`/api/workspaces/${stack.workspaceId}/capabilities/planning.plan.display/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: { workspaceId: stack.workspaceId, moduleId: 'planning', type: 'planning.plan', id: planId }, input: { option, ...(digest === undefined ? {} : { digest }) } }),
    })
    return { status: response.status, body: await response.json() as any }
  }
  let pinned: { option: string; digest: string } | undefined
  for (const [label, finishBy, expected] of [
    ['18:00', '2026-11-18T17:00:00Z', ['unresolved', 'validated feasible']],
    ['15:00', '2026-11-18T14:00:00Z', ['proven infeasible', 'proven infeasible']],
    ['19:30', '2026-11-18T18:30:00Z', ['validated feasible', 'validated feasible']],
  ] as const) {
    const generated = await client.generate(planId, revision, { keep: true, variants: [
      { label: `One crew by ${label}`, buy: [], also: [{ kind: 'due', key: `due-${label.replace(':', '-')}`, job: 'restore', finishBy, words: `Requested return by ${label}`, source: { by: 'assumption', note: 'A requested hypothetical deadline, not a change to the authored target.' } }] },
      { label: `Extra crew by ${label}`, buy: ['extra-maintenance-crew'], also: [{ kind: 'due', key: `due-${label.replace(':', '-')}`, job: 'restore', finishBy, words: `Requested return by ${label}`, source: { by: 'assumption', note: 'A requested hypothetical deadline, not a change to the authored target.' } }] },
    ] })
    for (const [index, prefix] of ['One crew', 'Extra crew'].entries()) {
      const option = generated.options.find(candidate => candidate.label === `${prefix} by ${label}`)!
      expect(option.status.word).toBe(expected[index])
      const published = await display(option.key)
      expect(published.status).toBe(200)
      const { view, schedule } = published.body.result
      expect(Buffer.byteLength(JSON.stringify(published.body.result))).toBeLessThanOrEqual(4096)
      expect(view.viewType).toBe('planning.schedule')
      expect(JSON.parse(view.state)).toEqual({ plan: planId, option: option.key, digest: schedule.digest })
      expect(schedule.deadline).toEqual({ job: 'restore', finishBy })
      expect(schedule.option.fresh).toBe(true)
      expect(schedule.option.status.word).toBe(expected[index])
      if (label === '15:00') {
        expect(schedule.certificate).not.toBeNull()
        expect(schedule.reference.finish).toBe('2026-11-18T15:00:00.000Z')
        expect(schedule.reference.fresh).toBe(true)
        pinned = { option: option.key, digest: schedule.digest }
      }
      if (label === '18:00' && index === 1) {
        expect(schedule.option.finish).toBe('2026-11-18T15:00:00.000Z')
        expect(schedule.option.cost).toBe(12000)
      }
    }
  }
  const untouched = await stack.store.read(stack.workspaceId, planId)
  expect(untouched.revision).toBe(revision)
  expect(untouched.inputs.jobs.find(job => job.key === 'restore')!.target!.finishBy).toBe('2026-11-18T16:00:00Z')
  const first = await display(pinned!.option, pinned!.digest)
  expect(first.status).toBe(200)
  await client.edit(planId, revision, { edits: [{ edit: 'job', key: 'pump-work', duration: { value: 5, unit: 'h', calendar: 'working', source: { by: 'assumption', note: 'Found work for the publication invalidation check.' } } }] })
  const stale = await display(pinned!.option, pinned!.digest)
  expect(stale.status).toBe(409)
  expect(stale.body.error.code).toBe('schedule_display_changed')
}, 60_000)

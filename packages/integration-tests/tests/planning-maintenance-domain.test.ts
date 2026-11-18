import { afterAll, expect, test } from 'bun:test'
import { createPlanningClient } from '../../../apps/planning/src/ui/api.ts'
import { checkForSolver } from '../../../apps/planning/src/solve/lane-k-ports.ts'
import { inputsDigest } from '../../../apps/planning/src/plan/store.ts'
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

test('pinned 18:00 and 15:00 charts survive renewed source reads but reject a changed backup condition', async () => {
  const run = await stack.start('world.scenario', 'nuclear-maintenance-planning', 'world.scenario.start')
  const created = await client.createDemo(definition, run)
  const planId = created.result.plan.id, revision = created.result.plan.revision
  const invoke = async (operationId: string, moduleId: string, type: string, id: string, input: unknown) => {
    const response = await transport(`/api/workspaces/${stack.workspaceId}/capabilities/${operationId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: { workspaceId: stack.workspaceId, moduleId, type, id }, input }),
    })
    return { status: response.status, body: await response.json() as any }
  }
  const display = (option: string, digest?: string, reference?: string | null) => invoke('planning.plan.display', 'planning', 'planning.plan', planId, { option, ...(digest === undefined ? {} : { digest, reference }) })
  const advance = async (previousAt: string) => {
    const stepped = await invoke('world.simulation-run.execution.advance', 'world', 'world.simulation-run', run, { minutes: 1 / 60, onComplete: 'pause' })
    expect(stepped.status).toBe(200)
    for (let attempt = 0; attempt < 100; attempt++) {
      const answer = await client.facts(run, { subjects: ['process-plant/plant%3Amaintenance/componentCoolingWaterPumpB'] })
      const at = answer.items[0]!.facts.find(fact => fact.id.endsWith('/runningState'))!.at
      if (Date.parse(at) > Date.parse(previousAt)) return
      await Bun.sleep(20)
    }
    throw new Error('The World source did not advance')
  }
  await client.generate(planId, revision, { variants: [{ label: 'One crew', buy: [] }, { label: 'Extra crew', buy: ['extra-maintenance-crew'] }] })
  const generated = await client.generate(planId, revision, { keep: true, variants: [
    { label: 'Extra crew by 18:00', buy: ['extra-maintenance-crew'], also: [{ kind: 'due', key: 'by-18', job: 'restore', finishBy: '2026-11-18T17:00:00Z', words: 'Requested by 18:00', source: { by: 'assumption' } }] },
    { label: 'Extra crew by 15:00', buy: ['extra-maintenance-crew'], also: [{ kind: 'due', key: 'by-15', job: 'restore', finishBy: '2026-11-18T14:00:00Z', words: 'Requested by 15:00', source: { by: 'assumption' } }] },
  ] })
  const pins = [] as Array<{ option: string; digest: string; reference: string | null; word: string }>
  for (const label of ['Extra crew by 18:00', 'Extra crew by 15:00']) {
    const option = generated.options.find(candidate => candidate.label === label)!
    const published = await display(option.key)
    expect(published.status).toBe(200)
    pins.push({ option: option.key, digest: published.body.result.schedule.digest, reference: published.body.result.schedule.reference?.key ?? null, word: option.status.word })
  }
  const before = await stack.store.read(stack.workspaceId, planId)
  const sourceAt = (plan: typeof before) => plan.inputs.world.facts.find(fact => fact.id.endsWith('/componentCoolingWaterPumpB/runningState'))!.at
  await advance(sourceAt(before))
  await client.refresh(planId, revision)
  const renewed = await stack.store.read(stack.workspaceId, planId)
  expect(sourceAt(renewed)).not.toBe(sourceAt(before))
  expect(renewed.revision).toBe(revision)
  expect(inputsDigest(renewed.inputs)).toBe(inputsDigest(before.inputs))
  expect(renewed.options).toEqual(before.options)
  // Labels are also read metadata, not a changed scheduling quantity.
  await stack.store.update(stack.workspaceId, planId, { expectedRevision: revision, required: true }, current => ({
    ...current, inputs: { ...current.inputs, world: { ...current.inputs.world, facts: current.inputs.world.facts.map(fact => ({ ...fact, label: `Renewed ${fact.label}` })) } },
  }))
  for (const pin of pins) {
    const checked = await display(pin.option, pin.digest, pin.reference)
    expect(checked.status).toBe(200)
    expect(checked.body.result.schedule.digest).toBe(pin.digest)
    expect(checked.body.result.schedule.option).toMatchObject({ fresh: true, status: { word: pin.word } })
  }
  const stopped = await invoke('world.process-plant.control.write', 'world', 'world.simulation-run', run, { plantId: 'plant:maintenance', path: 'componentCoolingWaterPumpB.running', value: false })
  expect(stopped.status).toBe(200)
  await advance(sourceAt(renewed))
  await client.refresh(planId, revision)
  const changed = await stack.store.read(stack.workspaceId, planId)
  expect(changed.revision).toBe(revision + 1)
  expect(changed.inputs.world.facts.find(fact => fact.id.endsWith('/componentCoolingWaterPumpB/runningState'))!.value).toBe(false)
  for (const pin of pins) {
    const checked = await display(pin.option, pin.digest, pin.reference)
    expect(checked.status).toBe(409)
    expect(checked.body.error.code).toBe('schedule_display_changed')
  }
}, 60_000)

test('pinned schedule rejects an actual row replacement even on the same input revision', async () => {
  const run = await stack.start('world.scenario', 'nuclear-maintenance-planning', 'world.scenario.start')
  const created = await client.createDemo(definition, run)
  const planId = created.result.plan.id, revision = created.result.plan.revision
  const generated = await client.generate(planId, revision, { variants: [{ label: 'Extra crew', buy: ['extra-maintenance-crew'] }] })
  const option = generated.options[0]!
  const display = async (digest?: string) => {
    const response = await transport(`/api/workspaces/${stack.workspaceId}/capabilities/planning.plan.display/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: { workspaceId: stack.workspaceId, moduleId: 'planning', type: 'planning.plan', id: planId }, input: { option: option.key, ...(digest === undefined ? {} : { digest, reference: null }) } }),
    })
    return { status: response.status, body: await response.json() as any }
  }
  const published = await display()
  expect(published.status).toBe(200)
  // An equally feasible retained candidate can move the non-driving HX work
  // within its float. Qualify those rows with the real checker before replacing
  // the owner store's candidate, as another solver result could do.
  await stack.store.update(stack.workspaceId, planId, { expectedRevision: revision, required: true }, current => ({
    ...current, options: { ...current.options!, options: current.options!.options.map(candidate => {
      if (candidate.key !== option.key) return candidate
      const later = (at: string) => new Date(Date.parse(at) + 3_600_000).toISOString()
      const rows = candidate.rows.map(row => row.job !== 'hx-work' ? row : { ...row, start: later(row.start), finish: later(row.finish), uses: row.uses.map(use => ({ ...use, from: later(use.from), to: later(use.to) })) })
      expect(checkForSolver({ inputs: current.inputs, variant: candidate.variant, rows }).violations).toEqual([])
      return { ...candidate, rows }
    }) },
  }))
  const replaced = await display(published.body.result.schedule.digest)
  expect(replaced.status).toBe(409)
  expect(replaced.body.error.code).toBe('schedule_display_changed')
  const current = await display()
  expect(current.status).toBe(200)
  expect(current.body.result.schedule.option).toMatchObject({ inputsRevision: revision, fresh: true })
}, 60_000)

test('a published refusal pins its exact reference or no reference across independent deadline questions', async () => {
  const run = await stack.start('world.scenario', 'nuclear-maintenance-planning', 'world.scenario.start')
  const created = await client.createDemo(definition, run)
  const planId = created.result.plan.id, revision = created.result.plan.revision
  const generate = async (label: string, finishBy: string, buy: string[]) => client.generate(planId, revision, { keep: true, variants: [{
    label, buy, also: [{ kind: 'due', key: label.replaceAll(' ', '-'), job: 'restore', finishBy, words: label, source: { by: 'assumption' } }],
  }] })
  const display = async (input: Record<string, unknown>) => {
    const response = await transport(`/api/workspaces/${stack.workspaceId}/capabilities/planning.plan.display/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: { workspaceId: stack.workspaceId, moduleId: 'planning', type: 'planning.plan', id: planId }, input }),
    })
    return { status: response.status, body: await response.json() as any }
  }
  const fifteen = await generate('Extra by 15', '2026-11-18T14:00:00Z', ['extra-maintenance-crew'])
  const option = fifteen.options.find(candidate => candidate.label === 'Extra by 15')!
  expect(option.status.word).toBe('proven infeasible')
  const withoutReference = await display({ option: option.key })
  expect(withoutReference.status).toBe(200)
  const noReferenceState = JSON.parse(withoutReference.body.result.view.state)
  expect(noReferenceState.reference).toBeNull()
  expect((await display({ option: option.key, digest: noReferenceState.digest })).status).toBe(400)
  expect((await display({ option: option.key, reference: null })).status).toBe(400)
  await generate('One by 1930', '2026-11-18T18:30:00Z', [])
  const referencePublication = await display({ option: option.key })
  const original = referencePublication.body.result.schedule.reference
  const originalState = JSON.parse(referencePublication.body.result.view.state)
  expect(original.finish).toBe('2026-11-18T18:00:00.000Z')
  expect(originalState.reference).toBe(original.key)
  // A subsequent independent question obtains an earlier checked candidate.
  // It may improve a new publication, but cannot replace the chart an older
  // answer published while its own reference is still retained.
  await generate('Extra by 18', '2026-11-18T17:00:00Z', ['extra-maintenance-crew'])
  const newPublication = await display({ option: option.key })
  expect(newPublication.body.result.schedule.reference.finish).toBe('2026-11-18T15:00:00.000Z')
  expect(newPublication.body.result.schedule.reference.key).not.toBe(original.key)
  const pinnedOriginal = await display({ option: originalState.option, digest: originalState.digest, reference: originalState.reference })
  expect(pinnedOriginal.status).toBe(200)
  expect(pinnedOriginal.body.result.schedule.reference).toEqual(original)
  const pinnedNone = await display({ option: noReferenceState.option, digest: noReferenceState.digest, reference: noReferenceState.reference })
  expect(pinnedNone.status).toBe(200)
  expect(pinnedNone.body.result.schedule.reference).toBeNull()
  await stack.store.update(stack.workspaceId, planId, { expectedRevision: revision, required: true }, current => ({
    ...current, options: { ...current.options!, options: current.options!.options.filter(candidate => candidate.key !== original.key) },
  }))
  const missing = await display({ option: originalState.option, digest: originalState.digest, reference: originalState.reference })
  expect(missing.status).toBe(409)
  expect(missing.body.error.code).toBe('schedule_display_changed')
  // The remaining earlier candidate is available only for a new publication;
  // it is never a fallback for the removed published reference.
  expect((await display({ option: option.key })).body.result.schedule.reference.finish).toBe('2026-11-18T15:00:00.000Z')
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
  const display = async (option: string, digest?: string, reference?: string | null) => {
    const response = await transport(`/api/workspaces/${stack.workspaceId}/capabilities/planning.plan.display/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: { workspaceId: stack.workspaceId, moduleId: 'planning', type: 'planning.plan', id: planId }, input: { option, ...(digest === undefined ? {} : { digest, reference }) } }),
    })
    return { status: response.status, body: await response.json() as any }
  }
  let pinned: { option: string; digest: string; reference: string | null } | undefined
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
      expect(option.status.word).toBe(expected[index]!)
      const published = await display(option.key)
      expect(published.status).toBe(200)
      const { view, schedule } = published.body.result
      expect(Buffer.byteLength(JSON.stringify(published.body.result))).toBeLessThanOrEqual(4096)
      expect(view.viewType).toBe('planning.schedule')
      expect(JSON.parse(view.state)).toEqual({ plan: planId, option: option.key, reference: schedule.reference?.key ?? null, digest: schedule.digest })
      expect(schedule.deadline).toEqual({ job: 'restore', finishBy })
      expect(schedule.option.fresh).toBe(true)
      expect(schedule.option.status.word).toBe(expected[index])
      if (label === '15:00') {
        expect(schedule.certificate).not.toBeNull()
        expect(schedule.reference.finish).toBe('2026-11-18T15:00:00.000Z')
        expect(schedule.reference.fresh).toBe(true)
        pinned = { option: option.key, digest: schedule.digest, reference: schedule.reference?.key ?? null }
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
  const first = await display(pinned!.option, pinned!.digest, pinned!.reference)
  expect(first.status).toBe(200)
  await client.edit(planId, revision, { edits: [{ edit: 'job', key: 'pump-work', duration: { value: 5, unit: 'h', calendar: 'working', source: { by: 'assumption', note: 'Found work for the publication invalidation check.' } } }] })
  const stale = await display(pinned!.option, pinned!.digest, pinned!.reference)
  expect(stale.status).toBe(409)
  expect(stale.body.error.code).toBe('schedule_display_changed')
}, 60_000)

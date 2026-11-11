// T0 on the Supply run, from an empty plan (walk fix 8, T0s-02): a planner links the simulation, finds the
// trucks and requests in World, adds them, reads their World values, adds the coverage rule and generates.
// A plan-scoped edit never reads World (adversary item 20): each added World item is saved with its values
// unread, and the Workspace-scoped planning.sources.refresh reads them right after, as the plan screen does.
import { afterAll, expect, test } from 'bun:test'
import { createPlanningStack } from './planning-stack.ts'

const stack = await createPlanningStack()
afterAll(() => stack.close())

test('the Supply run from empty: World trucks and requests are usable once the refresh after each edit reads them', async () => {
  const assistant = stack.room('room-from-empty')
  const one = async (call: Record<string, unknown>) => {
    const answer = await assistant.call({ calls: [{ key: 'c', ...call }] }) as { data: { results: Array<{ success: boolean; data?: any; error?: string }> } }
    const result = answer.data.results[0]!
    if (!result.success) throw new Error(`${String(call.operationId)} failed: ${result.error}`)
    return result.data
  }
  const runId = await stack.start('world.scenario', 'supply-run', 'world.scenario.start')
  const run = { kind: 'resource', ref: { workspaceId: stack.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId } }

  // Find the trucks and the requests, then read their values together (arrivals need both).
  const trucks = (await one({ operationId: 'world.simulation-run.planning-facts', target: run, input: { text: 'truck' } })).items
  const tasks = (await one({ operationId: 'world.simulation-run.planning-facts', target: run, input: { kind: 'task' } })).items
  expect(trucks.length).toBeGreaterThan(1)
  const facts: Array<{ locator: string; id: string; quantity: string }> = []
  let cursor: string | undefined
  do {
    const page = await one({ operationId: 'world.simulation-run.planning-facts', target: run, input: { subjects: [...trucks, ...tasks].map((item: { locator: string }) => item.locator), ...(cursor === undefined ? {} : { cursor }) } })
    for (const item of page.items) for (const fact of item.facts) facts.push({ locator: item.locator, id: fact.id, quantity: fact.quantity })
    cursor = page.more
  } while (cursor !== undefined)
  const fact = (locator: string, test: (id: string) => boolean) => facts.find(entry => entry.locator === locator && test(entry.id))
  const window = { start: '2026-09-03T08:00:00Z', end: '2026-09-03T08:30:00Z' }

  const scope = await assistant.explore({ view: 'scope', moduleId: 'planning' }) as { data: { definitions: any[] } }
  // Jobs of a few minutes: the plan's time step is 30 s, chosen at create.
  const created = await one({ operationId: 'planning.plan.create', target: scope.data.definitions.find(definition => definition.target.ref.id === 'blank').target, input: { grid: '30s', edits: [
    { edit: 'plan', title: 'Supply run from empty', timeZone: 'Europe/Oslo', window, dataDate: window.start, run: runId },
    { edit: 'calendar', key: 'exercise', label: 'On duty for the exercise', periods: [window] },
  ] } })
  const plan = created.target
  let revision = created.plan.revision
  const unread = (problems: Array<{ code: string }>) => problems.length > 0 && problems.every(problem => problem.code === 'world-unread')
  const refresh = async () => {
    const refreshed = await one({ operationId: 'planning.sources.refresh', input: { plan: created.plan.id }, expectedRevision: revision })
    expect(refreshed.problems).toEqual([])
    expect(refreshed.plan.revision).toBe(revision + 1)
    revision = refreshed.plan.revision
    return refreshed
  }

  // The trucks, each with its payload from World: the edit saves them unread and the refresh reads them.
  const truckEdits = trucks.map((truck: { locator: string; label: string }, index: number) => {
    const payload = fact(truck.locator, id => id.endsWith('/property/payloadKg'))!
    return { edit: 'resource', key: `truck-${index + 1}`, label: truck.label, kind: 'tool', count: 1, calendar: 'exercise', locator: truck.locator, attributes: [{ key: 'payloadKg', label: 'Payload', unit: 'kg', fromWorld: { locator: truck.locator, fact: payload.id } }] }
  })
  const added = await one({ operationId: 'planning.plan.edit', target: plan, input: { edits: truckEdits }, expectedRevision: revision })
  revision = added.plan.revision
  expect(unread(added.problems)).toBe(true)
  const read = await refresh()
  expect(read.changed[0]).toMatch(/^Read \d+ World values at .+: \d+ new or changed/)

  // The requests, each taking its time from World per truck (arrival plus service).
  const requestEdits = tasks.slice(0, 2).map((task: { locator: string; label: string }, index: number) => ({
    edit: 'job', key: `request-${index + 1}`, title: `Serve ${task.label}`, kind: 'work', isolation: 'none', locator: task.locator,
    duration: { unit: 's', calendar: 'elapsed', fromWorld: [{ locator: trucks[0].locator, fact: fact(trucks[0].locator, id => id.includes(`arrival-seconds/${decodeURIComponent(task.locator.split('/').at(-1)!)}`))!.id }, { locator: trucks[0].locator, fact: fact(trucks[0].locator, id => id.endsWith('/service-seconds'))!.id }] },
    durationWith: trucks.map((truck: { locator: string }, truckIndex: number) => ({
      resource: `truck-${truckIndex + 1}`,
      fromWorld: [{ locator: truck.locator, fact: fact(truck.locator, id => id.includes(`arrival-seconds/${decodeURIComponent(task.locator.split('/').at(-1)!)}`))!.id }, { locator: truck.locator, fact: fact(truck.locator, id => id.endsWith('/service-seconds'))!.id }],
    })),
    needs: [{ anyOf: trucks.map((_: unknown, truckIndex: number) => `truck-${truckIndex + 1}`) }],
  }))
  const requests = await one({ operationId: 'planning.plan.edit', target: plan, input: { edits: requestEdits }, expectedRevision: revision })
  revision = requests.plan.revision
  expect(unread(requests.problems)).toBe(true)
  await refresh()

  const ruled = await one({ operationId: 'planning.plan.edit', target: plan, input: { edits: [
    { edit: 'rule', key: 'one-free', kind: 'keep-in-service', members: ['truck-1', `truck-${trucks.length}`], atLeast: 1, words: 'Keep at least one of these trucks free at all times.' },
  ] }, expectedRevision: revision })
  revision = ruled.plan.revision

  // World's times are not whole 30 s steps: one note lists the rounding (design D9).
  const note = ruled.attention.find((item: { text: string }) => /rounded up to the 30 s step/.test(item.text))
  console.log('rounding note:', note?.text)
  expect(note).toBeDefined()
  const generated = await one({ operationId: 'planning.plan.generate', target: plan, input: {}, expectedRevision: revision })
  console.log('from empty:', JSON.stringify(generated.options.map((option: any) => ({ word: option.status.word, goals: option.status.goals }))), generated.text)
  expect(generated.options[0].status.word).toBe('validated feasible')
  // On the 30 s grid each request keeps its World time (arrival plus service), never rounded up to a half hour.
  const stored = await stack.store.read(stack.workspaceId, created.plan.id)
  expect(stored.inputs.settings.grid).toBe('30s')
  const rows = stored.options!.options[0]!.rows
  for (const row of rows) {
    const job = stored.inputs.jobs.find(entry => entry.key === row.job)!
    const used = row.uses[0]!.resource
    const refs = job.durationWith.find(entry => entry.resource === used)
    const seconds = refs !== undefined && 'refs' in refs ? refs.refs.reduce((sum, ref) => sum + (stored.inputs.world.facts.find(fact => fact.locator === ref.locator && fact.id === ref.fact)!.value as number), 0) : 0
    const worked = (Date.parse(row.finish) - Date.parse(row.start)) / 1_000
    expect([row.job, worked]).toEqual([row.job, Math.ceil(seconds / 30) * 30])
    expect(worked).toBeLessThan(30 * 60)
  }
})

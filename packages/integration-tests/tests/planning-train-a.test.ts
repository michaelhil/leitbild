// The Train A demo as a planner starts it, through Host with the Agents workspace tools, on the real World,
// solver and checker: start the World Scenario, create the plan from its Definition, link the Run, refresh,
// generate (swap and rebuild), explain, then the days-only what-ifs V1 and V2 with their refusals.
import { afterAll, expect, test } from 'bun:test'
import { createPlanningStack } from './planning-stack.ts'

const stack = await createPlanningStack()
afterAll(() => stack.close())
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

test('the Train A Definition: link, refresh, generate, explain, and V1 and V2 refused with their causes', async () => {
  const assistant = stack.room('room-train-a')
  const one = async (call: Record<string, unknown>) => {
    const answer = await assistant.call({ calls: [{ key: 'c', ...call }] }) as { data: { results: Array<{ success: boolean; data?: any; error?: string }> } }
    const result = answer.data.results[0]!
    if (!result.success) throw new Error(`${String(call.operationId)} failed: ${result.error}`)
    expect(bytes(result.data)).toBeLessThanOrEqual(4_096)
    return result.data
  }
  // A person starts the Definition's World Scenario through Host's normal launch; Planning never does.
  const runId = await stack.start('world.scenario', 'train-a-work-week', 'world.scenario.start')
  const journal = stack.runEvents(runId)
  const scope = await assistant.explore({ view: 'scope', moduleId: 'planning' }) as { data: { definitions: any[] } }
  const created = await one({ operationId: 'planning.plan.create', target: scope.data.definitions.find(definition => definition.target.ref.id === 'train-a-work-week').target, input: {} })
  const plan = created.target
  expect(created.attention[0].text).toContain('Train A work week')
  await one({ operationId: 'planning.plan.edit', target: plan, input: { edits: [{ edit: 'plan', run: runId }] }, expectedRevision: 1 })
  const refreshed = await one({ operationId: 'planning.sources.refresh', input: { plan: created.plan.id }, expectedRevision: 2 })
  console.log('refresh:', JSON.stringify({ changed: refreshed.changed.slice(0, 3), problems: refreshed.problems, attention: refreshed.attention.map((item: { text: string }) => item.text) }))
  expect(refreshed.problems).toEqual([])
  const revision = refreshed.plan.revision

  const generated = await one({ operationId: 'planning.plan.generate', target: plan, input: {}, expectedRevision: revision })
  const shown = generated.options.map((option: any) => ({ label: option.label, word: option.status.word, span: option.span, cost: option.cost, goals: option.status.goals.map((goal: any) => `${goal.value} ${goal.unit} (${goal.word})`), warnings: option.warnings.length }))
  console.log('Train A Definition:', JSON.stringify(shown))
  console.log('sentence:', generated.text)
  const stored = await stack.store.read(stack.workspaceId, created.plan.id)
  console.log('runs:', JSON.stringify(stored.options!.options.map(option => 'run' in option.status ? { stoppedBy: option.status.run.stoppedBy, who: option.status.run.stoppedByWho, cpuMs: option.status.run.cpuMs, evals: option.status.run.evals } : option.status.word)))
  expect(generated.options.map((option: any) => option.status.word)).toEqual(['validated feasible', 'validated feasible'])
  expect(generated.recommended).toBe(generated.options[0].key)
  for (const ask of ['finish', 'why-start'] as const) {
    const explained = await one({ operationId: 'planning.plan.explain', target: plan, input: { ask } })
    expect(explained.items.length).toBeGreaterThan(0)
    console.log(`explain ${ask}:`, explained.lines.slice(0, 2).join(' | '))
  }

  const variants = [
    { label: 'V1 days only, rebuild', methods: [{ choice: 'SWA-method', option: 'rebuild' }], buy: 'no-extra-crew-hours' },
    { label: 'V2 days only, swap', methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'no-extra-crew-hours' },
  ]
  const refused = await one({ operationId: 'planning.plan.generate', target: plan, input: { variants }, expectedRevision: revision })
  expect(refused.options.map((option: any) => option.status.word)).toEqual(['proven infeasible', 'proven infeasible'])
  for (const option of refused.options) {
    const why = await one({ operationId: 'planning.plan.explain', target: plan, input: { ask: 'refusal', option: option.key } })
    console.log(`${option.label}:`, JSON.stringify(option.status.cause), '|', why.lines[0])
    expect(why.lines.join(' ')).toMatch(/Not possible: .*\d h/)
  }
  // The demo read World and wrote nothing there.
  expect(stack.runEvents(runId)).toBe(journal)
}, 300_000)

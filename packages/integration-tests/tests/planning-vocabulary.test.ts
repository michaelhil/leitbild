// Planning's search vocabulary, scored on the real Workspace catalogue the Assistant searches: World, Agents
// and Planning as published through Host, with the Train A Run and a plan in the Workspace, ranked by the
// Agents workspace_explore tool itself. Each phrasing is one search; its rank is where the first expected
// operation lands.
//
// The phrasings are the controls (tuning) set, controls/planning-phrasings-heldout.md of the 11 Nov 2026 Planning
// review (sha256 cb34e60b62400cbd1c67ee4fadf493bf7b417038985902bea61158061490e0a6). Planning's searchTerms were
// tuned against them, so this score says nothing about phrasings nobody tuned on. Before tuning: top-1 7/20,
// top-3 9/20. After: top-1 17/20, top-3 20/20.
import { afterAll, expect, test } from 'bun:test'
import { createPlanningStack } from './planning-stack.ts'

const stack = await createPlanningStack({ realAgents: true })
afterAll(() => stack.close())
await stack.start('world.scenario', 'train-a-work-week', 'world.scenario.start')
await stack.start('planning.plan-definition', 'train-a-work-week', 'planning.plan.create')
const assistant = stack.room('room-vocabulary')

/** The operation ids a search lists, best first. */
const search = async (query: string): Promise<ReadonlyArray<string>> => {
  const result = await assistant.explore({ view: 'operations', queries: [query], limit: 10 }) as { success: boolean; data: { operations: Array<{ operationId: string }> } }
  expect(result.success).toBe(true)
  return result.data.operations.map(operation => operation.operationId)
}

// [id, phrasing, operations that count as found]. H18 may reach generate or explain (the set's own note).
const controls: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
  ['H1', 'Set up the Train A work week outage schedule from the example template so I can look around.', ['planning.plan.create']],
  ['H2', "New blank schedule for next week's pump overhaul. Site time Oslo, window Monday 07:00 to Friday 19:00.", ['planning.plan.create']],
  ['H3', 'Which train A pumps and heat exchangers can I pull into scope from the running simulation?', ['world.simulation-run.planning-facts']],
  ['H4', 'Put CCW pump A and the CCW A heat exchanger in scope. CCW A is cooled by service water pump A, so it goes down when SW A is out.', ['planning.plan.edit']],
  ['H5', 'Add an activity "Replace mechanical seal, CCW pump A": 6 hours, one station mechanical crew, done inside the isolation.', ['planning.plan.edit']],
  ['H6', 'Make a calendar for day shift, Mon to Fri 07:00 to 15:00, and assign it to the station electricians, 2 people per crew.', ['planning.plan.edit']],
  ['H7', 'Coupling alignment is FS off the seal replacement with a 2 hour lag for the grout to cure.', ['planning.plan.edit']],
  ['H8', "Hydrolancing can start 2 hrs after the channel heads start coming off, and it can't finish until an hour after they're all off.", ['planning.plan.edit']],
  ['H9', 'Train B is off limits this week. Nothing gets tagged, worked or tested on it.', ['planning.plan.edit']],
  ['H10', "The cooling chain can't be out of service for more than 72 hours in one stretch.", ['planning.plan.edit']],
  ['H11', 'Always keep at least one of the two aux feedwater pumps available.', ['planning.plan.edit']],
  ['H12', 'Put a finish-on-or-before on the diesel surveillance run: it must be done by Wednesday 12:00, no exceptions.', ['planning.plan.edit']],
  ['H13', "Hook this schedule up to the simulation run that's going for Train A.", ['planning.plan.edit']],
  ['H14', 'Pull the latest equipment status and durations from the simulator. Has anything changed since I last looked?', ['planning.sources.refresh']],
  ['H15', 'Level it and give me a few alternatives: with the contractor night crew and without.', ['planning.plan.generate']],
  ['H16', 'Why is the eddy-current test sitting on Friday and not Wednesday?', ['planning.plan.explain']],
  ['H17', "What's driving the completion date? Show me the longest path back to service.", ['planning.plan.explain']],
  ['H18', "Can we have the whole train back inside 40 hours with the people we've got and no overtime?", ['planning.plan.generate', 'planning.plan.explain']],
  ['H19', 'Take option 2 as the target schedule and save it as baseline "Rev 0".', ['planning.plan.baseline']],
  ['H20', "Get rid of the test schedule I made this morning, I don't need it.", ['planning.plan.delete']],
]

test('the controls phrasings find their Planning operation: at least 17 of 20 first and all 20 in the top three', async () => {
  const ranks = await Promise.all(controls.map(async ([id, phrasing, expected]) => {
    const found = await search(phrasing)
    return { id, rank: found.findIndex(operationId => expected.includes(operationId)) + 1, first: found[0] }
  }))
  console.log('controls ranks:', ranks.map(({ id, rank, first }) => `${id} ${rank === 0 ? '-' : rank}${rank === 1 ? '' : ` (${first})`}`).join(', '))
  const top1 = ranks.filter(({ rank }) => rank === 1).length
  const top3 = ranks.filter(({ rank }) => rank >= 1 && rank <= 3).length
  console.log(`controls: top-1 ${top1}/20, top-3 ${top3}/20`)
  expect(top1).toBeGreaterThanOrEqual(17)
  expect(top3).toBe(20)
})

// World's and Agents' operations searched for in their own words (written for this check, not by their
// Modules): Planning's vocabulary must not put a Planning operation above any of them.
const others: ReadonlyArray<readonly [string, string]> = [
  ['start the scenario', 'world.scenario.start'],
  ['delete the simulation run', 'world.simulation-run.delete'],
  ['advance the run by ten minutes', 'world.simulation-run.execution.advance'],
  ['which alarms are active', 'world.process-plant.alarms.status'],
  ['create a new room', 'agents.room.create'],
  ['create an agent', 'agents.agent.create'],
  ['pin this trend to the dashboard', 'world.simulation-run.dashboard.update'],
  ['read the procedure document', 'world.procedure.document.read'],
  ['start a procedure run', 'world.procedure.run.start'],
  ['trip the turbine', 'world.process-plant.action.invoke'],
  ['search plant signals for pressurizer level', 'world.process-plant.signals.search'],
  ['copy this simulation run', 'world.simulation-run.copy'],
  ['list installed agent packs', 'agents.packs.list'],
  ['delete the scenario', 'world.scenario.delete'],
  ['propose a control operation', 'world.process-plant.control.propose'],
  ['next procedure step', 'world.procedure.run.step.read'],
  ['write a new scenario', 'world.scenario.create'],
  ['planning facts for equipment in the run', 'world.simulation-run.planning-facts'],
  ['fail the feedwater pump', 'world.process-plant.action.invoke'],
  ['show me a display of the steam generator levels', 'world.simulation-run.display.compose'],
]

test('World and Agents operations still rank above every Planning operation for their own words', async () => {
  for (const [query, expected] of others) {
    const found = await search(query)
    const own = found.indexOf(expected)
    const planning = found.findIndex(operationId => operationId.startsWith('planning.'))
    expect({ query, own: own >= 0, planningFirst: planning >= 0 && planning < own }).toEqual({ query, own: true, planningFirst: false })
  }
})

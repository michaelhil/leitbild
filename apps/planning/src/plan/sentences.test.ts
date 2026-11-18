// Generated sentences never leave a slot empty (walk 3, R3-1: "cannot fit after its release, after .") and
// say when a search stopped early (R3-3, N-A).
import { describe, expect, test } from 'bun:test'
import { refusalLines } from '../solve/explain.ts'
import { planInputsSchema, type Certificate, type PlanInputs, type Status } from './schema.ts'
import { statusSentence } from './summary.ts'
import { bundledPlanDefinitions } from '../definitions/index.ts'

const trainA: PlanInputs = planInputsSchema.parse(bundledPlanDefinitions.find(definition => definition.id === 'train-a-work-week')!.inputs)
const jobs = trainA.jobs.map(job => job.key)
const rule = trainA.rules.find(entry => entry.kind === 'keep-in-service' || entry.kind === 'protected')!.key
const crews = trainA.resources.map(resource => resource.key)
const from = '2026-11-16T06:00:00Z', to = '2026-11-17T06:00:00Z'

/** A word that needs something after it, followed by nothing; empty brackets or quotes; a doubled space. */
const emptySlot = /\b(after|before|of|and|with|at|from|to|between|on|by|until|the|its|for)\s*[.,;:)]|\(\s*\)|''|\s{2,}|:\s*\./
/** Solver words a planner never reads (walk 4, R4-2). */
const solverWords = /\b(release|released|slot|slots|mode|modes)\b/i

const certificates: Certificate[] = [
  ...(['link', 'release', 'due', 'lock', 'window', 'bracket', 'support-order', 'span-limit'] as const).flatMap(via => [
    { kind: 'temporal' as const, steps: [{ job: jobs[0]!, via }] },
    { kind: 'temporal' as const, steps: [{ job: jobs[0]!, via }, { job: jobs[1]!, via: 'link' as const }] },
  ]),
  { kind: 'temporal', steps: [] },
  { kind: 'chain', jobs: [jobs[0]!], workHours: 10, calendars: [], availableHours: 2, from, by: to },
  { kind: 'energy', resources: [crews[0]!], jobs: [], requiredHours: 40, availableHours: 24, from, to },
  { kind: 'energy', resources: [crews[0]!], jobs: jobs.slice(0, 2), requiredHours: 40, availableHours: 24, from, to },
  { kind: 'availability', rule, items: [], from, to },
]

describe('refusal sentences have no empty slot (walk 3, R3-1, N-C-01/02)', () => {
  test.each(certificates.map(cause => [JSON.stringify(cause).slice(0, 80), cause] as const))('%s', (_name, cause) => {
    const run = { grid: '30min' as const, engine: 'test', formulation: 'f', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
    for (const line of [...refusalLines(cause, trainA, undefined, [], []), statusSentence({ word: 'proven infeasible', cause, run } as Status, trainA)]) {
      expect([line, emptySlot.test(line), solverWords.test(line)]).toEqual([line, false, false])
    }
  })
})

describe('a due time no plan can meet is said in the preview\'s words (walk 4, R4-2, N4-2-01)', () => {
  // The walk's case: the window opens Thu 3 Sep 10:00 (Oslo); a 1 h delivery is due at 10:30.
  const start = '2026-09-03T08:00:00Z', end = '2026-09-03T16:00:00Z'
  const supply = planInputsSchema.parse({
    settings: { title: 'Supply run T0', timeZone: 'Europe/Oslo', window: { start, end }, dataDate: start, grid: '30s', currency: 'NOK', run: null },
    equipment: [], groups: [], purchases: [], methods: [], links: [], goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
    calendars: [{ key: 'whole', label: 'Available for the whole window', weekly: [], periods: [{ start, end }], except: [], source: { by: 'planner' } }],
    resources: [{ key: 'truck-1', label: 'Truck 1', kind: 'tool', count: 1, calendar: 'whole', attributes: [], source: { by: 'planner' } }],
    jobs: [{ key: 'food', title: 'Deliver food to the south shelter', kind: 'work', equipment: [], isolation: 'none', duration: { value: 1, unit: 'h', calendar: 'working', origin: { by: 'planner' } }, durationWith: [], needs: [{ anyOf: ['truck-1'], amount: 1, handover: false }], continuous: true, checks: [], tags: [] }],
    rules: [{ kind: 'due', key: 'due-food', job: 'food', finishBy: '2026-09-03T08:30:00Z', words: 'Food at the south shelter by 10:30', source: { by: 'planner' } }],
  })
  test.each([['release'], ['due'], ['window']] as const)('a temporal refusal reached by %s names the finish, the hours late and the rule', via => {
    const lines = refusalLines({ kind: 'temporal', steps: [{ job: 'food', via }] }, supply, undefined, [], [])
    expect(lines[0]).toBe("Not possible: 'Deliver food to the south shelter' finishes Thu 11:00 at the earliest, 0.5 h after it is due at Thu 10:30 (the due-time rule 'Food at the south shelter by 10:30').")
    for (const line of lines) expect([line, emptySlot.test(line), solverWords.test(line)]).toEqual([line, false, false])
  })
})

describe('an early stop is said with the status (walk 3, R3-3, N-A)', () => {
  const status = (stoppedBy: 'done' | 'wall' | 'memory' | 'cpu' | 'cancelled'): Status => ({
    word: 'validated feasible', goals: [{ word: 'best found under budget', goal: 0, value: 13, unit: 'h' }],
    run: { grid: '30min', engine: 'test', formulation: 'f', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy, evals: 1, cpuMs: 1 },
  })
  test('memory, processor time or a stop: "may not be the best"; the budget\'s own end says nothing more', () => {
    expect(statusSentence(status('memory'), trainA)).toMatch(/ The search stopped early \(memory limit\); this option may not be the best\.$/)
    expect(statusSentence(status('cpu'), trainA)).toMatch(/\(processor time limit\); this option may not be the best\.$/)
    expect(statusSentence(status('cancelled'), trainA)).toMatch(/\(cancelled\); this option may not be the best\.$/)
    for (const end of ['done', 'wall'] as const) expect(statusSentence(status(end), trainA)).not.toContain('stopped early')
  })

  test('one word per goal; how the search ended said once; a bound never called "the best possible" (walk 4, R4-3, N4-1)', () => {
    const run = { grid: '30s' as const, engine: 'test', formulation: 'f', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
    // The walk's 2-job Supply run: finish 1.8 h against a weak 1 h bound; cost and lateness at their bounds.
    const sentence = statusSentence({ word: 'validated feasible', run, goals: [
      { word: 'best found under budget', goal: 0, value: 1.8, unit: 'h', bound: { value: 1.05, source: 'logic+calendars', certificate: { kind: 'zero' } } },
      { word: 'best found under budget', goal: 1, value: 0, unit: 'NOK', bound: { value: 0, source: 'fixed-costs', certificate: { kind: 'zero' } } },
      { word: 'best found under budget', goal: 2, value: 0, unit: 'h' },
    ] }, trainA)
    expect(sentence).toBe('Validated feasible: outage time over target 1.8 h (best found; could be up to 0.75 h better); extra cost NOK 0 (best found); hours out of service 0 h (best found). The search ran to the end.')
    expect(sentence.match(/ran to the end|stopped early/g)).toEqual(['ran to the end'])
    expect(sentence).not.toMatch(/best possible|under budget/)
    const proven = statusSentence({ word: 'validated feasible', run, goals: [{ word: 'proven optimal', goal: 0, value: 1, unit: 'h', bound: { value: 1, source: 'logic+calendars', certificate: { kind: 'zero' } } }] }, trainA)
    expect(proven).toMatch(/ \(proven optimal\)\. The search ran to the end\.$/)
  })
})

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
    for (const line of [...refusalLines(cause, trainA), statusSentence({ word: 'proven infeasible', cause, run } as Status, trainA)]) {
      expect([line, emptySlot.test(line)]).toEqual([line, false])
    }
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
})

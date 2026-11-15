import { describe, expect, test } from 'bun:test'
import { statusWordSchema } from '../plan/schema.ts'
import { runBasis, status, trainAInputs } from './fixtures/plans.ts'
import { createTimeFormat } from './format.ts'
import { createNames } from './model.ts'
import { certificateText, goalName, goalOrderText, statusView, type Context } from './status-text.ts'

const inputs = trainAInputs()
const context: Context = { inputs, names: createNames(inputs), format: createTimeFormat(inputs.settings.timeZone) }
const run = runBasis(inputs.settings.grid)

describe('status in words, from structure', () => {
  test('the status and goal words are exactly the schema words', () => {
    const views = [
      statusView(status({ word: 'validated feasible', run, goals: [] }), context),
      statusView(status({ word: 'cancelled', run }), context),
      statusView(status({ word: 'unresolved', run }), context),
      statusView(status({ word: 'invalid input', problems: [{ code: 'world_value_unread', about: ['SWA'] }] }), context),
      statusView(status({ word: 'unsupported feature', problems: [{ code: 'two_trains_out_mode_change', about: [] }] }), context),
    ]
    for (const view of views) expect(statusWordSchema.options).toContain(view.word)
    expect(views[2]!.sentence).toContain('This is not proof that none exists.')
    expect(views[3]!.details).toEqual(['Service Water Pump A: a World value is not read yet; read the World values.'])
    // A code the screen has no words for is never shown raw (maint's walk 2, R2-7).
    expect(views[4]!.details).toEqual(['A check did not pass.'])
  })

  test('each goal says how far from the best it can be', () => {
    // Hand values: goal 1 at its bound; goal 2 above fixed costs of NOK 425,050, which every plan pays.
    const view = statusView(status({
      word: 'validated feasible', run,
      goals: [
        { word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } },
        { word: 'best found under budget', goal: 1, value: 464250, unit: 'NOK', bound: { value: 425050, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'charged', amount: 425050 }] } } },
        { word: 'best found under budget', goal: 2, value: 254, unit: 'h' },
      ],
    }), context)
    expect(view.goals.map(goal => [goal.mark.word, goal.distance])).toEqual([
      // One word per goal; the gap only when it is positive; never "best possible" (maint's walk 4, N4-1).
      ['proven optimal', ''],
      ['best found', 'no plan can cost less than NOK 425,050'],
      ['best found', ''],
    ])
    // Short names on the main screen; the full wording is said once, in Rules and goals.
    expect(view.goals.map(goal => goal.name)).toEqual(['Over the 54 h guideline', 'Extra cost', 'Equipment-hours out of service'])
    expect(goalName(context.inputs.goals[0]!, context)).toBe('time over the 54 h guideline for Train A cooling chain (SW A, CCW A and HX A, RHR A, HHSI A)')
    expect(view.run).toBe('The search ran to the end.')
  })

  test('proofs of infeasibility name the work, the capacity and the interval', () => {
    // Hand values for a chain certificate: 38 h of work against 32 working hours.
    const chain = certificateText({ kind: 'chain', jobs: ['SWA-PUMP-OUT', 'SWA-REBUILD', 'SWA-RTS'], workHours: 38, calendars: ['day'], availableHours: 32, from: '2026-11-16T06:00:00Z', by: '2026-11-20T14:00:00Z' }, context)
    expect(chain).toBe('Pull SW A pump assembly, Rebuild SW A bowl assembly in workshop and Restore SW A, fill and vent, pump test need 38 h of work one after another, but Day shift gives only 32 h of working time between Mon 07:00 and Fri 15:00.')
    const energy = certificateText({ kind: 'energy', resources: ['mech-station', 'mech-contractor'], jobs: [], requiredHours: 49, availableHours: 48, from: '2026-11-16T20:00:00Z', to: '2026-11-17T01:00:00Z', span: 'R2' }, context)
    expect(energy).toContain('49 crew-hours of Station mechanical crew and Contractor mechanical night crew must fit inside any outage that “Once the first cooling-chain item is tagged out')
    expect(energy).toContain('opening between Mon 21:00 and Tue 02:00; at most 48 crew-hours exist.')
    const view = statusView(status({ word: 'proven infeasible', run, cause: { kind: 'chain', jobs: ['SWA-RTS'], workHours: 38, calendars: ['day'], availableHours: 32, from: '2026-11-16T06:00:00Z', by: '2026-11-20T14:00:00Z' } }), context)
    expect(view.word).toBe('proven infeasible')
    expect(view.mark.shape).toBe('✕')
  })

  test('the goal order reads as a policy, with the cost step from the plan', () => {
    const cost = inputs.goals.find(goal => goal.metric === 'extra-cost')!.tolerance.value
    expect(goalOrderText(inputs.goals, context)[1]).toBe(`2. Least extra cost (compared in steps of NOK ${cost.toLocaleString('en-GB')})`)
  })
})

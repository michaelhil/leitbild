import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { expectedAfterGroup } from '../src/packs/process-plant/ic/alarm-philosophy.ts'
import { processPlantIcLifecycleStateSchema, type ProcessPlantIcLifecycleState } from '../src/packs/process-plant/runtime/index.ts'

// What the reference PWR declares expected after a first-out, and the window
// past which an expected alarm still standing is news again (plan v5 W2.3).

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:annunciation', loopCount: 4 }))

describe('what the reference PWR declares expected after a reactor trip, and for how long', () => {
  const declared = plant.automation.rules.flatMap(rule => rule.effects.flatMap(effect => effect.type === 'trip.enter' || effect.type === 'alarm.enter' ? [{ rule, effect }] : []))
  const expectedAfterOf = (ruleId: string) => declared.filter(entry => entry.rule.id === ruleId).map(entry => entry.effect.type === 'writeSignal' ? undefined : entry.effect.annunciator?.expectedAfter)
  const window = { firstOutGroup: 'reactor-trip', withinMs: 300_000 }

  test('every reactor trip but its first out, and the turbine trip on P-4, are expected after the reactor trip; the SI actuation never is', () => {
    // A first-out panel shows every reactor trip after the first as subsequent: it comes in on a reactor already tripping.
    const reactorTrips = declared.filter(({ effect }) => effect.type === 'trip.enter' && effect.annunciator?.firstOutGroup === 'reactor-trip')
    expect(reactorTrips.length).toBeGreaterThan(10)
    expect(reactorTrips.filter(({ effect }) => effect.type === 'writeSignal' || effect.annunciator?.expectedAfter === undefined).map(({ rule }) => rule.id)).toEqual([])
    expect(expectedAfterOf('reactor-trip-turbine-trip')).toEqual([window])
    expect(expectedAfterOf('safety-injection-low-pzr-pressure')).toEqual([undefined, window, undefined, undefined])
    // What a LOOP takes out is not a reactor trip's consequence, and stays news: the RCPs, the feed pumps, the buses.
    expect([...expectedAfterOf('rcp-a-trip'), ...expectedAfterOf('main-feedwater-pump-trip'), ...expectedAfterOf('safety-bus-a-loss-alarm')]).toEqual([undefined, undefined, undefined])
  })

  const lifecycle = (id: string, at: number, extra: Partial<ProcessPlantIcLifecycleState> = {}): ProcessPlantIcLifecycleState => {
    const [kind, ruleId, effectId] = id.split(':') as ['alarm' | 'trip', string, string]
    const effect = plant.automation.rules.find(rule => rule.id === ruleId)!.effects.find(entry => entry.type !== 'writeSignal' && entry.id === effectId)!
    return processPlantIcLifecycleStateSchema.parse({
      id, ruleId, effectId, kind, title: id, message: id, severity: 'critical', ...(effect.type === 'writeSignal' ? {} : { annunciator: effect.annunciator }),
      active: true, acknowledged: false, latched: false, suppressed: false, resettable: false, transitionCount: 1, firstActiveElapsedMs: at, lastActiveElapsedMs: at, ...extra,
    })
  }

  test('expires at its declared window from the first-out: one still standing then is news again (W2.3)', () => {
    const first = lifecycle('trip:reactor-turbine-trip:turbine-trip-reactor-trip', 60_000, { firstOut: true, firstOutRank: 1 })
    const level = lifecycle('alarm:sg-a-level-low:level-low', 80_000)
    const all = [first, level]
    expect(expectedAfterGroup(plant, level, all, 120_000)?.shortLabel).toBe('RX TRIP')
    expect(expectedAfterGroup(plant, level, all, 60_000 + 300_000)?.shortLabel).toBe('RX TRIP')
    expect(expectedAfterGroup(plant, level, all, 60_000 + 300_001)).toBeNull()
    expect(expectedAfterGroup(plant, first, all, 120_000)).toBeNull()
  })
})

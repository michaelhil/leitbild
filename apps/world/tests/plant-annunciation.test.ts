import { describe, expect, test } from 'bun:test'
import { annunciationSchema } from '../src/core/observation/annunciation.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { expectedAfterGroup } from '../src/packs/process-plant/ic/alarm-philosophy.ts'
import { processPlantIcLifecyclePayloadSchema } from '../src/packs/process-plant/commands.ts'
import { plantAnnunciation } from '../src/packs/process-plant/observation/annunciation.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { processPlantIcLifecycleStateSchema, type ProcessPlantIcLifecycleState } from '../src/packs/process-plant/runtime/index.ts'

// How the reference PWR annunciates its alarms and trips to World (plan v5
// W2.3–W2.6, D-E: static, in its observation declaration), from what its I&C
// declares, never from ids or titles. OLD's annunciation test
// (process-plant-composed-display.test.ts, "come from the first-out groups and
// limits the I&C declares", at 724ae2ac8) is re-expressed here.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:annunciation', loopCount: 4 }))
const annunciation = plantAnnunciation(plant)
const of = (ruleId: string) => annunciation.alerts.filter(alert => alert.id.split(':')[1] === ruleId)
const tagsOf = (ruleId: string) => of(ruleId).map(alert => alert.tag)

describe('the reference PWR\'s annunciation', () => {
  test('is a valid declaration, carried by the Plant\'s observation declaration, one entry per alarm and trip its rules annunciate', () => {
    expect(() => annunciationSchema.parse(annunciation)).not.toThrow()
    expect(plantDeclaration('plant:annunciation' as never, plant, null).annunciation).toBe(annunciation)
    const annunciated = plant.automation.rules.filter(rule => rule.enabled).flatMap(rule => rule.effects.flatMap(effect => effect.type === 'alarm.enter' || effect.type === 'trip.enter' ? [`${effect.type === 'alarm.enter' ? 'alarm' : 'trip'}:${rule.id}:${effect.id}`] : []))
    expect(annunciation.alerts.map(alert => alert.id).sort()).toEqual([...annunciated].sort())
  })

  test('first-out groups by their short labels; only the reactor trip and the turbine trip stop an energy end, which their labels open', () => {
    expect(annunciation.groups.map(group => [group.label, group.ends ?? []])).toEqual([
      ['RX TRIP', ['core']], ['SI', []], ['AFW START', []], ['FWI', []], ['TURB TRIP', ['turbine']], ['MSI', []], ['CS', []], ['BUS DEAD', []], ['BUS DEGR', []],
    ])
  })

  test('tags name a limit by its order and what the alert annunciates does, or what a rule with no limit watches, never a bare ALM', () => {
    // QA review of run 22: the reactor trip safety injection causes is a reactor trip, not "LO-LO · SI".
    expect([
      tagsOf('sg-b-level-low-low-reactor-trip'), tagsOf('safety-injection-low-pzr-pressure'), tagsOf('pzr-pressure-low'),
      tagsOf('reactor-overtemperature-delta-t-trip'), tagsOf('loss-of-offsite-power'), tagsOf('safety-bus-a-loss-alarm'),
    ]).toEqual([['LO-LO · RX TRIP'], ['LO-3 · SI', 'LO-3 · RX TRIP', 'LO-3 · FWI', 'LO-3 · AFW START'], ['LO · ALM'], ['RX TRIP'], ['LO-LO · ALM'], ['DEAD · ALM']])
    // HMI review of run 23: a pump not running, a level low with low feed flow, as a drawing's words name them.
    expect([tagsOf('rcp-a-trip'), tagsOf('sg-b-feedwater-low'), tagsOf('pzr-porv-flow')]).toEqual([['NOT RUN · ALM'], ['L LO & F LO · ALM'], ['RELIEF VALVE FLOWING · ALM']])
    // A pump commanded to run, its bus live, that does not: what is wrong with it, not its command and permissive.
    expect(tagsOf('motor-driven-afw-pump-a-fails-to-start')).toEqual(['NOT RUN · ALM'])
    expect(tagsOf('reactor-trip-low-tavg-feedwater-isolation')).toEqual(['LO · FWI'])
    expect(annunciation.alerts.map(alert => alert.tag)).not.toContain('ALM')
    expect(of('safety-injection-low-pzr-pressure').map(alert => alert.group)).toEqual(['safety-injection', 'reactor-trip', 'feedwater-isolation', 'auxiliary-feedwater'])
  })

  test('every alert names one of the declared annunciator systems, listed in their declared order', () => {
    expect(annunciation.categories.map(category => category.id)).toEqual(plant.automation.annunciatorSystems.map(system => system.id))
    // Each by its label and its short label, a narrow tile's (W2.2).
    expect(annunciation.categories.map(category => category.short)).toEqual(plant.automation.annunciatorSystems.map(system => system.shortLabel))
    expect(annunciation.alerts.filter(alert => alert.category === undefined)).toEqual([])
  })

  test('a person acknowledges an alarm or a trip by its lifecycle, through the Plant\'s lifecycle command (W2.7, D-E)', () => {
    expect(annunciation.acknowledge).toEqual({ capabilityId: 'world.process-plant.ic.lifecycle', input: { action: 'acknowledge' }, objectField: 'plantId', alertField: 'lifecycleId' })
    expect(processPlantIcLifecyclePayloadSchema.parse({ ...annunciation.acknowledge!.input, plantId: 'plant:x', lifecycleId: annunciation.alerts[0]!.id })).toMatchObject({ action: 'acknowledge' })
  })

  test('each alert\'s expected window is its annunciator\'s', () => {
    const window = { group: 'reactor-trip', withinMs: 300_000 }
    expect(of('reactor-trip-turbine-trip').map(alert => alert.expectedAfter)).toEqual([window])
    expect(of('safety-injection-low-pzr-pressure').map(alert => alert.expectedAfter)).toEqual([undefined, window, undefined, undefined])
    expect(of('sg-a-feedwater-low').map(alert => alert.expectedAfter)).toEqual([window])
  })
})

describe('what the reference PWR declares expected after a reactor trip, and for how long', () => {
  const declared = plant.automation.rules.flatMap(rule => rule.effects.flatMap(effect => effect.type === 'trip.enter' || effect.type === 'alarm.enter' ? [{ rule, effect }] : []))
  const expectedAfterOf = (ruleId: string) => declared.filter(entry => entry.rule.id === ruleId).map(entry => entry.effect.annunciator?.expectedAfter)
  const window = { firstOutGroup: 'reactor-trip', withinMs: 300_000 }

  test('every reactor trip but its first out, and the turbine trip on P-4, are expected after the reactor trip; the SI actuation never is', () => {
    // A first-out panel shows every reactor trip after the first as subsequent: it comes in on a reactor already tripping.
    const reactorTrips = declared.filter(({ effect }) => effect.type === 'trip.enter' && effect.annunciator?.firstOutGroup === 'reactor-trip')
    expect(reactorTrips.length).toBeGreaterThan(10)
    expect(reactorTrips.filter(({ effect }) => effect.annunciator?.expectedAfter === undefined).map(({ rule }) => rule.id)).toEqual([])
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

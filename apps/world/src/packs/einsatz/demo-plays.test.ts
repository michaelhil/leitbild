import { describe, expect, test } from 'bun:test'
import { isMapSymbol } from '../../core/map-symbols/catalog.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import atlas from '../../core/map-symbols/common.json'
import { compileScenarioDefinition } from '../../core/scenarios/compiler.ts'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../../core/scenarios/definition.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import emergencyJson from '../../scenarios/halden-emergency.scenario.json'
import supplyJson from '../../scenarios/supply-run.scenario.json'
import { startingZoomFor } from '../../ui/map/map-camera.ts'
import { einsatzCommandIds as ids, einsatzQueryIds } from './capabilities.ts'
import { openCardScreen, type CardScreen } from './fixtures/card-harness.ts'
import { afterNearestBusy, bothToOne, configOf, lonLatOf, metresBetween, playDemo, slowedRouting, type Beat, type CallLog, type PlayLog, type Policy } from './fixtures/demo-play.ts'
import { openRun, type OpenRun } from './fixtures/run-harness.ts'
import { einsatzPack } from './pack.ts'
import type { RecommendAnswer } from './recommendation-schema.ts'
import type { Situation } from './situation/schema.ts'
import { einsatzPackView } from './ui-pack.ts'
import { dispatchMapCover, panelBottomClearancePx, panelLayoutFor, panelTopClearancePx } from './ui/dispatch-layout.ts'
import { einsatzRecordsKey } from './ui/presenters.ts'

/**
 * The demo Definitions every leitbild.app user can start, held to the demo
 * quality bar: words, pacing, the start view on an iPad, objectives that a
 * good dispatcher meets and a passive one does not, icons and no call that
 * nobody but the Controller can close; and plan B.11's click counts, each
 * row played on a Dispatch panel screen (`fixtures/card-harness.ts`) at
 * the count it states. Every order of every play is given by the panel's
 * own clicks. Plays run headless on the direct router, and again with
 * travel twice and two and a half times as slow, as town roads make it, by
 * a dispatcher who reacts at once, after 30 s and after 60 s. Objectives
 * are judged when the exercise ends, from the Run's state: a call still
 * waiting then has waited until then. Everything is found from the
 * Definitions themselves: cues by id, calls by when a cue made them, units
 * and places by their records.
 */

type Definition = ScenarioDefinition & { readonly timeline: NonNullable<ScenarioDefinition['timeline']> }
const parse = (raw: unknown): Definition => scenarioDefinitionSchema.parse(raw) as Definition
const emergency = parse(emergencyJson)
const supply = parse(supplyJson)

const cueAt = (definition: Definition, cueId: string): number => {
  const cue = definition.timeline.cues.find(entry => entry.id === cueId)
  if (cue === undefined) throw new Error(`${definition.id} has no cue ${cueId}`)
  return cue.at.seconds
}
/** The Run second the exercise ends: the last cue, which shows its end. */
const endOf = (definition: Definition): number => Math.max(...definition.timeline.cues.map(cue => cue.at.seconds))
/** What the objective's own words state, so the check and the text cannot drift apart. */
const stated = (definition: Definition, index: number, pattern: RegExp): string => {
  const match = pattern.exec(definition.objectives[index] ?? '')
  if (match === null) throw new Error(`${definition.id} objective ${index} does not state ${pattern}`)
  return match[1]!
}
const statedS = (definition: Definition, index: number, pattern: RegExp): number => Number(stated(definition, index, pattern)) * 60
const minutes = /within (\d+) minutes of the (?:call|request)/
const waitsAtMost = /more than (\d+) minutes/
const priorityCode = /every (?:top-priority )?\(?(P\d)\)? call/

interface Demo {
  readonly definition: Definition
  /** The good dispatcher's planned moves at the beats. */
  readonly beats: ReadonlyArray<Beat>
  /** Each objective, judged from a play. */
  readonly objectives: (log: PlayLog) => ReadonlyArray<boolean>
  /** The least slack, in seconds, any call has against the objectives that set a response time for every call of a priority. */
  readonly slack: (log: PlayLog) => number
}

const topPriority = (definition: Definition): string => configOf(definition).priorities[0]!.id
/** The priority an objective names by its code. */
const priorityNamed = (definition: Definition, index: number): string => {
  const code = stated(definition, index, priorityCode)
  const found = configOf(definition).priorities.find(entry => entry.code === code)
  if (found === undefined) throw new Error(`${definition.id} has no priority ${code}`)
  return found.id
}
/** How long a call waited for its first unit, as the Run stands when the exercise ends. */
const waitedS = (definition: Definition, call: CallLog): number => Math.min(call.firstOnSceneS ?? Number.POSITIVE_INFINITY, endOf(definition)) - call.createdS
/** The calls the exercise holds: those a cue made before it ended. */
const inExercise = (definition: Definition, calls: ReadonlyArray<CallLog>): ReadonlyArray<CallLog> => calls.filter(call => call.createdS <= endOf(definition))
const createdBy = (calls: ReadonlyArray<CallLog>, atS: number): CallLog => {
  const found = calls.filter(call => call.createdS === atS)
  if (found.length !== 1) throw new Error(`Expected one call created at ${atS} s, found ${found.length}`)
  return found[0]!
}

const demos: Readonly<Record<'emergency' | 'supply', Demo>> = {
  emergency: {
    definition: emergency,
    beats: [afterNearestBusy('second fire beside the first', cueAt(emergency, 'harbour-car-fire'))],
    objectives: ({ calls }) => {
      const held = inExercise(emergency, calls)
      return [
        held.filter(call => call.priority === priorityNamed(emergency, 0)).every(call => waitedS(emergency, call) <= statedS(emergency, 0, minutes)),
        waitedS(emergency, createdBy(held, cueAt(emergency, 'harbour-car-fire'))) <= statedS(emergency, 1, minutes),
        held.filter(call => call.priority === priorityNamed(emergency, 2)).every(call => waitedS(emergency, call) <= statedS(emergency, 2, minutes)),
      ]
    },
    slack: ({ calls }) => Math.min(...[0, 2].flatMap(index => inExercise(emergency, calls)
      .filter(call => call.priority === priorityNamed(emergency, index))
      .map(call => statedS(emergency, index, minutes) - waitedS(emergency, call)))),
  },
  supply: {
    definition: supply,
    beats: [
      bothToOne('two requests side by side', cueAt(supply, 'scout-camp-request')),
      afterNearestBusy('the heavy unit stays home', cueAt(supply, 'harbour-request')),
    ],
    objectives: ({ calls }) => {
      const held = inExercise(supply, calls)
      return [
        held.filter(call => call.priority === topPriority(supply)).every(call => waitedS(supply, call) <= statedS(supply, 0, minutes)),
        held.every(call => waitedS(supply, call) <= statedS(supply, 1, waitsAtMost)),
      ]
    },
    slack: ({ calls }) => Math.min(...inExercise(supply, calls).map(call => statedS(supply, 1, waitsAtMost) - waitedS(supply, call))),
  },
}

interface Pace {
  /** Travel this many times as slow as the direct model's straight lines. */
  readonly factor: number
  /** The dispatcher acts this long after each call or beat. */
  readonly reactS: number
}
const play = async (demo: Demo, policy: Policy, pace: Pace = { factor: 1, reactS: 0 }, untilS = endOf(demo.definition)): Promise<PlayLog> => await playDemo({
  definition: demo.definition,
  policy,
  untilS,
  reactS: pace.reactS,
  ...(pace.factor === 1 ? {} : { routing: slowedRouting(pace.factor) }),
})
const good = (demo: Demo): Policy => ({ kind: 'recommendations', beats: demo.beats })
/**
 * Production routes on town roads are unmeasured here: about twice as slow as
 * a straight line at the direct model's speed, so every play also runs at
 * twice and at two and a half times, with a dispatcher who reacts at once,
 * after 30 s and after 60 s, as a person at an iPad does.
 */
const paces: ReadonlyArray<Pace> = [
  ...[1, 2].flatMap(factor => [0, 30, 60].map(reactS => ({ factor, reactS }))),
  { factor: 2.5, reactS: 30 },
]
/** Every call's slack against a per-call objective is at least this in every play. */
const slackS = 3 * 60
/** A busy unit's first submit is refused when_required: the busy prompt it opens is the next click (plan B.3), never an order lost. */
const refusedOrders = (log: PlayLog) => log.orders.filter(order => !order.ok && order.code !== 'when_required')

const describeLog = (log: PlayLog): string => JSON.stringify({
  orders: log.orders.map(order => [order.atS, order.capabilityId, order.input, order.ok ? 'ok' : order.reason, order.clicks]),
  calls: log.calls.map(call => [call.label, call.createdS, call.firstOnSceneS, call.closedS]),
})

for (const demo of Object.values(demos)) {
  const { definition } = demo
  const config = configOf(definition)
  const items = definition.packs[0]!.items as unknown as ReadonlyArray<{ readonly type: string; readonly id: string; readonly label: string; readonly position: readonly [number, number]; readonly unitType?: string; readonly template?: string; readonly loads?: Record<string, number> }>
  const created = definition.timeline.cues.flatMap(cue => cue.actions.flatMap(action =>
    action.type === 'invoke_capability' && (action.capabilityId === ids.taskCreate || action.capabilityId === ids.unitCreate)
      ? [{ atS: cue.at.seconds, capabilityId: action.capabilityId, input: action.input as { readonly template?: string; readonly type?: string; readonly at: { readonly coordinates: readonly [number, number] }; readonly loads?: Record<string, number> } }]
      : []))
  const callTimes = [...items.filter(item => item.type === 'task').map(() => 0), ...created.filter(entry => entry.capabilityId === ids.taskCreate).map(entry => entry.atS)].sort((a, b) => a - b)

  describe(`${definition.id} as a demo`, () => {
    test('its title and description say what it is: fictional, without national markings, ending in a short How to play in the touch idiom', () => {
      expect(definition.title.length).toBeLessThanOrEqual(40)
      expect(definition.description).toMatch(/\bfictional\b/)
      const words = [
        definition.title, definition.description, ...definition.objectives, ...items.map(item => item.label),
        ...definition.timeline.cues.flatMap(cue => [cue.title, ...cue.actions.map(action => action.type === 'invoke_capability' ? (action.input as { readonly label?: string }).label ?? '' : action.type === 'show_guidance' ? action.guidance.message : '')]),
      ].join(' ')
      expect(words).not.toMatch(/Norw|Swed|Danish|NATO|Politi|Sykehus|\b11[023]\b|\b[RE]v ?\d|\bE ?\d{1,2}\b/)
      const [, howTo] = definition.description!.split('How to play: ')
      expect(howTo).toBeDefined()
      const sentences = howTo!.split(/(?<=\.) /)
      expect(sentences.length).toBeGreaterThanOrEqual(2)
      expect(sentences.length).toBeLessThanOrEqual(4)
      expect(howTo).toMatch(/\btap\b/)
      expect(definition.objectives.length).toBeGreaterThanOrEqual(2)
    })

    test('a call is waiting within a minute, calls keep coming until a few minutes before the end, and it ends between 25 and 35 minutes', () => {
      expect(callTimes[0]).toBeLessThanOrEqual(60)
      expect(callTimes.length).toBeGreaterThanOrEqual(12)
      expect(endOf(definition)).toBeGreaterThanOrEqual(25 * 60)
      expect(endOf(definition)).toBeLessThanOrEqual(35 * 60)
      expect(endOf(definition) - callTimes.at(-1)!).toBeLessThanOrEqual(3 * 60)
    })

    test('on a 1024 × 768 iPad in landscape every object stands in the map the Dispatch panel leaves clear at the starting fit, and units start a short drive from every call', () => {
      // The browser and World chrome take about 120 px of the screen's height; the Dispatch panel takes its width on the right.
      const surface = { width: 1024, height: 768 - 120 }
      const layout = panelLayoutFor(surface.width, surface.height)
      if (layout.mode !== 'docked') throw new Error('The Dispatch panel docks beside the map at 1024 px')
      const cover = dispatchMapCover(layout, { width: layout.widthPx, height: surface.height }, true)
      const zoom = startingZoomFor(definition.view.map.zoom, surface, cover)
      const worldPx = 512 * 2 ** zoom
      const project = ([lon, lat]: readonly [number, number]): [number, number] => [
        (lon + 180) / 360 * worldPx,
        (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * worldPx,
      ]
      const clearWidth = surface.width - cover.right
      const [centreX, centreY] = project(definition.view.map.center)
      const positions = [...items.map(item => item.position), ...created.map(entry => entry.input.at.coordinates)]
      for (const position of positions) {
        const [x, y] = project(position)
        const left = x - (centreX - clearWidth / 2)
        const top = y - (centreY - surface.height / 2)
        // An icon is 23 px; keep it whole and clear of the role bar and the status line.
        expect(Math.min(left, clearWidth - left)).toBeGreaterThanOrEqual(24)
        expect(Math.min(top - panelTopClearancePx, surface.height - panelBottomClearancePx - top)).toBeGreaterThanOrEqual(24)
      }
      const mobile = new Set(config.unitTypes.filter(type => type.components.mobility !== undefined).map(type => type.id))
      const starts = [...items.filter(item => item.type === 'unit' && mobile.has(item.unitType!)).map(item => item.position), ...created.filter(entry => entry.capabilityId === ids.unitCreate).map(entry => entry.input.at.coordinates)]
      const calls = [...items.filter(item => item.type === 'task').map(item => item.position), ...created.filter(entry => entry.capabilityId === ids.taskCreate).map(entry => entry.input.at.coordinates)]
      for (const call of calls) expect(Math.min(...starts.map(start => metresBetween(start, call)))).toBeLessThanOrEqual(3_000)
    })

    test('it is an open Run, its icons are catalogue symbols, and no call is one that only the Controller could close', async () => {
      for (const entry of [...config.unitTypes, ...config.taskTemplates]) expect(isMapSymbol(entry.icon)).toBe(true)
      const compiled = await compileScenarioDefinition(definition, [einsatzPack], { routing: createDirectRoutingAdapter() })
      expect(compiled.id).toBe(definition.id)
      // Open mode (plan C.5, decision 2): no role gate, so groups create no roles.
      expect([compiled.roles ?? [], compiled.rolePresets ?? []]).toEqual([[], []])
      // Every call needs a service, or holds load, or both: never a report, which only the Controller could close; and some unit serves each part.
      const tasks = [...items.filter(item => item.type === 'task').map(item => ({ template: item.template!, loads: item.loads })), ...created.filter(entry => entry.capabilityId === ids.taskCreate).map(entry => ({ template: entry.input.template!, loads: entry.input.loads }))]
      const typeOf = (id: string) => config.unitTypes.find(type => type.id === id)!
      const units = [...items.filter(item => item.type === 'unit').map(item => typeOf(item.unitType!)), ...created.filter(entry => entry.capabilityId === ids.unitCreate).map(entry => typeOf(entry.input.type!))]
      for (const task of tasks) {
        const template = config.taskTemplates.find(entry => entry.id === task.template)!
        const loads = Object.keys(task.loads ?? {}).filter(classId => (task.loads![classId] ?? 0) > 0)
        const unserved = [
          ...(template.requires.length === 0 && loads.length === 0 ? ['a report'] : []),
          ...template.requires.filter(requirement => !units.some(type => type.components.service?.provides.includes(requirement.provides) === true)).map(requirement => requirement.provides),
          ...loads.filter(classId => !units.some(type => type.components.carry?.classes.includes(classId) === true)),
        ]
        expect([task.template, unserved]).toEqual([task.template, []])
      }
    })

    for (const pace of paces) {
      test(`a good dispatcher at the panel meets every objective with travel ${pace.factor}× as slow, reacting after ${pace.reactS} s, with something to do every 3 minutes until the end, every suggestion taken in 2 clicks and no order refused`, async () => {
        const log = await play(demo, good(demo), pace)
        try {
          expect(demo.objectives(log), describeLog(log)).toEqual(demo.objectives(log).map(() => true))
          if (pace.factor <= 2) expect(demo.slack(log)).toBeGreaterThanOrEqual(slackS)
          expect(refusedOrders(log)).toEqual([])
          expect(new Set(log.orders.flatMap(order => order.beat === undefined ? [] : [order.beat]))).toEqual(new Set(demo.beats.map(beat => beat.name)))
          // A suggestion is the call's row and its Dispatch (B.11); a divert that row, then the busy unit's 4 clicks.
          expect(new Set(log.orders.filter(order => order.move === 'suggestion').map(order => order.clicks))).toEqual(new Set([2]))
          for (const order of log.orders.filter(entry => entry.move === 'divert')) expect(order.clicks).toBe(5)
          // Something to do at least every 3 minutes over the whole exercise: a new call, or an order the dispatcher gives.
          const moments = [...new Set([...log.calls.map(call => call.createdS), ...log.orders.map(order => order.atS), endOf(definition)])].sort((a, b) => a - b)
          expect(Math.max(...moments.slice(1).map((at, index) => at - moments[index]!))).toBeLessThanOrEqual(180)
        } finally {
          await log.run.close()
        }
      }, 120_000)
    }

    test('in a good play every call is served in the end: none is left for the Controller to close', async () => {
      const log = await play(demo, good(demo), { factor: 1, reactS: 0 }, endOf(definition) + 15 * 60)
      try {
        expect(log.calls.filter(call => call.closedS === undefined).map(call => call.label)).toEqual([])
        expect(refusedOrders(log)).toEqual([])
      } finally {
        await log.run.close()
      }
    }, 120_000)

    test('a dispatcher who does nothing fails an objective, and one who only takes the suggestions without the beat\'s move fails one too', async () => {
      for (const policy of [{ kind: 'nothing' } as const, { kind: 'recommendations', beats: [] } as const]) {
        const log = await play(demo, policy)
        try {
          expect([policy.kind, demo.objectives(log).every(Boolean)]).toEqual([policy.kind, false])
          expect(refusedOrders(log)).toEqual([])
        } finally {
          await log.run.close()
        }
      }
    }, 120_000)

    test('plays are deterministic: the same policy gives the same orders and the same call times', async () => {
      const [first, second] = [await play(demo, good(demo)), await play(demo, good(demo))]
      try {
        expect(describeLog(second)).toBe(describeLog(first))
      } finally {
        await first.run.close()
        await second.run.close()
      }
    }, 120_000)
  })
}

const stopsOf = (input: unknown): ReadonlyArray<Record<string, unknown>> => (input as { readonly stops: ReadonlyArray<Record<string, unknown>> }).stops
const whenOf = (input: unknown): string | undefined => (input as { readonly when?: string }).when
const unitsOf = (input: unknown): ReadonlyArray<string> => (input as { readonly units: ReadonlyArray<string> }).units

describe('halden-emergency pressure moments', () => {
  test('the good play reaches the chest pain before the ankle that arrives with it, diverts the unit on its way to the fallen tree to the fight, and gives the car fire to the engine on scene at the first fire after its current job in 4 clicks', async () => {
    const log = await play(demos.emergency, good(demos.emergency))
    try {
      // Two calls arrive together; the top-priority one is reached first.
      expect(cueAt(emergency, 'rodsberg-ankle')).toBe(cueAt(emergency, 'fortress-chest-pain'))
      const together = log.calls.filter(call => call.createdS === cueAt(emergency, 'fortress-chest-pain'))
      const ranks = configOf(emergency).priorities.map(entry => entry.id)
      const [first, later] = [...together].sort((a, b) => ranks.indexOf(a.priority) - ranks.indexOf(b.priority))
      expect(ranks.indexOf(first!.priority)).toBeLessThan(ranks.indexOf(later!.priority))
      expect(first!.firstOnSceneS!).toBeLessThan(later!.firstOnSceneS!)
      const [fireBeat] = demos.emergency.beats
      // No free unit can help at the fight: the dispatcher diverts the one on its way to the fallen tree, by the fight's row, the unit, its Dispatch, the fight, then "Now (drops …)" naming the tree, which the server checks.
      const fight = createdBy(log.calls, cueAt(emergency, 'torget-fight'))
      const tree = createdBy(log.calls, cueAt(emergency, 'tree-on-road'))
      const divert = log.orders.filter(order => order.move === 'divert' && stopsOf(order.input)[0]?.taskId === fight.id)
      expect(divert.map(order => [whenOf(order.input), (order.input as { readonly drops?: string }).drops, order.ok ? 'ok' : order.code, order.clicks])).toEqual([
        [undefined, undefined, 'when_required', 5],
        ['now', tree.id, 'ok', 5],
      ])
      // Within a step of the fight's arrival: the first free unit goes by the suggestion, the second by the divert.
      expect(divert[1]!.atS - fight.createdS).toBeLessThanOrEqual(5)
      // The car fire: the unit, its Dispatch, the car fire, then "After current job".
      const carFire = createdBy(log.calls, cueAt(emergency, 'harbour-car-fire'))
      const after = log.orders.filter(order => order.beat === fireBeat!.name)
      expect(after.map(order => [order.capabilityId, stopsOf(order.input), whenOf(order.input), order.ok ? 'ok' : order.code, order.clicks])).toEqual([
        [ids.order, [{ taskId: carFire.id }], undefined, 'when_required', 4],
        [ids.order, [{ taskId: carFire.id }], 'after', 'ok', 4],
      ])
      // The unit it was given to stood on scene at the first fire, then at the car fire.
      const unitId = unitsOf(after[1]!.input)[0]!
      expect(createdBy(log.calls, cueAt(emergency, 'guest-harbour-fire')).onScene.has(unitId)).toBe(true)
      expect(carFire.onScene.has(unitId)).toBe(true)
    } finally {
      await log.run.close()
    }
  }, 120_000)

  /**
   * How long the busy unit of an After current job beat still stands on
   * scene when the beat's call arrives, under a dispatcher who sent it at
   * once on straight lines (the shortest the beat gets) and on travel twice
   * as slow, as town roads make it.
   */
  const beatWindowsS = async (demo: Demo, atS: number, busyAt: (log: PlayLog) => string): Promise<ReadonlyArray<number>> => {
    const windows: number[] = []
    for (const factor of [1, 2]) {
      const log = await play(demo, { kind: 'recommendations', beats: [] }, { factor, reactS: 0 }, atS)
      try {
        const unitId = busyAt(log)
        expect(log.run.unit(unitId).phase).toBe('on-task')
        let leftS = 0
        while (log.run.unit(unitId).phase === 'on-task' && leftS < 900) {
          log.run.forward(5_000)
          await log.run.settle()
          leftS += 5
        }
        windows.push(leftS)
      } finally {
        await log.run.close()
      }
    }
    return windows
  }

  test('halden-emergency car fire: the engine at the first fire stays on scene a minute to two after the car fire arrives, time for the beat\'s 4 clicks', async () => {
    const atS = cueAt(emergency, 'harbour-car-fire')
    const windows = await beatWindowsS(demos.emergency, atS, log => [...createdBy(log.calls, cueAt(emergency, 'guest-harbour-fire')).onScene][0]!)
    expect(Math.min(...windows)).toBeGreaterThanOrEqual(60)
    // Not so long that the car fire's four minutes are out of reach behind it.
    expect(Math.min(...windows)).toBeLessThanOrEqual(120)
  }, 120_000)
})

describe('supply-run pressure moments', () => {
  test('the good play diverts a unit to the first urgent bulk request, gives the two side-by-side requests to one unit in one plan in 5 clicks, and the guest harbour to a busy unit after its current job in 4', async () => {
    const log = await play(demos.supply, good(demos.supply))
    try {
      const [chainBeat, homeBeat] = demos.supply.beats
      // No free unit can take the first urgent bulk request: the dispatcher diverts one on its way to a routine request.
      const bulk = createdBy(log.calls, cueAt(supply, 'pumping-station-bulk'))
      const divert = log.orders.filter(order => order.move === 'divert' && stopsOf(order.input)[0]?.taskId === bulk.id)
      expect(divert.map(order => [whenOf(order.input), order.ok ? 'ok' : order.code, order.clicks, order.atS])).toEqual([
        [undefined, 'when_required', 5, bulk.createdS],
        ['now', 'ok', 5, bulk.createdS],
      ])
      const chain = log.orders.filter(order => order.beat === chainBeat!.name)
      const pair = log.calls.filter(call => call.createdS === cueAt(supply, 'scout-camp-request')).map(call => call.id)
      expect(pair.length).toBe(2)
      expect(chain.map(order => [order.capabilityId, stopsOf(order.input), whenOf(order.input), order.ok, order.clicks])).toEqual([
        [ids.order, [{ taskId: pair[0]! }], undefined, true, 5],
        [ids.order, [{ taskId: pair[1]! }], 'after', true, 5],
      ])
      const unitId = unitsOf(chain[0]!.input)[0]!
      expect(unitsOf(chain[1]!.input)).toEqual([unitId])
      for (const call of log.calls.filter(entry => pair.includes(entry.id))) expect([...call.onScene]).toEqual([unitId])
      // The guest harbour goes to a busy unit after its current job, so the free heavy unit stays home.
      const harbour = createdBy(log.calls, cueAt(supply, 'harbour-request'))
      const home = log.orders.filter(order => order.beat === homeBeat!.name)
      expect(home.map(order => [stopsOf(order.input), whenOf(order.input), order.ok ? 'ok' : order.code, order.clicks])).toEqual([
        [[{ taskId: harbour.id }], undefined, 'when_required', 4],
        [[{ taskId: harbour.id }], 'after', 'ok', 4],
      ])
    } finally {
      await log.run.close()
    }
  }, 120_000)

  test('a dispatcher who sends the free heavy unit to the guest harbour instead, reacting after a minute, misses the last urgent bulk request', async () => {
    const [chainBeat, homeBeat] = demos.supply.beats
    const log = await play({ ...demos.supply, beats: [chainBeat!] }, { kind: 'recommendations', beats: [chainBeat!] }, { factor: 1, reactS: 60 })
    try {
      expect(log.orders.some(order => order.beat === homeBeat!.name)).toBe(false)
      expect(demos.supply.objectives(log)[0]).toBe(false)
      expect(waitedS(supply, createdBy(log.calls, cueAt(supply, 'community-centre-bulk')))).toBeGreaterThan(statedS(supply, 0, minutes))
    } finally {
      await log.run.close()
    }
  }, 120_000)

  test('the one moving type and the request icons are ones the operational atlas has never drawn: the openness the description claims', () => {
    const config = configOf(supply)
    const mobile = config.unitTypes.filter(type => type.components.mobility !== undefined)
    expect(mobile.length).toBe(1)
    for (const icon of [...mobile.map(type => type.icon), ...config.taskTemplates.map(template => template.icon)]) expect(Object.keys(atlas)).not.toContain(icon)
  })
})

describe('when the Dispatch panel reads the situation again', () => {
  test('on halden-emergency the screen\'s Einsatz records change with an order, a phase and a new call, never with movement alone', async () => {
    const run = await openRun({ definition: emergency })
    try {
      const key = () => einsatzRecordsKey(run.run.snapshot().objects)
      const answer = await run.query<RecommendAnswer>(einsatzQueryIds.recommend, { taskId: run.run.snapshot().objects.find(object => object.kind === 'incident')!.id })
      const unitId = answer.proposal!.units[0]!.unitId
      const before = key()
      expect((await run.invoke(ids.order, answer.proposal!.order)).ok).toBe(true)
      await run.settle()
      expect(key()).not.toBe(before)
      // Step until the unit is under way, then on: while it only moves, nothing the panel reads changed.
      while (run.unit(unitId).phase !== 'en-route') {
        run.forward(1_000)
        await run.settle()
      }
      const underWay = key()
      const at = lonLatOf(run.object(unitId)!)
      run.forward(5_000)
      await run.settle()
      expect([run.unit(unitId).phase, lonLatOf(run.object(unitId)!)]).not.toEqual(['en-route', at])
      expect(run.unit(unitId).phase).toBe('en-route')
      expect(key()).toBe(underWay)
      // The next cue's call is a new record.
      const calls = () => run.run.snapshot().objects.filter(object => object.kind === 'incident').length
      const held = calls()
      const quiet = key()
      while (calls() === held) {
        run.forward(5_000)
        await run.settle()
      }
      expect(key()).not.toBe(quiet)
    } finally {
      await run.close()
    }
  }, 120_000)
})

/**
 * Plan B.11, row by row, on halden-emergency at its start: each task is
 * done at the panel in exactly the clicks the plan states, and sends exactly
 * the order the clicks mean. A click is a map tap, a row tap, a card or
 * footer button or a map prompt option, whether it acts or not.
 */
describe('B.11 click counts at the Dispatch panel', () => {
  interface Scene {
    readonly run: OpenRun
    readonly screen: CardScreen
    readonly situation: Situation
    /** The call waiting at the start. */
    readonly callId: string
    readonly answer: RecommendAnswer
  }
  const scene = async (body: (scene: Scene) => Promise<void>): Promise<void> => {
    const run = await openRun({ definition: emergency, paused: true })
    try {
      const screen = await openCardScreen(run)
      const situation = screen.situation()
      const callId = situation.calls[0]!.id
      const answer = await run.query<RecommendAnswer>(einsatzQueryIds.recommend, { taskId: callId })
      await body({ run, screen, situation, callId, answer })
    } finally {
      await run.close()
    }
  }
  const sent = (screen: CardScreen) => screen.calls.map(call => [call.capabilityId, call.input, call.result.ok ? 'ok' : (call.result.code ?? call.result.reason)])
  /** A free carrier the start's recommendation did not propose: a unit the dispatcher chooses. */
  const chosenCarrier = (situation: Situation, answer: RecommendAnswer): string => {
    const proposed = new Set(answer.proposal?.units.map(unit => unit.unitId) ?? [])
    const unit = situation.units.find(entry => entry.carry !== null && entry.status.tone === 'free' && !proposed.has(entry.id))
    if (unit === undefined) throw new Error('halden-emergency has no second free carrier at the start')
    return unit.id
  }

  test('landing → a screen that can dispatch: the panel opens with the World surface, so the Host\'s two clicks (Try the dispatch demo, Start demo) are all it takes', () => {
    // The Host's two clicks are the Playwright smoke test's (plan F.1 V.6); inside World the panel is open by default and takes map targets.
    expect(einsatzPackView.ui.surfacePanels.map(panel => [panel.defaultOpen, panel.mapTargets])).toEqual([[true, true]])
  })

  test('see what is running: 0 clicks, the Overview lists every call and unit as the panel opens', async () => {
    await scene(async ({ screen, situation }) => {
      const lists = screen.lists()
      expect(screen.actions()).toBe(0)
      expect(lists.calls.rows.map(row => row.id)).toEqual(situation.calls.map(call => call.id))
      expect(lists.units.groups.flatMap(group => group.rows.map(row => row.id)).sort()).toEqual(situation.units.map(unit => unit.id).sort())
      expect(lists.counts).not.toBe('')
    })
  })

  test('dispatch the suggested unit: 2 clicks (the call, Dispatch), sending the suggestion\'s order unchanged', async () => {
    await scene(async ({ screen, callId, answer }) => {
      await screen.mapTap(callId)
      await screen.press({ kind: 'dispatch' })
      expect(screen.actions()).toBe(2)
      expect(sent(screen)).toEqual([[ids.order, answer.proposal!.order, 'ok']])
    })
  })

  test('a double-click on Dispatch sends the order once: the second click falls within the double-click interval and does nothing', async () => {
    await scene(async ({ screen, callId, answer }) => {
      await screen.mapTap(callId)
      await screen.press({ kind: 'dispatch' })
      await screen.press({ kind: 'dispatch' }, 120)
      expect(sent(screen)).toEqual([[ids.order, answer.proposal!.order, 'ok']])
    })
  })

  test('chosen free unit → call, unit first: 3 clicks (the unit, Dispatch…, the call)', async () => {
    await scene(async ({ screen, situation, callId, answer }) => {
      const unitId = chosenCarrier(situation, answer)
      await screen.mapTap(unitId)
      // A selected unit never sends anything by itself: a click to look is a look.
      expect(screen.calls).toEqual([])
      await screen.press({ kind: 'arm' })
      await screen.mapTap(callId)
      expect(screen.actions()).toBe(3)
      expect(sent(screen)).toEqual([[ids.order, { units: [unitId], stops: [{ taskId: callId }] }, 'ok']])
      expect(screen.selection()).toEqual({ kind: 'unit', unitId })
    })
  })

  test('chosen unit, call first: 2 clicks (the call, an offered alternative)', async () => {
    await scene(async ({ screen, callId, answer }) => {
      const alternative = answer.alternatives.flatMap(entry => entry.units)[0]
      if (alternative === undefined) throw new Error('The start call offers no alternative')
      await screen.mapTap(callId)
      await screen.press({ kind: 'alternative', unitId: alternative.unitId })
      expect(screen.actions()).toBe(2)
      expect(sent(screen)).toEqual([[ids.order, alternative.order, 'ok']])
    })
  })

  test('busy unit → call: 4 clicks (the unit, Dispatch…, the call, "After current job" on the busy prompt)', async () => {
    await scene(async ({ run, screen, callId, answer }) => {
      // Set up, not counted: the suggested unit takes the start call, and a second call of the same kind comes in nearby.
      const busyId = answer.proposal!.units[0]!.unitId
      expect((await run.invoke(ids.order, answer.proposal!.order)).ok).toBe(true)
      const start = run.task(callId)
      const position = lonLatOf(run.object(callId)!)
      expect((await run.invoke(ids.taskCreate, { template: start.template, label: 'C-9 Second call', at: { type: 'Point', coordinates: [position[0] + 0.003, position[1]] }, loads: start.loads })).ok).toBe(true)
      await screen.sync()
      const second = screen.situation().calls.find(call => call.label === 'C-9 Second call')!.id
      await screen.mapTap(busyId)
      await screen.press({ kind: 'arm' })
      await screen.mapTap(second)
      // Refused when_required: the busy prompt names the job "Now" would drop.
      expect(screen.prompt()).toEqual([expect.stringMatching(/^After current job/), expect.stringContaining(run.object(callId)!.label)])
      await screen.promptTap(0)
      expect(screen.actions()).toBe(4)
      expect(sent(screen)).toEqual([
        [ids.order, { units: [busyId], stops: [{ taskId: second }] }, 'when_required'],
        [ids.order, { units: [busyId], stops: [{ taskId: second }], when: 'after' }, 'ok'],
      ])
    })
  })

  test('pick up at A, deliver to chosen B, call first: 3 clicks (the call, Dispatch, a Deliver-to chip)', async () => {
    await scene(async ({ screen, callId, answer }) => {
      const carrier = answer.deliverTo[0]
      if (carrier === undefined) throw new Error('The start call\'s suggestion has no carrier to deliver')
      // The chosen site: the farthest offered, not the one the standing order would take.
      const site = carrier.sites.at(-1)!
      await screen.mapTap(callId)
      await screen.press({ kind: 'dispatch' })
      await screen.press({ kind: 'deliver-to', siteId: site.siteId })
      expect(screen.actions()).toBe(3)
      expect(sent(screen)).toEqual([
        [ids.order, answer.proposal!.order, 'ok'],
        [ids.order, { units: [carrier.unitId], stops: [{ siteId: site.siteId }], when: 'after' }, 'ok'],
      ])
    })
  })

  test('pick up at A, deliver to chosen B, unit first: 4 clicks (the unit, Dispatch…, the call, a Deliver-to chip)', async () => {
    await scene(async ({ screen, situation, callId, answer }) => {
      const unitId = chosenCarrier(situation, answer)
      const siteId = situation.sites.filter(site => site.accepting).at(-1)!.id
      await screen.mapTap(unitId)
      await screen.press({ kind: 'arm' })
      await screen.mapTap(callId)
      await screen.press({ kind: 'deliver-to', siteId })
      expect(screen.actions()).toBe(4)
      expect(sent(screen)).toEqual([
        [ids.order, { units: [unitId], stops: [{ taskId: callId }] }, 'ok'],
        [ids.order, { units: [unitId], stops: [{ siteId }], when: 'after' }, 'ok'],
      ])
    })
  })

  test('move a unit to a point: 4 clicks (the unit, Dispatch…, the ground, "Move here"); the ground tap alone moves nothing', async () => {
    await scene(async ({ run, screen, situation, answer }) => {
      const unitId = chosenCarrier(situation, answer)
      const [east, north] = lonLatOf(run.object(unitId)!)
      await screen.mapTap(unitId)
      await screen.press({ kind: 'arm' })
      await screen.groundTap([east + 0.004, north + 0.002])
      expect(screen.calls).toEqual([])
      expect(screen.prompt()).toEqual([expect.stringMatching(/ here$/)])
      await screen.promptTap(0)
      expect(screen.actions()).toBe(4)
      expect(sent(screen)).toEqual([[ids.order, { units: [unitId], stops: [{ point: { type: 'Point', coordinates: [east + 0.004, north + 0.002] } }] }, 'ok']])
    })
  })

  test('return a unit: 2 clicks (the unit, Return)', async () => {
    await scene(async ({ run, screen, answer }) => {
      const unitId = answer.proposal!.units[0]!.unitId
      expect((await run.invoke(ids.order, answer.proposal!.order)).ok).toBe(true)
      await screen.sync()
      await screen.mapTap(unitId)
      await screen.press({ kind: 'recall' })
      expect(screen.actions()).toBe(2)
      expect(sent(screen)).toEqual([[ids.recall, { unitId }, 'ok']])
    })
  })

  test('undo: 1 click (the receipt\'s Undo), taking back exactly the order it names', async () => {
    await scene(async ({ screen, callId, answer }) => {
      await screen.mapTap(callId)
      await screen.press({ kind: 'dispatch' })
      const order = screen.calls[0]!
      if (!order.result.ok) throw new Error('The suggestion was refused')
      screen.resetActions()
      await screen.press({ kind: 'receipt-undo' })
      expect(screen.actions()).toBe(1)
      expect(sent(screen).slice(1)).toEqual(answer.proposal!.order.units.map(unitId => [ids.undo, { unitId, commandId: order.result.commandId }, 'ok']))
    })
  })

  test('close an unserved call: 3 clicks (the call, Close, its Confirm beside it)', async () => {
    await scene(async ({ screen, callId }) => {
      await screen.mapTap(callId)
      await screen.press({ kind: 'close' })
      expect(screen.calls).toEqual([])
      await screen.press({ kind: 'confirm-close' })
      expect(screen.actions()).toBe(3)
      expect(sent(screen)).toEqual([[ids.taskClose, { taskId: callId }, 'ok']])
    })
  })

  test('walkthrough E1: the unit, then the call, then open ground sends no order; the call card opens, and the ground closes it', async () => {
    await scene(async ({ run, screen, situation, callId, answer }) => {
      const unitId = chosenCarrier(situation, answer)
      await screen.mapTap(unitId)
      await screen.mapTap(callId)
      expect(screen.selection()).toEqual({ kind: 'call', callId })
      expect(screen.mapSelection()).toBe(callId)
      const [east, north] = lonLatOf(run.object(callId)!)
      await screen.groundTap([east + 0.004, north + 0.002])
      expect(screen.selection()).toEqual({ kind: 'none', marked: null })
      expect(screen.mapSelection()).toBeNull()
      expect(screen.calls).toEqual([])
    })
  })

  test('walkthrough E2: a double-click on a unit keeps its card', async () => {
    await scene(async ({ screen, situation, answer }) => {
      const unitId = chosenCarrier(situation, answer)
      await screen.mapTap(unitId)
      await screen.mapTap(unitId, 120)
      expect(screen.selection()).toEqual({ kind: 'unit', unitId })
      expect(screen.calls).toEqual([])
    })
  })

  test('walkthrough E4: armed, a tap on the ground shows the Move prompt; a tap elsewhere dismisses it and asks again there; nothing moves without a confirm', async () => {
    await scene(async ({ run, screen, situation, answer }) => {
      const unitId = chosenCarrier(situation, answer)
      const [east, north] = lonLatOf(run.object(unitId)!)
      await screen.mapTap(unitId)
      await screen.press({ kind: 'arm' })
      await screen.groundTap([east + 0.004, north + 0.002])
      expect(screen.prompt()).toEqual([expect.stringMatching(/ here$/)])
      await screen.groundTap([east + 0.006, north + 0.003])
      expect(screen.selection()).toEqual({ kind: 'armed', unitId, when: null, prompt: { kind: 'move', point: geoPointFromLonLat(east + 0.006, north + 0.003) }, refusal: null })
      expect(screen.calls).toEqual([])
    })
  })

  test('the first click after the panel appears acts: a row tap at once opens the call\'s card', async () => {
    await scene(async ({ screen, callId }) => {
      await screen.row({ id: callId, kind: 'call' }, 0)
      expect(screen.selection()).toEqual({ kind: 'call', callId })
    })
  })

  test('the first click after a refresh acts: a new call and an order change the panel, and the next command still acts; only a double-click\'s second half is ignored', async () => {
    await scene(async ({ run, screen, callId, answer }) => {
      await screen.row({ id: callId, kind: 'call' })
      // Another actor's order and a new call re-lay the panel while its card is open.
      const other = answer.alternatives.flatMap(entry => entry.units)[0]!
      expect((await run.invoke(ids.order, other.order)).ok).toBe(true)
      const start = run.task(callId)
      const position = lonLatOf(run.object(callId)!)
      expect((await run.invoke(ids.taskCreate, { template: start.template, label: 'C-9 Second call', at: { type: 'Point', coordinates: [position[0] + 0.003, position[1]] }, loads: start.loads })).ok).toBe(true)
      screen.wait(800)
      await screen.sync()
      // A command 50 ms after that refresh acts: Close asks its confirm.
      await screen.press({ kind: 'close' }, 50)
      await screen.press({ kind: 'confirm-close' })
      expect(sent(screen)).toEqual([[ids.taskClose, { taskId: callId }, 'ok']])
    })
  })

  test('a double-click on Close never confirms: Close stays in its place, the confirm stands beside it', async () => {
    await scene(async ({ screen, callId }) => {
      await screen.mapTap(callId)
      await screen.press({ kind: 'close' })
      await screen.press({ kind: 'close' }, 120)
      expect(screen.calls).toEqual([])
      expect(screen.situation().calls.map(call => call.id)).toContain(callId)
    })
  })
})

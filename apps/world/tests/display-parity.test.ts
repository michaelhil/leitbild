import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Observable, Observation } from '../src/core/observation/model.ts'
import { scopeWithin } from '../src/features/displays/compose/topology.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { commandNotFollowed } from '../src/packs/process-plant/observation/derived.ts'
import { answerProcessPlantObservationQuery } from '../src/packs/process-plant/observation/query.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { validateOperatorWrite } from '../src/packs/process-plant/operations/command-guard.ts'
import type { ListedItem } from '../src/packs/process-plant/operations/instance-ports.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { observedInput, readingLook } from '../src/ui/embed/vignette/readout.ts'
import { observeListings } from './display-parity/listings.ts'
import { observeProposalFlow } from './display-parity/proposal-flow.ts'
import { askOf, CHIP_SIGNALS, PLANT_ID, plantIn, plantModel, REFERENCE_MIMICS, SIMULATION_TIME, STATES } from './display-parity/states.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T39 (swap plan): the plant swap's parity, deterministic and at the data level. Each fact the old display path gave,
// as T01 recorded it (tests/fixtures/display-characterization/old-path.json) and the faceplates' rows were recorded
// before their deletion (tests/fixtures/display-parity/faceplate-rows.json), read on the new path: the Plant's
// topology, observations and declarations, its controls and proposals. A difference holds only where it is listed
// here with its reason. P4 (procedure tags) and P9 (overview and equipment defaults) read a World Run: P4 in
// procedure-tag-default.test.ts, P9 in compose-plant-parity.test.ts; P6 is process-plant-proposal-characterization.

const record = await Bun.file(join(import.meta.dir, 'fixtures/display-characterization/old-path.json')).json()
// The state word the old path drew for each item, on the unit overview and on the detail around its component.
const itemWords = await Bun.file(join(import.meta.dir, 'fixtures/display-parity/item-words.json')).json() as {
  readonly states: Readonly<Record<string, { readonly overview: Readonly<Record<string, string>>; readonly details: Readonly<Record<string, string>> }>>
}
const faceplates = await Bun.file(join(import.meta.dir, 'fixtures/display-parity/faceplate-rows.json')).json() as {
  readonly ends: ReadonlyArray<{ readonly end: string; readonly values: ReadonlyArray<string>; readonly flows: ReadonlyArray<string>; readonly loops: ReadonlyArray<string>; readonly protection: ReadonlyArray<string>; readonly safetyFunctions: ReadonlyArray<string>; readonly programs: boolean }>
}
const declaration = plantDeclaration(PLANT_ID as never, plantModel(), null)
const declared = new Map(declaration.observables.map(observable => [observable.ref, observable]))
const ref = (path: string): string => `${PLANT_ID}#${path}`
const READ_AT_ONCE = 64
const read = (instance: ProcessPlantRuntimeInstance, refs: ReadonlyArray<string>): ReadonlyMap<string, Observation> => new Map(Array.from({ length: Math.ceil(refs.length / READ_AT_ONCE) }, (_, at) => refs.slice(at * READ_AT_ONCE, (at + 1) * READ_AT_ONCE))
  .flatMap(chunk => (answerProcessPlantObservationQuery({
    request: { capabilityId: 'world.process-plant.observation.read', input: { refs: chunk } }, plants: new Map([[PLANT_ID, instance]]), simulationTime: SIMULATION_TIME, recording: null,
  }) as { readonly observations: ReadonlyArray<Observation> }).observations).map(observation => [observation.ref, observation]))

/**
 * Listed differences in what an item's state reads (P1, P1b): the new path says the state in its controls' words (the
 * drawing's popover header said the aspect's word: running, energized), and a valve between its ends reads "part
 * open", its opening on its position binding. The command it does not follow is the reading's why, in those words.
 */
const STATE_WORDS: Readonly<Record<string, string>> = { running: 'RUN', stopped: 'STOP', energized: 'LIVE', dead: 'DEAD' }
const stateWord = (old: string, labels: ReadonlyArray<string>): string => {
  const word = old.split(';')[0]!.trim()
  if (/^\d+ % open$/.test(word)) return 'part open'
  if (word === 'closed' && labels.includes('SHUT')) return 'SHUT'
  return STATE_WORDS[word] ?? word.toUpperCase()
}
/** The command the old word said the item does not follow ("stopped; commanded to run", "35 % open; commanded shut disagrees"), in the new words. */
const commandedWord = (old: string): string | null => {
  const commanded = old.match(/commanded (?:to )?(\w+)/)?.[1]
  return commanded === undefined ? null : commandNotFollowed(STATE_WORDS[commanded === 'run' ? 'running' : commanded === 'stop' ? 'stopped' : commanded] ?? commanded.toUpperCase())
}
/** What the old drawing wrote for an item that is a value, not a state (a level, what passes a header), or nothing: no state word to keep. */
const VALUE_WORDS = /^(level |carrying flow$|no flow$|no state drawn$)/
/**
 * Listed: an accumulator's check valve, which the old drawing judged by a flow value it did not have ("position not
 * measured; no flow value"), reads the opening the model solves for it. Its discharge isolation valve, whose position
 * the model does not solve, still reads "position not measured".
 */
const NOW_MEASURED = /\.checkValve$/
// The immutable old drawing captured the former common RHR header/valve.
// Source transfer deliberately replaces those two subjects with independently
// tested per-train paths; compare historical words only for surviving items.
const RETIRED_RHR_ITEMS = new Set(['rhrHeader', 'rhrIsolationValve'])

/** controls.list's items as T01 recorded them. */
const listedFacts = (items: ReadonlyArray<any>) => items.map(item => ({
  id: item.id,
  offered: (item.offered as ReadonlyArray<any>).map(listed => ({
    tagId: listed.control?.tagId ?? null,
    form: listed.control?.form ?? null,
    now: listed.now ?? null,
    throttledUnder: (listed.throttledUnder ?? []).map((rule: { label: string }) => rule.label),
    options: ((listed.control?.options ?? []) as ReadonlyArray<any>).map((option, index) => ({
      word: option.word,
      consequences: (option.consequences ?? []).map((rule: { label: string }) => rule.label),
      heldBy: listed.standing?.[index]?.heldBy?.label ?? null,
    })),
  })),
  withheld: item.withheld ?? [],
}))

/** Listed P1 difference: this existing valve now has explicit AUTO/MAN and a
 * target. T01 remains immutable; every other historical action stays exact.
 * Its newly exposed numeric position/demand must read the native variables,
 * while P1/P1b still compare the physical state words to T01 independently. */
const withBypassController = (items: ReadonlyArray<any>, instance: ProcessPlantRuntimeInstance) => items.map(item => {
  if (item.id !== 'turbineBypassValve') return item
  const automatic = item.withheld.find((control: any) => control.path === 'turbineBypassValve.positionFraction')
  expect(automatic).toEqual({ path: 'turbineBypassValve.positionFraction', tagId: 'TURB-BYP', reason: {
    kind: 'automatic', measured: 'main-steam-header-to-turbine-bypass-valve.pressureMPa', setpoint: 7.6,
    text: 'AUTO · Turbine bypass valve inlet pressure held to 7.6 MPa',
    manual: 'Manual operation needs an AUTO/MAN mode the model does not have: its controller writes this demand every step',
  } })
  expect(item.offered).toEqual([])
  const option = (word: string) => ({ word, consequences: [], heldBy: null })
  const common = { throttledUnder: [] }
  return { ...item, offered: [
    { ...common, tagId: 'TURB-BYP', form: 'demand', now: {
      demand: instance.runtime.readVariable('turbineBypassValve.positionFraction' as VariablePath),
      position: instance.runtime.readVariable('turbineBypassValve.effectivePositionFraction' as VariablePath),
    }, options: [option('OPEN'), option('SHUT')] },
    { ...common, tagId: 'TURB-BYP-AUTO', form: 'twoState', now: null, options: [option('AUTO'), option('MAN')] },
    { ...common, tagId: 'TURB-BYP-SP', form: 'setpoint', now: null, options: [] },
  ], withheld: [
    ...item.withheld.filter((control: any) => control !== automatic),
    { ...automatic, reason: { ...automatic.reason,
      text: automatic.reason.text.replace('held to', 'target'),
      manual: 'Select MAN to operate the valve position; protection and isolation remain in force',
    } },
  ] }
})

/** Independent authored expectations for this reference model, not regenerated
 * output of derivePlantControls. Process duty (relief) does not remove an
 * explicitly enabled controller's MAN position; safety valves remain absent. */
const CONTROLLER_AFFORDANCES = [
  ...['A', 'B', 'C', 'D'].map(loop => ({ id: `feedwaterControlValve${loop}`, positionTag: `MFW-${loop}-CV`, modeTag: `MFW-${loop}-CTRL-AUTO`, targetTag: `MFW-${loop}-CTRL-SP`, target: 55, unit: 'percent', quantity: 'ratio' })),
  ...['A', 'B', 'C', 'D'].map(loop => ({ id: `steamGeneratorReliefValve${loop}`, positionTag: `SG-${loop}-ARV`, modeTag: `SG-${loop}-ARV-AUTO`, targetTag: `SG-${loop}-ARV-SP`, target: 7.86, unit: 'MPa', quantity: 'pressure' })),
  { id: 'turbineBypassValve', positionTag: 'TURB-BYP', modeTag: 'TURB-BYP-AUTO', targetTag: 'TURB-BYP-SP', target: 7.6, unit: 'MPa', quantity: 'pressure' },
]
const ISOLATED_MFW = ['A', 'B', 'C', 'D'].map(loop => `feedwaterControlValve${loop}`)
const MAN_POSITION_BLOCKED: Readonly<Record<string, ReadonlyArray<string>>> = {
  steady: [],
  'loss-main-feedwater+120s': ISOLATED_MFW,
  'loss-offsite-power+60s': [...ISOLATED_MFW, 'turbineBypassValve'],
  'porv-open-35+120s': [],
}

const topology = servedPlantTopology(PLANT_ID as never, plantModel())

describe('T39 plant swap parity', () => {
  for (const state of STATES) {
    describe(state.id, () => {
      const instance = plantIn(state)
      const ask = askOf(instance)
      const recorded = record.states[state.id]

      test('P1: each reference drawing draws the same equipment; each item offers the same actions; each operated item says its state', () => {
        REFERENCE_MIMICS.forEach((mimic, index) => {
          const old = recorded.elementActions[index] as { readonly drawn: ReadonlyArray<string>; readonly items: ReadonlyArray<unknown> }
          const scoped = scopeWithin(topology, { around: mimic.around, from: mimic.from, to: mimic.to, media: mimic.services })
          if (!scoped.ok) throw new Error(`${JSON.stringify(mimic)}: ${scoped.reason}`)
          const ids = old.drawn.map(entry => entry.slice(0, entry.indexOf(':')))
          expect([...scoped.scoped.nodes].sort()).toEqual([...ids].sort())
          // What the element pop-over's actions list for each drawn item (controls.list, by node id).
          expect(listedFacts(ask<{ readonly items: ReadonlyArray<any> }>('world.process-plant.controls.list', { plantId: PLANT_ID, items: ids }).items)).toEqual(withBypassController(old.items, instance))
          // An operated item's state observable reads what the drawing's word said, in its controls' words, with the command it does not follow.
          const states = ids.filter(id => declared.has(ref(`${id}.state`)))
          const observed = read(instance, states.map(id => ref(`${id}.state`)))
          for (const entry of old.drawn) {
            const id = entry.slice(0, entry.indexOf(':'))
            if (!states.includes(id)) continue
            const observable = declared.get(ref(`${id}.state`))!
            const observation = observed.get(ref(`${id}.state`))!
            const labels = observable.states!.map(stated => stated.label)
            const word = entry.slice(entry.indexOf(':') + 1)
            expect([id, observable.states!.find(stated => stated.value === observation.value)?.label]).toEqual([id, stateWord(word, labels)])
            expect([id, observation.why ?? null]).toEqual([id, commandedWord(word)])
          }
        })
      })

      test('P1c: all authored controller affordances expose real current authority without changing the recorded physical state', () => {
        // The historical P1/P1b/P2/P3 instance is never mutated by these operator actions.
        const operated = plantIn(state)
        const protection = operated.protection
        if (protection === undefined) throw new Error('Characterization states require their actual I&C runner')
        const numberAt = (path: VariablePath): number => {
          const value = operated.runtime.readVariable(path)
          if (typeof value !== 'number') throw new Error(`Expected native numeric feedback: ${path}`)
          return value
        }
        const query = askOf(operated)
        const items = query<{ readonly items: ReadonlyArray<ListedItem> }>('world.process-plant.controls.list', { plantId: PLANT_ID }).items
        expect(items.flatMap(item => item.offered.filter(control => control.control.form === 'setpoint').map(() => item.id)).sort()).toEqual(CONTROLLER_AFFORDANCES.map(controller => controller.id).sort())
        for (const expected of CONTROLLER_AFFORDANCES) {
          const item = items.find(item => item.id === expected.id)!
          const position = item.offered.find(control => control.control.tagId === expected.positionTag)!
          const mode = item.offered.find(control => control.control.tagId === expected.modeTag)!
          const target = item.offered.find(control => control.control.tagId === expected.targetTag)!
          expect(position.control).toMatchObject({ path: `${expected.id}.positionFraction`, state: `${expected.id}.effectivePositionFraction`, form: 'demand',
            demand: { min: 0, max: 1, step: 0.01, unit: 'fraction' },
            controller: { automatic: `${expected.id}.controllerAutomatic`, setpoint: `${expected.id}.controllerSetpoint` } })
          expect(position.now).toEqual({ demand: numberAt(position.control.path), position: numberAt(position.control.state!) })
          expect(position.unavailable).toContain('Select MAN')
          expect(mode.control).toMatchObject({ path: `${expected.id}.controllerAutomatic`, form: 'twoState', options: [{ word: 'AUTO', value: true }, { word: 'MAN', value: false }] })
          expect(target.control).toMatchObject({ path: `${expected.id}.controllerSetpoint`, form: 'setpoint', setpoint: { quantity: expected.quantity, unit: expected.unit } })
          expect(operated.runtime.readVariable(mode.control.path)).toBe(true)
          expect(operated.runtime.readVariable(target.control.path)).toBe(expected.target)
          for (const origin of ['person', 'ai'] as const) {
            const validate = (path: VariablePath, value: number | boolean) => validateOperatorWrite({ system: operated.plant, runtime: operated.runtime, protection, origin, payload: { plantId: PLANT_ID, path, value } })
            expect(validate(position.control.path, 0.4)).toMatchObject({ accepted: false, reason: expect.stringContaining('select MAN') })
            expect(validate(mode.control.path, false).accepted).toBe(true)
            expect(validate(target.control.path, expected.target).accepted).toBe(true)
          }
          operated.runtime.writeCommand({ type: 'setVariable', path: mode.control.path, value: false })
        }
        operated.runtime.tick(1_000)
        protection.evaluate({ runtime: operated.runtime, elapsedMs: operated.runtime.elapsedMs(), simulationRunId: 'run-characterization' as never, sourceRuntimeId: 'process-plant.local' })
        for (const expected of CONTROLLER_AFFORDANCES) {
          const manual = query<{ readonly items: ReadonlyArray<ListedItem> }>('world.process-plant.controls.list', { plantId: PLANT_ID, items: [expected.id] }).items[0]!
          const position = manual.offered.find(control => control.control.tagId === expected.positionTag)!
          const mode = manual.offered.find(control => control.control.tagId === expected.modeTag)!
          expect(operated.runtime.readVariable(mode.control.path)).toBe(false)
          for (const origin of ['person', 'ai'] as const) {
            const validation = validateOperatorWrite({ system: operated.plant, runtime: operated.runtime, protection, origin,
              payload: { plantId: PLANT_ID, path: position.control.path, value: 0.4 } })
            expect(validation.accepted).toBe(!MAN_POSITION_BLOCKED[state.id]!.includes(expected.id))
          }
          expect(manual.offered.find(control => control.control.path === position.control.path)?.unavailable).toBeUndefined()
          expect(manual.position?.value).toBe(numberAt(position.control.state!))
        }
        expect(items.filter(item => /safetyValve|safety-valve/i.test(item.id)).flatMap(item => item.offered)).toEqual([])
      })

      test('P1b: each item the overview and the details drew with a state word declares its state in that word, the command it does not follow as its why, bound on its node', () => {
        const words = itemWords.states[state.id]!
        const worded = Object.entries({ ...words.details, ...words.overview }).filter(([id, word]) => !RETIRED_RHR_ITEMS.has(id) && !VALUE_WORDS.test(word))
        expect(worded.filter(([id]) => !declared.has(ref(`${id}.state`))).map(([id]) => id)).toEqual([])
        const observed = read(instance, worded.map(([id]) => ref(`${id}.state`)))
        const reads = (id: string): string => {
          const observable = declared.get(ref(`${id}.state`))!
          const observation = observed.get(ref(`${id}.state`))!
          const word = observation.quality === 'not-applicable' ? '?' : observable.states!.find(stated => stated.value === observation.value)?.label ?? `unread ${String(observation.value)}`
          return observation.why === undefined ? word : `${word} (${observation.why})`
        }
        const expected = (id: string, old: string): string => {
          if (old.startsWith('position not measured')) return NOW_MEASURED.test(id) ? reads(id) : '? (position not measured)'
          const word = stateWord(old, declared.get(ref(`${id}.state`))!.states!.map(stated => stated.label))
          const commanded = commandedWord(old)
          return commanded === null ? word : `${word} (${commanded})`
        }
        expect(worded.map(([id]) => [id, reads(id)])).toEqual(worded.map(([id, old]) => [id, expected(id, old)]))
        // Each drawn item runs or conducts on its state observable, so a drawing writes its word and why.
        const nodes = new Map(topology.nodes.map(node => [node.id, node]))
        expect(worded.flatMap(([id]) => nodes.get(id) === undefined || nodes.get(id)!.bindings.some(binding => (binding.role === 'running' || binding.role === 'conducting') && binding.ref === ref(`${id}.state`)) ? [] : [id])).toEqual([])
      })

      test('P2: the latched actuations and their resets read the same, each reached from an item it holds', () => {
        const listed = ask<{ readonly resets: ReadonlyArray<any> }>('world.process-plant.controls.list', { plantId: PLANT_ID }).resets
        // Listed difference: an actuation whose declared operating-mode scope
        // has ended can be reset even if its numerical condition persists.
        // T01 remains immutable; non-mode-scoped AFW holds must still refuse.
        const released = state.id === 'loss-main-feedwater+120s' ? new Set([
          ...['a', 'b', 'c', 'd'].map(loop => `sg-${loop}-level-low-low-reactor-trip`),
          'main-feedwater-pumps-tripped-afw-start',
        ]) : new Set<string>()
        const expected = recorded.resets.map((reset: { ruleId: string; label: string }) => released.has(reset.ruleId)
          ? { ruleId: reset.ruleId, label: reset.label, offered: true } : reset)
        expect(listed.map(reset => ({ ruleId: reset.ruleId, label: reset.label, offered: reset.offered, ...(reset.reason === undefined ? {} : { reason: reset.reason }) }))).toEqual(expected)
        // Listed difference: a reset is offered in the element panel of an item it holds; one that holds no item is offered on none.
        expect(listed.filter(reset => reset.items.length === 0).map(reset => reset.ruleId)).toEqual([...UNREACHED_RESETS[state.id] ?? []])
      })

      test('P3: each reference value names the same limit it is past, and what the I&C does there', () => {
        const graph = instance.plant.graph
        const paths = CHIP_SIGNALS.map(tag => String(graph.signalBindingByTagId.get(tag as never)!.path))
        const observed = read(instance, paths.map(ref))
        const chips = Object.fromEntries(CHIP_SIGNALS.map((tag, index) => {
          const observable: Observable = declared.get(ref(paths[index]!))!
          const observation = observed.get(ref(paths[index]!))
          const chip = readingLook(observable.label, observable.valueType, observable.states, observedInput(observable, observation)).chip
          const passed = observable.thresholds.find(threshold => threshold.id === observation?.past)
          return [tag, chip === null ? null : `${chip.word}${passed?.consequence === undefined ? '' : ` · ${passed.consequence}`}`]
        }))
        expect(chips).toEqual({ ...recorded.chips, ...CHIP_DIFFERENCES[state.id] })
      })
    })
  }

  test('P5: a proposal end to end at the Capability boundary, its cited reading with its margin', async () => {
    const { citedMargins, ...flow } = await observeProposalFlow()
    expect(flow).toEqual(record.proposalFlow)
    expect(citedMargins).toEqual(['N % above LO N % · ALM'])
  })

  test('P7: every faceplate row is declared: values and loops as observables, protection as limits with what the I&C does, functions as CSFs, programs as their values', () => {
    const missing = faceplates.ends.flatMap(end => [...end.values, ...end.flows, ...end.loops].filter(path => !declared.has(ref(path))).map(path => `${end.end}: ${path}`))
    expect(missing).toEqual([])
    const limited = new Set(declaration.observables.flatMap(observable => observable.thresholds.filter(threshold => threshold.consequence !== undefined).map(threshold => threshold.id.split('#')[0]!)))
    expect(faceplates.ends.flatMap(end => end.protection.filter(rule => !limited.has(rule)).map(rule => `${end.end}: ${rule}`))).toEqual([...UNLIMITED_RULES])
    expect(faceplates.ends.flatMap(end => end.safetyFunctions.filter(id => !declared.has(ref(`csf.${id}`))))).toEqual([])
    // A loop's readings group by their loop: each declared element of the loop's lines and equipment names its loop.
    const groups = new Map(declaration.elements.map(element => [element.id, element.group]))
    expect(faceplates.ends.flatMap(end => end.loops.filter(path => groups.get(declared.get(ref(path))!.element!) === undefined))).toEqual([])
    // The core's programs (Tavg to Tref): the program and its reading are declared values.
    const programs = plantModel().graph.components.flatMap(component => component.semantics.programs.flatMap(program => [program.reading, program.program, ...(program.deviation === undefined ? [] : [program.deviation])]))
    expect(faceplates.ends.some(end => end.programs)).toBe(true)
    expect(programs.filter(path => !declared.has(ref(String(path))))).toEqual([])
  })

  test('P8: the window opens a vignette listing, refuses one of another view type with its reason, and the rest as before', () => {
    expect(observeListings()).toEqual(LISTINGS)
  })
})

/** Resets that hold no item an element panel shows (P2): none in the recorded states. */
const UNREACHED_RESETS: Readonly<Record<string, ReadonlyArray<string>>> = {}

/** Listed chip differences (P3), by state: none. */
const CHIP_DIFFERENCES: Readonly<Record<string, Record<string, string | null>>> = {}

/**
 * Protection rules a faceplate listed that set no limit on a value (P7), listed: each acts on a state or a press, not
 * on a reading past a limit (a coolant pump's breaker opening, a manual trip, a turbine trip's cascade, the loss of
 * load). Each still shows as its alarm or trip in the unit's alert slot when it acts, and a manual trip or SI is a
 * pushbutton in the element panel of the equipment it acts on.
 */
const UNLIMITED_RULES: ReadonlyArray<string> = [
  'core: reactor-rcp-breaker-open-trip', 'core: reactor-manual-trip', 'core: safety-injection-manual', 'core: reactor-trip-turbine-trip',
  'turbine: reactor-trip-turbine-trip', 'turbine: turbine-trip-on-loss-of-load', 'turbine: turbine-manual-trip',
]

/**
 * P8: the listings the window opens, as T01 recorded them, with a vignette where the process display was. Listed: the
 * old path's process display, deleted at the swap, now opens to say this window does not show it.
 */
const { 'a process display about a Run of this Workspace': processDisplay, ...unchanged } = record.listings
const LISTINGS = {
  ...unchanged,
  'a vignette about a Run of this Workspace': processDisplay,
  'a process display of the old path': { opens: true, shown: false, reason: 'it is a process-plant.display view, which this window does not show' },
}

/**
 * Differences the lead ruled accepted (D3), held by the tests named: the old drawing's symbol badges (a pending
 * proposal's mark on its item) are gone with the drawing they sat on, so a proposal reaches its item through the
 * window's chip and the element pop-over carries its card (process-plant-proposal-characterization); the chip lists
 * each pending proposal as "<action> · expires hh:mm:ss" (operation-presenter); and the old composed view, unoperated
 * from D2 until its deletion here, is gone.
 */

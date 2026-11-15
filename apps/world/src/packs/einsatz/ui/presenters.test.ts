import { describe, expect, test } from 'bun:test'
import { objectIdSchema, type OperationalObject } from '../../../core/model/index.ts'
import { mapTargetingMaxTargets } from '../../../ui/surface-panel-interaction.ts'
import { einsatzPackId } from '../ids.ts'
import { recommendAnswerSchema, type RecommendAnswer } from '../recommendation-schema.ts'
import { situationSchema, unitOptionsSchema, type Situation, type UnitOptions } from '../situation/schema.ts'
import {
  busyPrompt,
  callCard,
  cardFor,
  clockText,
  closedCallCard,
  contactRows,
  countsLine,
  deliverToOrder,
  dispatchKindOf,
  dispatchWords,
  edgeTabText,
  emptySelectionText,
  maxReceipts,
  movePromptText,
  overview,
  ownReceipt,
  proposalInvalidation,
  receiptsFromSituation,
  receiptUndoable,
  receiptUndoMs,
  siteCard,
  targetingFor,
  unitCard,
  withReceipts,
  type PinnedProposal,
} from './presenters.ts'
import type { Selection } from './selection.ts'

/**
 * The Dispatch panel's view models over a situation written in words no
 * code knows: a "Rover" that carries "crates" to a "Depot", a "Kite" that
 * surveys. Every word the views show comes from the situation.
 */

const oid = (id: string) => objectIdSchema.parse(id)
const viewer = { label: 'Desk', isViewer: true }
const assistant = { label: 'Assistant', isViewer: false }
const routed = (seconds: number) => ({ kind: 'routed' as const, seconds, distanceM: seconds * 10 })
const words = { calls: 'Jobs', units: 'Crews', sites: 'Depots', send: 'Task', return: 'Home', move: 'Shift', close: 'Drop job', plan: 'Route', stop: 'Leg', noCalls: 'No jobs', noUnits: 'No crews' }
const priority = (rank: number, extra: object = {}) => ({ id: `q${rank}`, label: `Level ${rank}`, code: `Q${rank}`, rank, ...extra })

const unit = (id: string, extra: object = {}) => ({
  id,
  label: id.toUpperCase(),
  icon: 'cog',
  typeLabel: 'Rover',
  group: { id: 'north', label: 'North crews' },
  status: { word: 'Idle', tone: 'free' },
  phase: 'available',
  phaseDueInS: null,
  plan: [],
  predictedDelivery: null,
  lastOrder: null,
  carry: { capacity: 2, load: [] },
  properties: [{ id: 'range', label: 'Range', value: '40 km' }],
  commandedBy: null,
  states: [],
  ...extra,
})

const baseSituation = {
  counts: { calls: [{ priorityId: 'q0', code: 'Q0', count: 1 }, { priorityId: 'q1', code: 'Q1', count: 1 }, { priorityId: 'q2', code: 'Q2', count: 0 }], oldestWaitingS: 250, freeUnits: 2, units: 3, acceptingSites: 1, sites: 2 },
  calls: [
    {
      id: 'job-1', label: 'J-1 Ridge', icon: 'flag', templateLabel: 'Pickup', priority: priority(0, { responseTargetS: 600 }), waitingS: 250, overdue: false,
      needs: [{ kind: 'load', classId: 'crate', code: 'C', label: '2 crates', waiting: 2, covered: 0 }, { kind: 'requirement', provides: 'survey', label: '1 kite', where: ['Camera = yes'], count: 1, enRoute: 0, onTask: 0, completed: 0 }],
      assigned: [], states: [],
    },
    {
      id: 'job-2', label: 'J-2 Bay', icon: 'flag', templateLabel: 'Pickup', priority: priority(1), waitingS: 60,
      needs: [{ kind: 'load', classId: 'crate', code: 'C', label: '1 crate', waiting: 1, covered: 1 }],
      assigned: [{ unitId: 'r2', label: 'R2', phase: 'en-route', status: { word: 'Moving', tone: 'busy' }, eta: routed(180), by: assistant }],
      states: [{ code: 'no_free_unit', text: 'No free crew can serve' }],
    },
  ],
  units: [
    unit('r1'),
    unit('r2', {
      status: { word: 'Moving', tone: 'busy' }, phase: 'en-route',
      plan: [{ id: 'leg-1', verb: 'pick-up', target: { taskId: 'job-2' }, label: 'J-2 Bay', state: 'active', eta: routed(180), by: assistant }],
      predictedDelivery: { siteId: 'depot-a', label: 'Depot A', eta: routed(360) },
      lastOrder: { by: assistant, commandId: 'cmd-7' },
    }),
    unit('k1', { typeLabel: 'Kite', group: null, carry: null, properties: [] }),
  ],
  sites: [
    { id: 'depot-a', label: 'Depot A', icon: 'warehouse', typeLabel: 'Depot', accepting: true, slots: { used: 1, total: 2 }, inbound: [{ unitId: 'r2', label: 'R2', eta: routed(360) }], states: [] },
    { id: 'depot-b', label: 'Depot B', icon: 'warehouse', typeLabel: 'Depot', accepting: false, slots: { used: 0, total: 1 }, inbound: [], states: [] },
  ],
  words,
  features: { hasCarry: true, hasSites: true, hasContacts: false, propertyColumns: [{ id: 'range', label: 'Range' }] },
}

const situationOf = (patch: object = {}): Situation => situationSchema.parse({ ...baseSituation, ...patch })
const situation = situationOf()
const none: Selection = { kind: 'none', marked: null }
const su = (unitId: string): Selection => ({ kind: 'unit', unitId })
const sa = (unitId: string, extra: object = {}): Selection => ({ kind: 'armed', unitId, when: null, prompt: null, refusal: null, ...extra })
const opened = new Set<string>()

const optionsFor = (unitId: string, extra: object = {}): UnitOptions => unitOptionsSchema.parse({
  unitId,
  busy: null,
  targets: [
    { target: { taskId: 'job-1' }, verb: 'pick-up', label: 'J-1 Ridge', etaS: 240 },
    { target: { siteId: 'depot-a' }, verb: 'go-to', label: 'Depot A', etaS: 400 },
    { target: { point: { type: 'Point', coordinates: [11, 59] } }, verb: 'go-to', label: 'the map point', etaS: 60 },
  ],
  refused: [{ target: { siteId: 'depot-b' }, label: 'Depot B', code: 'site_not_accepting', text: 'Depot B is closed for arrivals' }],
  ...extra,
})

const answer = (extra: object = {}): RecommendAnswer => recommendAnswerSchema.parse({
  taskId: 'job-1',
  priority: priority(0),
  proposal: {
    order: { units: ['r1', 'k1'], stops: [{ taskId: 'job-1' }] },
    units: [{ unitId: 'r1', label: 'R1', eta: routed(240) }, { unitId: 'k1', label: 'K1', eta: routed(360) }],
    covers: { covered: 2, needed: 3 },
    remainder: ['1 crate'],
  },
  alternatives: [{ need: { kind: 'load', id: 'crate', label: 'crates' }, units: [{ unitId: 'r3', label: 'R3', eta: routed(540), order: { units: ['r3'], stops: [{ taskId: 'job-1' }] } }] }],
  whyNot: [{ unitId: 'r2', label: 'R2', reasons: ['busy on J-2 Bay'] }],
  deliverTo: [{ unitId: 'r1', label: 'R1', sites: [{ siteId: 'depot-a', label: 'Depot A', eta: routed(300) }] }],
  ...extra,
})
const pinnedOf = (extra: Partial<PinnedProposal> = {}): PinnedProposal => ({ callId: 'job-1', answer: answer(), dropped: new Set(), ...extra })

describe('Unit card', () => {
  test('a free unit: title, status, the Dispatch verb from the lexicon, fixed buttons disabled with a reason', () => {
    const card = unitCard(situation, situation.units[0]!, su('r1'), null, 0)
    expect(card.title).toBe('R1 · Rover · North crews')
    expect(card.status).toEqual({ word: 'Idle', tone: 'free', due: null })
    expect(card.dispatch).toEqual({ label: 'Task R1…', enabled: true, reason: null })
    expect(card.recall).toEqual({ label: 'Home', enabled: true, reason: null })
    expect(card.undo).toEqual({ label: dispatchWords.undoLast, enabled: false, reason: dispatchWords.nothingToUndo, commandId: null })
    expect(card.addStop).toBeNull()
    expect(card.facts).toEqual(['carries 2', 'Range 40 km'])
    expect(card.armed).toBeNull()
  })

  test('a busy carrier: its plan with verbs, ETAs and the actor, the predicted delivery as a "then" line, Return naming what it drops, Deliver-to chips, Add stop', () => {
    const card = unitCard(situation, situation.units[1]!, su('r2'), null, 60)
    expect(card.planHeading).toBe('Route')
    expect(card.plan).toEqual([{ id: 'leg-1', index: 1, text: 'Pick up at J-2 Bay', eta: '2 min', active: true, by: 'by Assistant', removeLabel: 'Remove leg 1: Pick up at J-2 Bay' }])
    expect(card.predicted).toBe('then Depot A (nearest accepting) · 5 min')
    expect(card.recall.label).toBe('Home (drops J-2 Bay)')
    expect(card.undo).toMatchObject({ enabled: true, commandId: 'cmd-7' })
    // Only accepting sites are offered.
    expect(card.deliverTo).toEqual([{ siteId: 'depot-a', label: 'Depot A' }])
    expect(card.addStop).toEqual({ label: '+ Add leg', enabled: true, reason: null })
    expect(deliverToOrder(situation.units[1]!, 'depot-a')).toEqual({ units: ['r2'], stops: [{ siteId: 'depot-a' }], when: 'after' })
    expect(deliverToOrder(situation.units[0]!, 'depot-a')).toEqual({ units: ['r1'], stops: [{ siteId: 'depot-a' }] })
  })

  test('a loaded carrier cannot be sent home: Return is disabled with what it carries', () => {
    const loaded = situationOf({ units: [unit('r1', { carry: { capacity: 2, load: [{ classId: 'crate', code: 'C', label: '1 crate', count: 1 }] } })] })
    const card = unitCard(loaded, loaded.units[0]!, su('r1'), null, 0)
    expect(card.recall).toEqual({ label: 'Home', enabled: false, reason: 'Carrying 1 crate: deliver first' })
    expect(card.deliverTo.map(chip => chip.label)).toEqual(['Depot A'])
  })

  test('a unit another role commands is read-only and says who commands it', () => {
    const other = situationOf({ units: [unit('r1', { commandedBy: 'Blue command' })] })
    const card = unitCard(other, other.units[0]!, su('r1'), null, 0)
    expect(card.readOnly).toBe('Commanded by Blue command')
    expect([card.dispatch.enabled, card.recall.enabled, card.undo.enabled, card.removable]).toEqual([false, false, false, false])
  })

  test('armed: the banner, valid targets nearest first with verb, ETA and what is dropped, refused ones with their reason; loading until options arrive', () => {
    const loading = unitCard(situation, situation.units[0]!, sa('r1'), null, 0)
    expect(loading.armed).toEqual({ banner: 'Task R1…', targets: [], refused: [], loading: true, refusal: null, busy: null })
    const busy = optionsFor('r1', {
      busy: { taskId: 'job-2', label: 'J-2 Bay', freeInS: 300 },
      targets: [{ target: { taskId: 'job-1' }, verb: 'pick-up', label: 'J-1 Ridge', etaS: 240, drops: { taskId: 'job-2', label: 'J-2 Bay', code: 'Q1' } }],
    })
    const armed = unitCard(situation, situation.units[0]!, sa('r1', { refusal: { targetId: 'depot-b', code: 'site_not_accepting', text: 'Depot B is closed', untilMs: 9 } }), busy, 0).armed!
    expect(armed.loading).toBe(false)
    expect(armed.targets).toEqual([{ key: JSON.stringify({ taskId: 'job-1' }), target: { taskId: 'job-1' }, text: 'Pick up at J-1 Ridge', eta: '4 min', drops: 'drops J-2 Bay · Q1' }])
    expect(armed.refused).toEqual([{ key: JSON.stringify({ siteId: 'depot-b' }), target: { siteId: 'depot-b' }, label: 'Depot B', text: 'Depot B is closed for arrivals' }])
    expect(armed.refusal).toBe('Depot B is closed')
    const asked = unitCard(situation, situation.units[0]!, sa('r1', { prompt: { kind: 'busy', target: { taskId: 'job-1' } } }), busy, 0).armed!
    expect(asked.busy).toEqual({ after: `${dispatchWords.after} (free in 5 min)`, now: `${dispatchWords.now} (drops J-2 Bay · Q1)` })
    // Options of another unit are never shown.
    expect(unitCard(situation, situation.units[0]!, sa('r1'), optionsFor('k1'), 0).armed!.loading).toBe(true)
    expect(unitCard(situation, situation.units[0]!, sa('r1', { when: 'after' }), null, 0).armed!.banner).toBe('Task R1… (after current job)')
  })
})

describe('Call card', () => {
  test('waiting, the overdue line from the response target, needs with coverage, New until opened or assigned', () => {
    const card = callCard(situation, situation.calls[0]!, null, opened, 10)
    expect([card.code, card.priority, card.isNew, card.waiting, card.overdue]).toEqual(['Q0', 'Level 0', true, 'Waiting 4:20', 'overdue in 5:40'])
    expect(card.needs).toEqual([{ text: '2 crates 0/2', met: false }, { text: '1 kite (Camera = yes) 0/1', met: false }])
    expect(callCard(situation, situation.calls[0]!, null, new Set(['job-1']), 0).isNew).toBe(false)
    expect(callCard(situation, situation.calls[0]!, null, opened, 400).overdue).toBe('Overdue by 0:50')
    // No response target: no overdue line.
    expect(callCard(situation, situation.calls[1]!, null, opened, 0).overdue).toBeNull()
    expect(callCard(situation, situation.calls[1]!, null, opened, 0).isNew).toBe(false)
  })

  test('assigned units name their status, ETA and actor; Close names the units it frees', () => {
    const card = callCard(situation, situation.calls[1]!, null, opened, 0)
    expect(card.assigned).toEqual([{ unitId: 'r2', text: 'R2 · Moving · 3 min · by Assistant' }])
    expect(card.close).toEqual({ label: 'Drop job (frees R2)', confirm: `${dispatchWords.confirm}: frees R2` })
    expect(card.states).toEqual(['No free crew can serve'])
    expect(callCard(situation, situation.calls[0]!, null, opened, 0).close.label).toBe('Drop job')
  })

  test('the pinned proposal: one button sending proposal.order unchanged, coverage, remainder, alternatives per need, why not others', () => {
    const card = callCard(situation, situation.calls[0]!, pinnedOf(), opened, 0)
    expect(card.proposal!.button).toEqual({ label: 'Task R1, K1 · 6 min', enabled: true, reason: null })
    expect(card.proposal!.order).toEqual({ units: ['r1', 'k1'], stops: [{ taskId: 'job-1' }] })
    expect([card.proposal!.covers, card.proposal!.remainder, card.proposal!.stale]).toEqual(['covers 2 of 3', 'still needs 1 crate', false])
    expect(card.alternatives).toEqual([{ heading: 'Other: crates', units: [{ unitId: 'r3', text: 'R3 · 9 min', order: { units: ['r3'], stops: [{ taskId: 'job-1' }] } }] }])
    expect(card.whyNot).toEqual([{ label: 'R2', reasons: 'busy on J-2 Bay' }])
    // Deliver-to shows only after Dispatch, for a proposed carrier on the call.
    expect(card.deliverTo).toEqual([])
    expect(callCard(situation, situation.calls[0]!, null, opened, 0).proposal).toBeNull()
  })

  test('a dropped unit chip leaves the order and the label; dropping all disables the button', () => {
    const card = callCard(situation, situation.calls[0]!, pinnedOf({ dropped: new Set(['k1']) }), opened, 0)
    expect(card.proposal!.button.label).toBe('Task R1 · 4 min')
    expect(card.proposal!.order).toEqual({ units: ['r1'], stops: [{ taskId: 'job-1' }] })
    expect(card.proposal!.units.map(chip => chip.dropped)).toEqual([false, true])
    const all = callCard(situation, situation.calls[0]!, pinnedOf({ dropped: new Set(['k1', 'r1']) }), opened, 0)
    expect(all.proposal!.button).toMatchObject({ enabled: false, reason: dispatchWords.noUnitChosen })
    expect(all.proposal!.order).toBeNull()
  })

  test('an invalidated proposal greys out with the reason and is never re-labelled; no proposal says so', () => {
    const moved = situationOf({ units: [unit('r1', { status: { word: 'Moving', tone: 'busy' }, plan: [{ id: 'leg-1', verb: 'serve', target: { taskId: 'job-2' }, label: 'J-2 Bay', state: 'active', eta: routed(60), by: assistant }] }), unit('k1')] })
    expect(proposalInvalidation(moved, answer())).toBe('R1 now on J-2 Bay')
    const card = callCard(moved, moved.calls[0]!, pinnedOf(), opened, 0)
    expect(card.proposal!.button).toEqual({ label: 'Task R1, K1 · 6 min', enabled: false, reason: 'R1 now on J-2 Bay' })
    expect([card.proposal!.order, card.proposal!.stale]).toEqual([null, true])
    const gone = situationOf({ units: [unit('k1')] })
    expect(proposalInvalidation(gone, answer())).toBe(`R1: ${dispatchWords.notListed.toLowerCase()}`)
    const empty = callCard(situation, situation.calls[0]!, pinnedOf({ answer: answer({ proposal: null, deliverTo: [] }) }), opened, 0)
    expect([empty.proposal, empty.noProposal]).toEqual([null, dispatchWords.noFreeUnit])
  })

  test('after Dispatch the carrier\'s Deliver-to chips queue a site stop after its plan', () => {
    const sent = situationOf({ calls: [{ ...baseSituation.calls[0]!, assigned: [{ unitId: 'r1', label: 'R1', phase: 'en-route', status: { word: 'Moving', tone: 'busy' }, eta: routed(240), by: viewer }] }] })
    const card = callCard(sent, sent.calls[0]!, pinnedOf(), opened, 0)
    expect(card.assigned[0]!.text).toBe('R1 · Moving · 4 min · by you')
    expect(card.deliverTo).toEqual([{ unitLabel: 'R1', sites: [{ siteId: 'depot-a', text: 'Depot A · 5 min', order: { units: ['r1'], stops: [{ siteId: 'depot-a' }], when: 'after' } }] }])
  })

  test('a call that closed shows who served it and offers nothing', () => {
    expect(closedCallCard(situation.calls[1]!)).toEqual({ kind: 'closed-call', id: 'job-2', label: 'J-2 Bay', text: `${dispatchWords.closed} · served by R2` })
    const inputs = { options: null, pinned: null, opened, lastSeenCall: { ...situation.calls[1]!, id: 'job-9' }, elapsedS: 0 }
    expect(cardFor(situation, { kind: 'call', callId: 'job-9' }, inputs)?.kind).toBe('closed-call')
    expect(cardFor(situation, { kind: 'call', callId: 'job-8' }, inputs)).toBeNull()
    expect(cardFor(situation, { kind: 'call', callId: 'job-1' }, inputs)?.kind).toBe('call')
    expect(cardFor(situation, none, inputs)).toBeNull()
    expect(cardFor(situation, { kind: 'site', siteId: 'depot-a' }, inputs)?.kind).toBe('site')
    expect(cardFor(situation, sa('r1'), inputs)?.kind).toBe('unit')
  })
})

describe('Site card', () => {
  test('accepting state, a toggle naming its effect, slots and inbound units', () => {
    expect(siteCard(situation.sites[0]!, 0)).toEqual({
      kind: 'site', id: 'depot-a', icon: 'warehouse', title: 'Depot A · Depot', accepting: dispatchWords.accepting,
      toggle: { label: `${dispatchWords.closeArrivals} (R2 will go elsewhere)`, accepting: false },
      slots: `1 of 2 ${dispatchWords.slots}`, inbound: ['R2 · 6 min'], states: [],
    })
    expect(siteCard(situation.sites[1]!, 0).toggle).toEqual({ label: dispatchWords.openArrivals, accepting: true })
  })
})

describe('Overview', () => {
  test('the counts line: open calls per code, the oldest wait, free of all units, accepting sites of all', () => {
    expect(countsLine(situation, 10)).toBe(`Q0 1 Q1 1 · ${dispatchWords.oldest} 4:20 · 2/3 ${dispatchWords.free} · 1/2 depots ${dispatchWords.open}`)
    expect(countsLine(situationOf({ counts: { ...baseSituation.counts, calls: [], oldestWaitingS: null }, calls: [] }), 0)).toBe(`No jobs · 2/3 ${dispatchWords.free} · 1/2 depots ${dispatchWords.open}`)
    expect(edgeTabText(situation)).toBe(`Jobs 2 · 2 ${dispatchWords.free}`)
    expect(emptySelectionText(situation.words)).toBe('Click one of the jobs or crews')
  })

  test('calls with code, waiting time, needs, assigned units, the New badge and row states; units grouped by group, else type; sites', () => {
    const view = overview(situation, { kind: 'call', callId: 'job-2' }, opened, 0)
    expect(view.calls.heading).toBe('Jobs')
    expect(view.calls.rows.map(row => [row.code, row.label, row.waiting, row.assigned, row.isNew, row.selected, row.states])).toEqual([
      ['Q0', 'J-1 Ridge', '4:10', null, true, false, []],
      ['Q1', 'J-2 Bay', '1:00', 'R2', false, true, ['No free crew can serve']],
    ])
    expect(view.units.groups.map(group => [group.heading, group.rows.map(row => row.label)])).toEqual([['North crews', ['R1', 'R2']], ['Kite', ['K1']]])
    const r2 = view.units.groups[0]!.rows[1]!
    expect([r2.current, r2.actor, r2.carry, r2.properties]).toEqual(['J-2 Bay · 3 min', 'by Assistant', '0/2', ['40 km']])
    expect(view.units.groups[1]!.rows[0]!.carry).toBeNull()
    expect(view.sites!.rows.map(row => [row.label, row.accepting, row.slots, row.inbound])).toEqual([
      ['Depot A', dispatchWords.accepting, '1/2', `${dispatchWords.inbound} R2`],
      ['Depot B', dispatchWords.notAccepting, '0/1', null],
    ])
    expect(view.columns).toEqual({ carry: true, properties: ['Range'] })
    expect([view.contacts, view.folded]).toEqual([false, false])
    expect(overview(situation, sa('r1'), opened, 0).folded).toBe(true)
  })

  test('sections and columns follow the configuration: no carriers, no sites, no shown properties, no contacts', () => {
    const plain = situationOf({ sites: [], features: { hasCarry: false, hasSites: false, hasContacts: false, propertyColumns: [] } })
    const view = overview(plain, none, opened, 0)
    expect([view.sites, view.columns]).toEqual([null, { carry: false, properties: [] }])
    expect(view.units.groups.flatMap(group => group.rows).map(row => [row.carry, row.properties])).toEqual([[null, []], [null, []], [null, []]])
    expect(countsLine(plain, 0)).not.toContain('depots')
    expect(overview(situationOf({ features: { ...baseSituation.features, hasContacts: true } }), none, opened, 0).contacts).toBe(true)
    expect(overview(situationOf({ calls: [], units: [] }), none, opened, 0)).toMatchObject({ calls: { empty: 'No jobs' }, units: { empty: 'No crews' } })
  })
})

describe('Armed feedback, prompts and receipts', () => {
  test('targeting: halos with ETA tags on the valid targets that are objects, the refused target\'s reason first; nothing outside SA', () => {
    expect(targetingFor(su('r1'), optionsFor('r1'))).toBeNull()
    expect(targetingFor(sa('r1'), null)).toEqual({ from: oid('r1'), targets: [] })
    expect(targetingFor(sa('r1'), optionsFor('r1'))).toEqual({ from: oid('r1'), targets: [{ id: oid('job-1'), tag: '4 min' }, { id: oid('depot-a'), tag: '7 min' }] })
    const refused = sa('r1', { refusal: { targetId: 'depot-b', code: 'site_not_accepting', text: 'Depot B is closed', untilMs: 1 } })
    expect(targetingFor(refused, optionsFor('r1'))!.targets[0]).toEqual({ id: oid('depot-b'), tag: 'Depot B is closed' })
    const many = optionsFor('r1', { targets: Array.from({ length: 12 }, (_, index) => ({ target: { taskId: `job-${index}` }, verb: 'serve', label: `J-${index}`, etaS: index * 60 })) })
    expect(targetingFor(sa('r1'), many)!.targets).toHaveLength(mapTargetingMaxTargets)
  })

  test('the busy prompt: After current job, and Now naming what it drops; the Move prompt in the lexicon\'s word', () => {
    expect(busyPrompt(optionsFor('r1'), 'r1')).toBeNull()
    const busy = optionsFor('r1', { busy: { taskId: 'job-2', label: 'J-2 Bay', freeInS: 300 }, targets: [{ target: { taskId: 'job-1' }, verb: 'serve', label: 'J-1 Ridge', etaS: 1, drops: { taskId: 'job-2', label: 'J-2 Bay', code: 'Q1' } }] })
    expect(busyPrompt(busy, 'r1')).toEqual({ after: `${dispatchWords.after} (free in 5 min)`, now: `${dispatchWords.now} (drops J-2 Bay · Q1)`, drops: 'job-2' })
    expect(busyPrompt(busy, 'k1')).toBeNull()
    expect(movePromptText(situation, 'r1')).toBe('Shift R1 here')
  })

  test('receipts name the actor, unit, target and what was dropped; Undo for 8 s; newest first, one per command, at most 3', () => {
    const own = ownReceipt({ commandId: 'c1', unitIds: ['r1'], unitLabel: 'R1', targetLabel: 'J-1 Ridge', dropped: 'J-2 Bay', atMs: 1_000 })
    expect([own.text, own.undo]).toEqual([`${dispatchWords.you}: R1 → J-1 Ridge (drops J-2 Bay)`, `${dispatchWords.undo} (R1 returns to J-2 Bay)`])
    expect([receiptUndoable(own, 1_000 + receiptUndoMs - 1), receiptUndoable(own, 1_000 + receiptUndoMs)]).toEqual([true, false])
    const before = situationOf({ units: [unit('r1'), unit('r2')] })
    expect(receiptsFromSituation(null, situation, 5)).toEqual([])
    expect(receiptsFromSituation(before, situation, 5)).toEqual([{ commandId: 'cmd-7', unitIds: ['r2'], text: 'Assistant: R2 → J-2 Bay', undo: dispatchWords.undo, atMs: 5 }])
    expect(receiptsFromSituation(situation, situation, 5)).toEqual([])
    let list = withReceipts([], [own])
    list = withReceipts(list, receiptsFromSituation(before, situation, 5))
    list = withReceipts(list, [own])
    expect(list.map(receipt => receipt.commandId)).toEqual(['cmd-7', 'c1'])
    list = withReceipts(list, [{ ...own, commandId: 'c2' }, { ...own, commandId: 'c3' }])
    expect(list.map(receipt => receipt.commandId)).toEqual(['c3', 'c2', 'cmd-7'])
    expect(list).toHaveLength(maxReceipts)
  })
})

describe('Contacts', () => {
  const trackObject = (id: string, packData: object, observedAt?: string) => ({
    id, label: id.toUpperCase(), packId: einsatzPackId, packData,
    spatial: observedAt === undefined ? {} : { position: { observedAt } },
  }) as unknown as OperationalObject
  test('identified first, then contacts, then destroyed; a contact shows the neutral icon and no type; with the age of the last detection', () => {
    const objects = [
      trackObject('t3', { type: 'track', tier: 'destroyed', fix: false }),
      trackObject('t2', { type: 'track', tier: 'contact', fix: false }, '2026-01-01T00:00:00.000Z'),
      trackObject('t1', { type: 'track', tier: 'identified', fix: true, identity: { typeLabel: 'Skiff', icon: 'sailboat', side: 'east' } }),
      trackObject('u1', { type: 'unit', presentation: { icon: 'cog', typeLabel: 'Rover' }, phase: 'available', integrity: 'healthy', load: {} }),
    ]
    const rows = contactRows(objects, Date.parse('2026-01-01T00:01:30.000Z'), 't2')
    expect(rows.map(row => [row.label, row.icon, row.text, row.age, row.destroyed, row.selected])).toEqual([
      ['T1', 'sailboat', 'Identified · Skiff', null, false, false],
      ['T2', 'circle-question-mark', 'Contact', '1:30', false, true],
      ['T3', 'circle-question-mark', 'Destroyed', null, true, false],
    ])
  })
  test('Einsatz objects are classified by their one record schema: a receiving unit is a site; a record that does not match is refused', () => {
    const presentation = { icon: 'cog', typeLabel: 'Rover' }
    const unitRecord = { type: 'unit', presentation, phase: 'available', integrity: 'healthy', load: {} }
    const of = (packData: unknown, packId: string = einsatzPackId) => dispatchKindOf({ packId: packId as never, packData: packData as never })
    expect(of({ ...unitRecord, accepting: true })).toBe('site')
    expect(of(unitRecord)).toBe('unit')
    expect(of({ type: 'task', presentation })).toBe('call')
    expect(of({ type: 'track', tier: 'contact', fix: false })).toBe('track')
    expect(of({ type: 'track-index', side: 'east', next: 1, subjects: {} })).toBeNull()
    expect(of({ type: 'unit' }, 'other')).toBeNull()
    expect(() => of({ type: 'unit' })).toThrow()
  })
  test('clock text', () => expect([clockText(59.6), clockText(3_725), clockText(-3)]).toEqual(['1:00', '1:02:05', '0:00']))
})

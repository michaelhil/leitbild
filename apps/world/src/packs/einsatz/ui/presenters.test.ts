import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, objectIdSchema, type OperationalObject } from '../../../core/model/index.ts'
import { assertMapTargeting, mapTargetingMaxTags } from '../../../ui/surface-panel-interaction.ts'
import { einsatzPackId } from '../ids.ts'
import { recommendAnswerSchema, type RecommendAnswer } from '../recommendation-schema.ts'
import { situationSchema, unitOptionsSchema, type Situation, type UnitOptions } from '../situation/schema.ts'
import {
  callCard,
  cardFor,
  closedCallCard,
  contactRows,
  countsLine,
  dispatchKindOf,
  einsatzRecordsKey,
  edgeTabText,
  emptySelectionText,
  maxReceipts,
  overview,
  ownReceipt,
  pinProposal,
  proposalInvalidation,
  receiptsFromSituation,
  receiptText,
  receiptUndoable,
  receiptUndoMs,
  saysBesideUndo,
  siteCard,
  stopLabelOf,
  targetingFor,
  toggledChip,
  unitCard,
  withReceipts,
  type PinnedProposal,
} from './presenters.ts'
import type { Selection } from './selection.ts'
import { dispatchWords } from './dispatch-words.ts'

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
      needs: [{ kind: 'load', classId: 'crate', code: 'C', label: '2 crates', waiting: 2, covered: 0, planned: 0 }, { kind: 'requirement', provides: 'survey', label: '1 kite', where: ['Camera = yes'], count: 1, enRoute: 0, onTask: 0, completed: 0, planned: 0 }],
      assigned: [], planned: [], states: [],
    },
    {
      id: 'job-2', label: 'J-2 Bay', icon: 'flag', templateLabel: 'Pickup', priority: priority(1), waitingS: 60,
      needs: [{ kind: 'load', classId: 'crate', code: 'C', label: '1 crate', waiting: 1, covered: 1, planned: 0 }],
      assigned: [{ unitId: 'r2', label: 'R2', phase: 'en-route', status: { word: 'Moving', tone: 'busy' }, eta: routed(180), by: assistant }],
      planned: [],
      states: [{ code: 'no_free_unit', text: 'No free crew can serve' }],
    },
  ],
  units: [
    unit('r1'),
    unit('r2', {
      status: { word: 'Moving', tone: 'busy' }, phase: 'en-route',
      plan: [{ id: 'leg-1', verb: 'pick-up', target: { taskId: 'job-2' }, label: 'J-2 Bay', state: 'active', eta: routed(180), by: assistant }],
      predictedDelivery: { siteId: 'depot-a', label: 'Depot A', eta: routed(360) },
      lastOrder: { by: assistant, commandId: 'cmd-7', undo: { applies: true } },
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
const opened = new Set<string>()

const optionsFor = (unitId: string, extra: object = {}): UnitOptions => unitOptionsSchema.parse({
  unitId,
  busy: null,
  plan: [],
  targets: [
    { target: { taskId: 'job-1' }, verb: 'pick-up', label: 'J-1 Ridge', etaS: 240, afterOnly: false, canReplace: true, canAdd: true },
    { target: { siteId: 'depot-a' }, verb: 'go-to', label: 'Depot A', etaS: 400, afterOnly: false, canReplace: true, canAdd: true },
    { target: { point: { type: 'Point', coordinates: [11, 59] } }, verb: 'go-to', label: 'the map point', etaS: 60, afterOnly: false, canReplace: true, canAdd: true },
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
const pinnedOf = (extra: Partial<PinnedProposal> = {}, at: Situation = situation): PinnedProposal => ({ ...pinProposal(at, 'job-1', extra.answer ?? answer()), ...extra })

describe('Compact unit card', () => {
  test('shows targets immediately from matching options, with no dispatch button; Undo last order is disabled while there is no order to undo', () => {
    const card = unitCard(situation, situation.units[0]!, optionsFor('r1'), 0)
    expect(card.title).toBe('R1 · Rover')
    expect(card.status).toEqual({ word: 'Idle', tone: 'free', due: null })
    expect(card.recall).toEqual({ label: 'Home', enabled: true, reason: null })
    expect(card.undo).toEqual({ label: dispatchWords.undoLast, enabled: false, reason: dispatchWords.nothingToUndo, commandId: null })
    expect(card.targets.map(target => target.key)).toContain('job-1')
    expect(card.targetsLoading).toBe(false)
    expect(card).not.toHaveProperty('dispatch')
    expect(unitCard(situation, situation.units[0]!, optionsFor('k1'), 0).targetsLoading).toBe(true)
  })

  test('Undo last order reads just that, sends its commandId, and is enabled only while the situation says the engine would take the order back', () => {
    const busy = situation.units[1]!
    const card = unitCard(situation, busy, null, 0)
    expect(card.undo).toEqual({ label: dispatchWords.undoLast, enabled: true, reason: null, commandId: 'cmd-7' })
    // The engine's verdict refuses: disabled with its words, before any click.
    const verdict = (text: string, by = assistant) => situationOf({ units: [unit('r2', { ...busy, lastOrder: { by, commandId: 'cmd-7', undo: { applies: false, refusal: text } } })] })
    for (const text of ['R2\'s last order has been carried out: it has arrived', 'R2 is past the first stop of its last order', 'R2\'s last order is already undone', 'R2\'s last order can\'t be undone: Undo takes back only an order that gave it a stop']) {
      const refused = verdict(text)
      expect(unitCard(refused, refused.units[0]!, null, 0).undo).toEqual({ label: dispatchWords.undoLast, enabled: false, reason: text, commandId: 'cmd-7' })
    }
    // A standing order acted last: the label names no actor, and the verdict on the operator's command decides.
    const delivered = verdict('R2 is past the first stop of its last order', { label: 'Standing order', isViewer: false })
    expect(unitCard(delivered, delivered.units[0]!, null, 0).undo).toMatchObject({ label: dispatchWords.undoLast, enabled: false })
    // The engine's own refusal of a click on this command keeps it disabled with that refusal, even if the last read still said it applies.
    const refusal = { unitId: 'r2', commandId: 'cmd-7', text: 'R2\'s last order has been carried out: it has arrived' }
    expect(unitCard(situation, busy, null, 0, refusal).undo).toMatchObject({ enabled: false, reason: refusal.text, commandId: 'cmd-7' })
    // A refusal of another command, or of another unit, leaves the current order's Undo alone.
    expect(unitCard(situation, busy, null, 0, { ...refusal, commandId: 'cmd-6' }).undo.enabled).toBe(true)
    expect(unitCard(situation, busy, null, 0, { ...refusal, unitId: 'r1' }).undo.enabled).toBe(true)
    expect(cardFor(situation, su('r2'), { options: null, pinned: null, opened, lastSeenCall: null, elapsedS: 0, undoRefusal: refusal })).toMatchObject({ undo: { enabled: false, reason: refusal.text } })
    // A unit whose last order no command gave (a standing order) has nothing the engine takes back.
    const standing = situationOf({ units: [unit('r1', { lastOrder: { by: { label: 'Standing order', isViewer: false }, commandId: null, undo: null } })] })
    expect(unitCard(standing, standing.units[0]!, null, 0).undo).toMatchObject({ label: dispatchWords.undoLast, enabled: false, reason: dispatchWords.nothingToUndo, commandId: null })
  })

  test('a refused Undo\'s text is said once: the shown card says it beside its disabled Undo, so the slot need not', () => {
    const text = 'R2\'s last order has been carried out: it has arrived'
    const refused = situationOf({ units: [unit('r2', { ...situation.units[1]!, lastOrder: { by: assistant, commandId: 'cmd-7', undo: { applies: false, refusal: text } } })] })
    const card = unitCard(refused, refused.units[0]!, null, 0)
    expect(saysBesideUndo(card, text)).toBe(true)
    expect(saysBesideUndo(card, 'Another refusal')).toBe(false)
    expect(saysBesideUndo(null, text)).toBe(false)
    // No Undo row on a read-only unit, and an enabled Undo says no reason.
    const other = situationOf({ units: [unit('r2', { ...refused.units[0]!, commandedBy: 'Blue command' })] })
    expect(saysBesideUndo(unitCard(other, other.units[0]!, null, 0), 'Commanded by Blue command')).toBe(false)
    expect(saysBesideUndo(unitCard(situation, situation.units[1]!, null, 0), text)).toBe(false)
    expect(saysBesideUndo(callCard(situation, situation.calls[0]!, null, opened, 0), text)).toBe(false)
  })

  test('lists the plan in order, the active stop first, each stop with the words of its ×; no stop can be moved', () => {
    const lead = situation.units[1]!.plan[0]!
    const assigned = situationOf({ units: [unit('r2', { plan: [lead, { ...lead, id: 'leg-2', label: 'Depot A', state: 'queued', target: { siteId: 'depot-a' } }, { ...lead, id: 'leg-3', state: 'queued' }] })] })
    const card = unitCard(assigned, assigned.units[0]!, null, 60)
    expect(card.plan.map(stop => [stop.id, stop.active, stop.removeLabel])).toEqual([
      ['leg-1', true, 'Remove leg 1: Pick up at J-2 Bay'], ['leg-2', false, 'Remove leg 2: Pick up at Depot A'], ['leg-3', false, 'Remove leg 3: Pick up at J-2 Bay'],
    ])
    expect(card.plan[0]).toMatchObject({ text: 'Pick up at J-2 Bay', by: 'by Assistant' })
    expect(Object.keys(card.plan[0]!).sort()).toEqual(['active', 'by', 'eta', 'id', 'index', 'removeLabel', 'text'])
  })

  test('a carrier with a load cannot return to base, and a read-only unit has no targets or plan actions', () => {
    const loaded = situationOf({ units: [unit('r1', { carry: { capacity: 2, load: [{ classId: 'crate', code: 'C', label: '1 crate', count: 1 }] } })] })
    expect(unitCard(loaded, loaded.units[0]!, null, 0).recall.reason).toContain('deliver first')
    const other = situationOf({ units: [unit('r1', { commandedBy: 'Blue command' })] })
    const card = unitCard(other, other.units[0]!, optionsFor('r1'), 0)
    expect(card.readOnly).toBe('Commanded by Blue command')
    expect(card.recall.enabled).toBe(false)
    expect(card.undo).toMatchObject({ enabled: false, reason: 'Commanded by Blue command' })
    expect(card.removable).toBe(false)
    expect(card.targets).toEqual([])
    expect(targetingFor(other.units[0], optionsFor('r1'))).toBeNull()
  })

  test('a stop in words, which the panel and the card harness both use: as the options list it, else the call\'s, site\'s or object\'s label; a point is the map point', () => {
    expect(stopLabelOf({ taskId: 'job-1' }, situation, optionsFor('r1'), [])).toBe('J-1 Ridge')
    expect(stopLabelOf({ taskId: 'job-2' }, situation, null, [])).toBe('J-2 Bay')
    expect(stopLabelOf({ siteId: 'depot-a' }, situation, null, [])).toBe('Depot A')
    expect(stopLabelOf({ trackId: 'trk-1' }, situation, null, [{ id: oid('trk-1'), label: 'Contact 1' }])).toBe('Contact 1')
    expect(stopLabelOf({ point: geoPointFromLonLat(11, 59) }, situation, null, [])).toBe(dispatchWords.mapPoint)
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

  test('the command block stands from the moment the card opens: while the answer is on its way, Dispatch and Refresh are disabled in place', () => {
    const loading = callCard(situation, situation.calls[0]!, null, opened, 0).proposal
    expect([loading.button, loading.refresh.enabled, loading.units, loading.order, loading.waiting]).toEqual([{ label: 'Task', enabled: false, reason: dispatchWords.loading }, false, [], null, true])
  })

  test('the pinned proposal: one button sending proposal.order unchanged, Refresh beside it disabled while it holds, coverage, remainder, alternatives as labelled orders, why not others', () => {
    const card = callCard(situation, situation.calls[0]!, pinnedOf(), opened, 0)
    expect(card.proposal.button).toEqual({ label: 'Task R1, K1 · 6 min', enabled: true, reason: null })
    expect(card.proposal.refresh).toEqual({ label: dispatchWords.refresh, enabled: false, reason: dispatchWords.suggestionHolds })
    expect(card.proposal.order).toEqual({ units: ['r1', 'k1'], stops: [{ taskId: 'job-1' }] })
    expect([card.proposal.covers, card.proposal.remainder, card.proposal.stale, card.proposal.waiting]).toEqual(['covers 2 of 3', 'still needs 1 crate', false, false])
    // An alternative gives an order on one tap, so it carries the lexicon's verb.
    expect(card.alternatives).toEqual([{ heading: 'Other: crates', units: [{ unitId: 'r3', text: 'Task R3 · 9 min', order: { units: ['r3'], stops: [{ taskId: 'job-1' }] } }] }])
    expect(card.whyNot).toEqual([{ label: 'R2', reasons: 'busy on J-2 Bay' }])
    // Deliver-to stands under the command block from pinning, its sites named but not offered until the carrier is on the call.
    expect(card.deliverTo).toEqual([{ unitLabel: 'R1', heading: `${dispatchWords.deliverTo} (R1, after Task)`, enabled: false, sites: [{ siteId: 'depot-a', text: 'Depot A · 5 min', selected: false, order: { units: ['r1'], stops: [{ siteId: 'depot-a' }], when: 'after' } }] }])
  })

  test('a dropped unit chip leaves the order and the label; dropping all disables the button', () => {
    const card = callCard(situation, situation.calls[0]!, pinnedOf({ dropped: new Set(['k1']) }), opened, 0)
    expect(card.proposal.button.label).toBe('Task R1 · 4 min')
    expect(card.proposal.order).toEqual({ units: ['r1'], stops: [{ taskId: 'job-1' }] })
    expect(card.proposal.units.map(chip => chip.dropped)).toEqual([false, true])
    const all = callCard(situation, situation.calls[0]!, pinnedOf({ dropped: new Set(['k1', 'r1']) }), opened, 0)
    expect(all.proposal.button).toMatchObject({ enabled: false, reason: dispatchWords.noUnitChosen })
    expect(all.proposal.order).toBeNull()
    // A chip tap drops a unit, a second restores it.
    expect([...toggledChip(pinnedOf(), 'k1').dropped]).toEqual(['k1'])
    expect([...toggledChip(toggledChip(pinnedOf(), 'k1'), 'k1').dropped]).toEqual([])
  })

  test('an invalidated proposal greys out with the reason and is never re-labelled; Refresh comes alive; no proposal says so', () => {
    const moved = situationOf({ units: [unit('r1', { status: { word: 'Moving', tone: 'busy' }, plan: [{ id: 'leg-1', verb: 'serve', target: { taskId: 'job-2' }, label: 'J-2 Bay', state: 'active', eta: routed(60), by: assistant }] }), unit('k1')] })
    expect(proposalInvalidation(moved, pinnedOf())).toBe('R1 now on J-2 Bay')
    const card = callCard(moved, moved.calls[0]!, pinnedOf(), opened, 0)
    expect(card.proposal.button).toEqual({ label: 'Task R1, K1 · 6 min', enabled: false, reason: 'R1 now on J-2 Bay' })
    expect([card.proposal.order, card.proposal.stale, card.proposal.refresh.enabled]).toEqual([null, true, true])
    const gone = situationOf({ units: [unit('k1')] })
    expect(proposalInvalidation(gone, pinnedOf())).toBe(`R1: ${dispatchWords.notListed.toLowerCase()}`)
    const empty = callCard(situation, situation.calls[0]!, pinnedOf({ answer: answer({ proposal: null, deliverTo: [] }) }), opened, 0)
    expect([empty.proposal.button, empty.proposal.refresh.enabled]).toEqual([{ label: 'Task', enabled: false, reason: dispatchWords.noFreeUnit }, true])
    // A call whose every need is met is covered, never short of units.
    const covered = callCard(situation, situation.calls[1]!, pinnedOf({ answer: answer({ taskId: 'job-2', proposal: null, deliverTo: [] }), callId: 'job-2' }), opened, 0)
    expect(covered.proposal.button).toEqual({ label: 'Task', enabled: false, reason: dispatchWords.covered })
  })

  test('a later stop in another crew\'s route: the need says what it will add, the card names it with its leg and ETA, and with every need planned there is no proposal for that reason', () => {
    const job = situation.calls[1]!
    const planned = situationOf({ calls: [situation.calls[0]!, { ...job, assigned: [], needs: [{ ...job.needs[0]!, covered: 0, planned: 1 }], planned: [{ unitId: 'r3', label: 'R3', stop: 2, eta: routed(840) }], states: [] }] })
    const call = planned.calls[1]!
    const card = callCard(planned, call, pinnedOf({ answer: answer({ taskId: 'job-2', proposal: null, deliverTo: [] }), callId: 'job-2' }, planned), opened, 0)
    expect(card.needs).toEqual([{ text: '1 crate 0/1 · 1 planned', met: false }])
    expect(card.planned).toEqual([{ unitId: 'r3', text: 'R3 · planned as leg 2 · 14 min' }])
    expect(card.proposal.button).toEqual({ label: 'Task', enabled: false, reason: dispatchWords.plannedCover })
    expect(overview(planned, none, opened, 0).calls.rows[1]!.needs).toBe('1 crate 0/1 · 1 planned')
  })

  test('only a change since pinning invalidates: a unit returning when it was proposed (free to the engine) still holds; one that turns out of action or gains a stop does not', () => {
    const returning = situationOf({ units: [unit('r1', { status: { word: 'Returning', tone: 'returning' }, phase: 'returning' }), unit('k1')] })
    const pinned = pinnedOf({}, returning)
    expect(proposalInvalidation(returning, pinned)).toBeNull()
    expect(callCard(returning, returning.calls[0]!, pinned, opened, 0).proposal.button.enabled).toBe(true)
    // A unit busy at pinning keeps the stop it had; only a new stop counts.
    const busyAtPin = situationOf({ units: [unit('r1', { plan: [{ id: 'leg-0', verb: 'go-to', target: { siteId: 'depot-a' }, label: 'Depot A', state: 'active', eta: routed(60), by: viewer }] }), unit('k1')] })
    expect(proposalInvalidation(busyAtPin, pinnedOf({}, busyAtPin))).toBeNull()
    const out = situationOf({ units: [unit('r1', { status: { word: 'Destroyed', tone: 'out' } }), unit('k1')] })
    expect(proposalInvalidation(out, pinned)).toBe('R1 now destroyed')
  })

  test('Refresh keeps the old answer greyed in place until the new one arrives', () => {
    const card = callCard(situation, situation.calls[0]!, pinnedOf({ refreshing: true }), opened, 0)
    expect([card.proposal.button.label, card.proposal.button.reason, card.proposal.waiting, card.proposal.refresh.enabled]).toEqual(['Task R1, K1 · 6 min', dispatchWords.refreshing, true, false])
    expect(card.alternatives).toHaveLength(1)
  })

  test('after Dispatch the carrier\'s Deliver-to chips come alive in place and queue a site stop after its plan', () => {
    const sent = situationOf({
      calls: [{ ...baseSituation.calls[0]!, assigned: [{ unitId: 'r1', label: 'R1', phase: 'en-route', status: { word: 'Moving', tone: 'busy' }, eta: routed(240), by: viewer }] }],
      units: [unit('r1', { predictedDelivery: { siteId: 'depot-a', label: 'Depot A', eta: routed(300) } }), unit('k1')],
    })
    const card = callCard(sent, sent.calls[0]!, pinnedOf(), opened, 0)
    // One actor word: the situation's, on every surface.
    expect(card.assigned[0]!.text).toBe('R1 · Moving · 4 min · by Desk')
    expect(card.deliverTo).toEqual([{ unitLabel: 'R1', heading: `${dispatchWords.deliverTo} (R1)`, enabled: true, sites: [{ siteId: 'depot-a', text: 'Depot A · 5 min', selected: true, order: { units: ['r1'], stops: [{ siteId: 'depot-a' }], when: 'after' } }] }])
  })

  test('D.5: a call another Pack\'s sensor observed says by whom and at what Run time', () => {
    expect(callCard(situation, situation.calls[0]!, null, opened, 0).observed).toBeNull()
    const seen = situationOf({ calls: [{ ...baseSituation.calls[0]!, observed: { by: 'D-1', at: '2026-11-16T14:02:41.000Z' } }] })
    expect(callCard(seen, seen.calls[0]!, null, opened, 0).observed).toBe(`${dispatchWords.observedBy} D-1 at 14:02 UTC`)
  })

  test('a call that closed shows who served it and offers nothing', () => {
    expect(closedCallCard(situation.calls[1]!)).toEqual({ kind: 'closed-call', id: 'job-2', label: 'J-2 Bay', text: `${dispatchWords.closed} · served by R2` })
    const inputs = { options: null, pinned: null, opened, lastSeenCall: { ...situation.calls[1]!, id: 'job-9' }, elapsedS: 0, undoRefusal: null }
    expect(cardFor(situation, { kind: 'call', callId: 'job-9' }, inputs)?.kind).toBe('closed-call')
    expect(cardFor(situation, { kind: 'call', callId: 'job-8' }, inputs)).toBeNull()
    expect(cardFor(situation, { kind: 'call', callId: 'job-1' }, inputs)?.kind).toBe('call')
    expect(cardFor(situation, none, inputs)).toBeNull()
    expect(cardFor(situation, { kind: 'site', siteId: 'depot-a' }, inputs)?.kind).toBe('site')
    expect(cardFor(situation, su('r1'), inputs)?.kind).toBe('unit')
  })
})

describe('Site card', () => {
  test('accepting state, a toggle naming its effect, slots and inbound units', () => {
    expect(siteCard(situation.sites[0]!, 0)).toEqual({
      kind: 'site', id: 'depot-a', icon: 'warehouse', title: 'Depot A · Depot',
      receiving: {
        accepting: dispatchWords.accepting,
        toggle: { label: `${dispatchWords.closeArrivals} (R2 will go elsewhere)`, accepting: false },
        slots: `1 of 2 ${dispatchWords.slots}`,
      },
      inbound: ['R2 · 6 min'], states: [],
    })
    expect(siteCard(situation.sites[1]!, 0).receiving?.toggle).toEqual({ label: dispatchWords.openArrivals, accepting: true })
  })

  test('a place that receives no load (a depot, an objective) shows no accepting state, toggle or slots, only its inbound units', () => {
    const place = { ...situation.sites[0]!, id: 'post', label: 'Post', typeLabel: 'Post', accepting: null, slots: null }
    expect(siteCard(place, 0)).toEqual({ kind: 'site', id: 'post', icon: 'warehouse', title: 'Post · Post', receiving: null, inbound: ['R2 · 6 min'], states: [] })
    const view = overview(situationOf({ sites: [...situation.sites, place] }), { kind: 'none', marked: null }, opened, 0)
    expect(view.sites!.rows.at(-1)!.receiving).toBeNull()
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
    // In each group the free units come first, so they are named at a glance.
    const busyFirst = situationOf({ units: [unit('r2', { status: { word: 'Moving', tone: 'busy' } }), unit('r1'), unit('k1', { typeLabel: 'Kite', group: null })] })
    expect(overview(busyFirst, none, opened, 0).units.groups.map(group => group.rows.map(row => row.label))).toEqual([['R1', 'R2'], ['K1']])
    const r2 = view.units.groups[0]!.rows[1]!
    expect([r2.current, r2.actor, r2.carry, r2.properties]).toEqual(['J-2 Bay · 3 min', 'by Assistant', '0/2', ['Range 40 km']])
    expect(view.units.groups[1]!.rows[0]!.carry).toBeNull()
    expect(view.sites!.rows.map(row => [row.label, row.receiving, row.inbound])).toEqual([
      ['Depot A', { accepting: dispatchWords.accepting, slots: '1/2' }, `${dispatchWords.inbound} R2`],
      ['Depot B', { accepting: dispatchWords.notAccepting, slots: '0/1' }, null],
    ])
    expect(view.columns).toEqual({ carry: true })
    expect([view.contacts, view.folded]).toEqual([false, false])
    expect(overview(situation, su('r1'), opened, 0).folded).toBe(true)
  })

  test('only covered active calls and busy units without attention states pulse', () => {
    const covered = { ...situation.calls[1]!, states: [] }
    const finished = {
      ...covered,
      id: 'job-3',
      assigned: [],
      planned: [],
      needs: [{ kind: 'requirement', provides: 'survey', label: 'Survey', where: [], count: 1, enRoute: 0, onTask: 0, completed: 1, planned: 0 }],
    }
    const partial = { ...covered, id: 'job-4', needs: [{ kind: 'load', classId: 'crate', code: 'C', label: '2 crates', waiting: 2, covered: 1, planned: 0 }] }
    const view = overview(situationOf({ calls: [situation.calls[0], covered, finished, partial] }), none, opened, 0)
    expect(view.calls.rows.map(row => row.progress)).toEqual([null, 'active', 'covered', null])
    expect(view.calls.rows[2]!.isNew).toBeFalse()
    expect(view.units.groups[0]!.rows.map(row => row.progress)).toEqual([null, 'active'])
    expect(view.sites!.rows.map(row => row.progress)).toEqual(['active', null])
    expect(overview(situation, none, opened, 0).calls.rows[1]!.progress).toBeNull()
  })

  test('sections and columns follow the configuration: no carriers, no sites, no shown properties, no contacts', () => {
    const plain = situationOf({ sites: [], features: { hasCarry: false, hasSites: false, hasContacts: false, propertyColumns: [] } })
    const view = overview(plain, none, opened, 0)
    expect([view.sites, view.columns]).toEqual([null, { carry: false }])
    expect(view.units.groups.flatMap(group => group.rows).map(row => [row.carry, row.properties])).toEqual([[null, []], [null, []], [null, []]])
    expect(countsLine(plain, 0)).not.toContain('depots')
    expect(overview(situationOf({ features: { ...baseSituation.features, hasContacts: true } }), none, opened, 0).contacts).toBe(true)
    expect(overview(situationOf({ calls: [], units: [] }), none, opened, 0)).toMatchObject({ calls: { empty: 'No jobs' }, units: { empty: 'No crews' } })
  })
})

describe('Map targeting and feedback', () => {
  test('the selected unit rings valid objects only after its options arrive', () => {
    const rover = situation.units[0]!
    expect(targetingFor(undefined, optionsFor('r1'))).toBeNull()
    expect(targetingFor(rover, null)).toEqual({ from: oid('r1'), complete: false, targets: [] })
    expect(targetingFor(rover, optionsFor('r1'))).toEqual({ from: oid('r1'), complete: true, targets: [
      { id: oid('job-1'), tag: '4 min', tone: 'valid' }, { id: oid('depot-a'), tag: '7 min', tone: 'valid' },
    ] })
  })

  test('assigned targets take precedence and share one numbered ring for repeated stops; all other valid targets stay selectable', () => {
    const rover = situation.units[1]!
    const repeated = { ...rover, plan: [...rover.plan, { ...rover.plan[0]!, id: 'leg-2', state: 'queued' as const }] }
    const many = optionsFor('r2', {
      plan: repeated.plan.map(({ id, state }) => ({ id, state })),
      targets: Array.from({ length: 12 }, (_, index) => ({ target: { taskId: `job-${index}` }, verb: 'serve', label: `J-${index}`, etaS: index * 60, afterOnly: false, canReplace: true, canAdd: true })),
    })
    const targeting = targetingFor(repeated, many)!
    expect(targeting.targets).toHaveLength(12)
    expect(targeting.targets[0]).toEqual({ id: oid('job-2'), tone: 'assigned', tag: 'Plan 1, 2' })
    expect(targeting.targets.filter(target => target.tag !== undefined)).toHaveLength(mapTargetingMaxTags)
    expect(assertMapTargeting('einsatz.dispatch', targeting)).toBe(targeting)
  })

  test('receipts name the actor, unit, target and what was dropped; this screen\'s own orders offer Undo for 8 s; newest first, one per command, at most 3', () => {
    const own = ownReceipt({ commandId: 'c1', unitIds: ['r1'], unitLabel: 'R1', targetLabel: 'J-1 Ridge', dropped: 'J-2 Bay · Q1', undoable: true, atMs: 1_000 })
    expect([receiptText(own), own.undo]).toEqual(['R1 → J-1 Ridge (drops J-2 Bay · Q1)', `${dispatchWords.undo} (R1 returns to J-2 Bay · Q1)`])
    expect(receiptUndoMs).toBe(8_000)
    expect([receiptUndoable(own, 1_000 + receiptUndoMs - 1), receiptUndoable(own, 1_000 + receiptUndoMs)]).toEqual([true, false])
    expect(ownReceipt({ commandId: 'c0', unitIds: ['r1'], unitLabel: 'R1', targetLabel: 'J-1 Ridge', dropped: null, undoable: true, atMs: 0 }).undo).toBe(dispatchWords.undo)
    // A return is nothing the engine takes back, so its receipt offers no Undo.
    const home = ownReceipt({ commandId: 'c9', unitIds: ['r1'], unitLabel: 'R1', targetLabel: 'Home', dropped: null, undoable: false, atMs: 1_000 })
    expect([home.undo, receiptUndoable(home, 1_000)]).toEqual([null, false])
    const before = situationOf({ units: [unit('r1'), unit('r2')] })
    expect(receiptsFromSituation(null, situation, 5)).toEqual([])
    const theirs = receiptsFromSituation(before, situation, 5)
    // Another actor's order is theirs to take back: its receipt offers no Undo here.
    expect(theirs).toEqual([{ commandId: 'cmd-7', unitIds: ['r2'], actor: 'Assistant', text: 'R2 → J-2 Bay', undo: null, atMs: 5, own: false }])
    expect(receiptUndoable(theirs[0]!, 5)).toBe(false)
    expect(receiptText(theirs[0]!)).toBe('Assistant: R2 → J-2 Bay')
    expect(receiptsFromSituation(situation, situation, 5)).toEqual([])
    let list = withReceipts([], [own])
    list = withReceipts(list, theirs)
    list = withReceipts(list, [own])
    expect(list.map(receipt => receipt.commandId)).toEqual(['cmd-7', 'c1'])
    list = withReceipts(list, [{ ...own, commandId: 'c2' }, { ...own, commandId: 'c3' }])
    expect(list.map(receipt => receipt.commandId)).toEqual(['c3', 'c2', 'cmd-7'])
    expect(list).toHaveLength(maxReceipts)
    // One order of two units the situation shows on both is one receipt.
    expect(withReceipts([], [...theirs, { ...theirs[0]!, unitIds: ['r1'] }]).map(receipt => receipt.commandId)).toEqual(['cmd-7'])
  })

  test('one actor word: an own receipt takes the place of the situation\'s for the same command, whichever came first, naming what it dropped and the actor the situation names', () => {
    const generic = receiptsFromSituation(situationOf({ units: [unit('r1'), unit('r2')] }), situation, 5)
    const own = ownReceipt({ commandId: 'cmd-7', unitIds: ['r2'], unitLabel: 'R2', targetLabel: 'J-2 Bay', dropped: 'J-1 Ridge · Q0', undoable: true, atMs: 9 })
    expect(own.actor).toBeNull()
    const replaced = withReceipts(withReceipts([], generic), [own])
    expect(replaced).toEqual([{ ...own, actor: 'Assistant', atMs: 5 }])
    const named = withReceipts(withReceipts([], [own]), generic)
    expect(named).toEqual([{ ...own, actor: 'Assistant' }])
    expect(receiptText(named[0]!)).toBe('Assistant: R2 → J-2 Bay (drops J-1 Ridge · Q0)')
  })

  test('no word says "You": the viewer\'s own orders read in the situation\'s actor word on every surface', () => {
    expect(Object.values(dispatchWords)).not.toContain('You')
    const mine = situationOf({ units: [unit('r1', { plan: [{ id: 'leg-1', verb: 'serve', target: { taskId: 'job-1' }, label: 'J-1 Ridge', state: 'active', eta: routed(60), by: { label: 'Operator', isViewer: false } }], lastOrder: { by: { label: 'Operator', isViewer: false }, commandId: 'cmd-9', undo: { applies: true } } })] })
    const card = unitCard(mine, mine.units[0]!, null, 0)
    expect([card.plan[0]!.by, card.undo.label]).toEqual(['by Operator', dispatchWords.undoLast])
    expect(overview(mine, none, opened, 0).units.groups[0]!.rows[0]!.actor).toBe('by Operator')
    expect(receiptText(receiptsFromSituation(situationOf({ units: [unit('r1')] }), mine, 1)[0]!)).toBe('Operator: R1 → J-1 Ridge')
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
  test('Einsatz objects are classified as the situation lists them: a unit record that does not move is a site, receiving or not; a record that does not match is refused', () => {
    const presentation = { icon: 'cog', typeLabel: 'Rover' }
    const unitRecord = { type: 'unit', presentation, phase: 'available', integrity: 'healthy', load: {} }
    const of = (packData: unknown, packId: string = einsatzPackId, kind: OperationalObject['kind'] = 'mobile_entity') => dispatchKindOf({ packId: packId as never, packData: packData as never, kind })
    expect(of({ ...unitRecord, accepting: true }, einsatzPackId, 'facility')).toBe('site')
    // A place that receives no load (a depot, an objective) is a site too.
    expect(of(unitRecord, einsatzPackId, 'facility')).toBe('site')
    expect(of(unitRecord)).toBe('unit')
    expect(of({ type: 'task', presentation })).toBe('call')
    expect(of({ type: 'track', tier: 'contact', fix: false })).toBe('track')
    expect(of({ type: 'track-index', side: 'east', next: 1, subjects: {} })).toBeNull()
    expect(of({ type: 'unit' }, 'other')).toBeNull()
    expect(() => of({ type: 'unit' })).toThrow()
  })
  test('the panel reads again when an Einsatz record or its lifecycle changes; another Pack\'s objects and an object\'s movement leave the key alone', () => {
    const record = { id: 'u1', packId: einsatzPackId, lifecycle: 'active', packData: { type: 'unit', phase: 'available' } } as unknown as OperationalObject
    const key = einsatzRecordsKey([record])
    expect(einsatzRecordsKey([{ ...record, spatial: { frame: { kind: 'wgs84' } } } as OperationalObject])).toBe(key)
    expect(einsatzRecordsKey([record, { ...record, id: 'w1', packId: 'weather' } as unknown as OperationalObject])).toBe(key)
    expect(einsatzRecordsKey([{ ...record, packData: { type: 'unit', phase: 'en-route' } } as unknown as OperationalObject])).not.toBe(key)
    expect(einsatzRecordsKey([{ ...record, lifecycle: 'inactive' } as OperationalObject])).not.toBe(key)
  })
})

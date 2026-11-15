import { geoPointFromLonLat, type CommandResult, type OperationalObject } from '../../../core/model/index.ts'
import type { PackMapTarget } from '../../../core/packs/protocol.ts'
import type { Actor } from '../../../core/simulation-runs/actors.ts'
import { routeGroundClick, routeObjectClick, type MapClickContext, type MapClickRoute, type MapTargetPanel } from '../../../ui/map-target-routing.ts'
import { einsatzPackId } from '../ids.ts'
import type { OrderWhen, Stop, UnitOrderInput } from '../order-schema.ts'
import type { Situation, SituationCall, UnitOptions } from '../situation/schema.ts'
import { einsatzPackView } from '../ui-pack.ts'
import { createEinsatzClient, type CommandOutcome, type EinsatzClient } from '../ui/einsatz-client.ts'
import {
  armedOrderWith,
  busyChoices,
  cardFor,
  currentJobOf,
  deliverToOrder,
  dispatchKindOf,
  movePromptText,
  overview,
  ownReceipt,
  panelLayoutKey,
  pinProposal,
  receiptsFromSituation,
  receiptUndoable,
  withReceipts,
  type ArmedOrder,
  type CardView,
  type OverviewView,
  type PinnedProposal,
  type Receipt,
} from '../ui/presenters.ts'
import {
  activationActs,
  initialSelection,
  reduceSelection,
  selectionChangeEvent,
  stopObjectId,
  type ClickedObject,
  type CurrentJob,
  type Selection,
  type SelectionEffect,
  type SelectionEvent,
  type SelectionState,
} from '../ui/selection.ts'
import { operator, type OpenRun } from './run-harness.ts'

/**
 * Test-only: a Dispatch panel screen on a real Run, built on the panel's own
 * pure modules: the selection table (`ui/selection.ts`) decides what each
 * click does, the presenters (`ui/presenters.ts`) what the card, lists and
 * receipts show, and the panel's client (`ui/einsatz-client.ts`) what is
 * read and sent, validated with the Capabilities' own schemas. It performs
 * the selection effects as `DispatchPanel.svelte` does: it reads the
 * situation after every action and Run step, an armed unit's options, the
 * call card's pinned proposal, and sends every order through the Run's
 * Capability path as the screen's actor. Map taps are routed as the World
 * surface routes them with the panel open (`ui/map-target-routing.ts`,
 * the Pack's own targeting), so a tap selects, or reaches the panel as a
 * map target, or does nothing, exactly as in the browser.
 *
 * It counts operator actions: each map tap, ground tap, row tap, card or
 * footer button and map prompt option is one, whether or not it acts. The
 * wall clock is the test's own: every action comes `paceMs` after the
 * previous one, as a person's do, unless a test gives its own gap, so the
 * panel's double-click guard (`activationActs`) is exercised exactly.
 * Production code never imports this file.
 */

export interface ScreenCall {
  readonly capabilityId: string
  readonly input: unknown
  readonly result: CommandResult
}

/** A button of the selection block's card or of the footer, by what it does. */
export type CardControl =
  /** The unit card's "Dispatch A4…". */
  | { readonly kind: 'arm' }
  | { readonly kind: 'add-stop' }
  | { readonly kind: 'recall' }
  | { readonly kind: 'undo-last' }
  | { readonly kind: 'remove-stop'; readonly stopId: string }
  /** A row of the armed card's target list, by the object it names. */
  | { readonly kind: 'target-row'; readonly objectId: string }
  /** A busy choice in the armed card's slot. */
  | { readonly kind: 'busy'; readonly choice: OrderWhen }
  /** The call card's Dispatch. */
  | { readonly kind: 'dispatch' }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'chip'; readonly unitId: string }
  | { readonly kind: 'alternative'; readonly unitId: string }
  /** A Deliver-to chip of the call card or the unit card. */
  | { readonly kind: 'deliver-to'; readonly siteId: string }
  | { readonly kind: 'close' }
  | { readonly kind: 'confirm-close' }
  | { readonly kind: 'site-toggle' }
  | { readonly kind: 'back' }
  /** The newest receipt's Undo. */
  | { readonly kind: 'receipt-undo' }

export interface CardScreen {
  readonly actor: Actor
  /** Operator actions so far. */
  readonly actions: () => number
  readonly resetActions: () => void
  /** Every command this screen sent, with the Run's answer. */
  readonly calls: ReadonlyArray<ScreenCall>
  readonly situation: () => Situation
  readonly selection: () => Selection
  readonly card: () => CardView | null
  readonly lists: () => OverviewView
  readonly receipts: () => ReadonlyArray<Receipt>
  /** The refusal or failure the panel reports outside a target. */
  readonly feedback: () => string | null
  /** The map prompt the panel shows, as its options' labels; null while none. */
  readonly prompt: () => ReadonlyArray<string> | null
  /** The object the map selects. */
  readonly mapSelection: () => string | null
  /** Reads the situation again, and an armed unit's options: a data revision. */
  readonly sync: () => Promise<void>
  readonly mapTap: (objectId: string, gapMs?: number) => Promise<void>
  readonly groundTap: (position: readonly [number, number], gapMs?: number) => Promise<void>
  /** A tap on a row of the Overview lists. */
  readonly row: (object: ClickedObject, gapMs?: number) => Promise<void>
  readonly press: (control: CardControl, gapMs?: number) => Promise<void>
  /** A tap on an option of the map prompt, by its index. */
  readonly promptTap: (index: number, gapMs?: number) => Promise<void>
  /** Lets wall time pass, as the panel's ticker does. */
  readonly wait: (ms: number) => void
}

/** The gap a person leaves between two actions, comfortably past the double-click interval. */
export const paceMs = 700

const panel: MapTargetPanel = {
  label: 'Dispatch',
  packId: einsatzPackId,
  // The harness follows the routes itself; the surface only needs to know the panel connected.
  onMapTarget: () => { throw new Error('The card harness follows map routes itself') },
  previewMapTarget: null,
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const sameStop = (a: Stop, b: Stop): boolean => JSON.stringify(a) === JSON.stringify(b)

export const openCardScreen = async (run: OpenRun, options: { readonly actor?: Actor } = {}): Promise<CardScreen> => {
  const actor = options.actor ?? operator
  const calls: ScreenCall[] = []
  const client: EinsatzClient = createEinsatzClient({
    query: async (capabilityId, input) => await run.query<unknown>(capabilityId, input, actor),
    invoke: async (capabilityId, input) => {
      const outcome = await run.run.invokeCapability(actor, { capabilityId, input })
      if (outcome.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
      calls.push({ capabilityId, input, result: outcome.result })
      return { kind: 'command', result: outcome.result, replayed: false }
    },
  })

  let wallMs = 1_000_000
  let actions = 0
  let situation: Situation | null = null
  let selection: SelectionState = initialSelection
  let unitOptions: UnitOptions | null = null
  let armedOrder: ArmedOrder | null = null
  let pinned: PinnedProposal | null = null
  let opened: ReadonlySet<string> = new Set()
  let lastSeenCall: SituationCall | null = null
  let receipts: ReadonlyArray<Receipt> = []
  let feedback: string | null = null
  let confirming: string | null = null
  let mapSelection: string | null = null
  let quietFromMs: number | null = null
  let layoutKey: string | null = null

  const objects = (): ReadonlyArray<OperationalObject> => run.run.snapshot().objects
  const kindOf = (objectId: string) => {
    const object = objects().find(entry => entry.id === objectId)
    return object === undefined ? null : dispatchKindOf(object)
  }
  const shown = (): Situation => {
    if (situation === null) throw new Error('The screen has read no situation yet')
    return situation
  }
  const currentCard = (): CardView | null => cardFor(shown(), selection.selection, { options: unitOptions, armedOrder, pinned, opened, lastSeenCall, elapsedS: 0 })
  const currentLists = (): OverviewView => overview(shown(), selection.selection, opened, 0)

  /** A change of what stands where re-arms the double-click guard, as the panel's layout effect does. */
  const noteLayout = (): void => {
    if (situation === null) return
    const key = panelLayoutKey(currentCard(), currentLists(), receipts, confirming !== null)
    if (key !== layoutKey) quietFromMs = wallMs
    layoutKey = key
  }

  const readSituation = async (): Promise<void> => {
    const next = await client.situation()
    receipts = withReceipts(receipts, receiptsFromSituation(situation, next, wallMs))
    situation = next
    const current = selection.selection
    if (current.kind === 'call') lastSeenCall = next.calls.find(call => call.id === current.callId) ?? lastSeenCall
  }

  const readOptions = async (unitId: string): Promise<void> => {
    let answer: UnitOptions
    try {
      answer = await client.unitOptions(unitId)
    } catch (error) {
      feedback = messageOf(error)
      return
    }
    unitOptions = answer
    const armed = selection.selection
    if (armed.kind !== 'armed' || armed.unitId !== answer.unitId) return
    armedOrder = armedOrderWith(armedOrder, answer)
    await send({ kind: 'current-job', unitId: answer.unitId, job: currentJobOf(answer) })
  }

  const pin = async (callId: string): Promise<void> => {
    pinned = pinned !== null && pinned.callId === callId ? { ...pinned, refreshing: true } : null
    try {
      pinned = pinProposal(situation, callId, await client.recommend(callId))
    } catch (error) {
      if (pinned !== null && pinned.callId === callId) pinned = { ...pinned, refreshing: false }
      feedback = messageOf(error)
    }
  }

  const unitLabel = (unitId: string): string => situation?.units.find(unit => unit.id === unitId)?.label ?? unitId
  const stopLabel = (stop: Stop): string => {
    const listed = unitOptions?.targets.find(target => sameStop(target.target, stop))?.label
    if (listed !== undefined) return listed
    const id = stopObjectId(stop)
    return id === null ? 'the map point' : objects().find(object => object.id === id)?.label ?? id
  }

  const outcomeOf = async (send: () => Promise<CommandOutcome>): Promise<CommandOutcome> => {
    try {
      return await send()
    } catch (error) {
      return { ok: false, code: null, text: messageOf(error) }
    }
  }

  const submit = async (unitId: string, target: Stop, when: OrderWhen | null, drops: CurrentJob | null): Promise<void> => {
    const input: UnitOrderInput = { units: [unitId], stops: [target], ...(when === null ? {} : { when }), ...(drops === null ? {} : { drops: drops.taskId }) }
    const outcome = await outcomeOf(async () => await client.order(input))
    await send({ kind: 'result', unitId, target, outcome: outcome.ok ? { ok: true } : { ok: false, code: outcome.code, text: outcome.text }, atMs: wallMs })
    if (outcome.ok) {
      const dropped = drops === null ? null : `${drops.label}${drops.code === null ? '' : ` · ${drops.code}`}`
      receipts = withReceipts(receipts, [ownReceipt({ commandId: outcome.commandId, unitIds: [unitId], unitLabel: unitLabel(unitId), targetLabel: stopLabel(target), dropped, atMs: wallMs })])
    }
  }

  const command = async (run: () => Promise<CommandOutcome>, receipt: { readonly unitIds: ReadonlyArray<string>; readonly target: string } | null): Promise<void> => {
    feedback = null
    const outcome = await outcomeOf(run)
    if (!outcome.ok) {
      feedback = outcome.text
      return
    }
    if (receipt !== null) receipts = withReceipts(receipts, [ownReceipt({ commandId: outcome.commandId, unitIds: receipt.unitIds, unitLabel: receipt.unitIds.map(unitLabel).join(', '), targetLabel: receipt.target, dropped: null, atMs: wallMs })])
  }

  const order = async (input: UnitOrderInput): Promise<void> => {
    await command(async () => await client.order(input), { unitIds: input.units, target: input.stops.map(stopLabel).join(' → ') })
  }

  const perform = async (effect: SelectionEffect): Promise<void> => {
    switch (effect.kind) {
      case 'select':
        feedback = null
        confirming = null
        // The map takes the selection; the panel's selectedObjectId echo of it is no event.
        mapSelection = effect.objectId
        return
      case 'options':
        await readOptions(effect.unitId)
        return
      case 'recommend':
        opened = new Set([...opened, effect.callId])
        await pin(effect.callId)
        return
      case 'submit':
        await submit(effect.unitId, effect.target, effect.when, effect.drops)
        return
      case 'late-refusal':
        feedback = `${unitLabel(effect.unitId)} → ${stopLabel(effect.target)}: ${effect.text}`
        return
    }
  }

  async function send(event: SelectionEvent): Promise<void> {
    const stepped = reduceSelection(selection, event)
    const before = selection.selection
    selection = stepped.state
    const after = stepped.state.selection
    // The armed list's order holds while the same unit stays armed.
    if (!(after.kind === 'armed' && before.kind === 'armed' && before.unitId === after.unitId)) armedOrder = null
    for (const effect of stepped.effects) await perform(effect)
  }

  const sync = async (): Promise<void> => {
    await readSituation()
    const armed = selection.selection
    if (armed.kind === 'armed') await readOptions(armed.unitId)
    noteLayout()
  }

  /** An operator action at `gapMs` after the previous one. */
  const step = (gapMs: number): void => {
    wallMs += gapMs
    actions += 1
  }

  const mapClickContext = (): MapClickContext => {
    const all = objects()
    const selected = all.find(object => object.id === mapSelection) ?? null
    const context = { objects: all }
    const targeting = einsatzPackView.targeting
    return { controller: selected !== null && targeting.isController(selected) ? selected : null, selected, targeting, context, panel, closedMapTargetPanels: [], opensDisplay: () => false }
  }

  const onMapTarget = async (target: PackMapTarget): Promise<void> => {
    if (target.kind === 'point') return await send({ kind: 'click', on: { kind: 'ground', point: target.point }, atMs: wallMs })
    const kind = kindOf(target.objectId)
    if (kind === null) return
    await send({ kind: 'click', on: { id: target.objectId, kind }, atMs: wallMs })
  }

  /** What the World surface does with a routed map tap. */
  const follow = async (route: MapClickRoute): Promise<void> => {
    switch (route.kind) {
      case 'select': {
        mapSelection = route.objectId
        const event = selectionChangeEvent(selection, route.objectId, kindOf, wallMs)
        if (event !== null) await send(event)
        return
      }
      case 'panel':
        return await onMapTarget(route.target)
      case 'send':
      case 'openPanel':
      case 'display':
        throw new Error(`With the Dispatch panel open, a map tap on an Einsatz object never routes ${route.kind}`)
      case 'note':
      case 'none':
        return
    }
  }

  /** A card, row or footer command: it acts unless it is the second half of a double-click. */
  const guarded = async (run: () => Promise<void>): Promise<void> => {
    if (!activationActs(quietFromMs, wallMs)) return
    quietFromMs = wallMs
    await run()
  }

  const required = <T>(value: T | null | undefined, what: string): T => {
    if (value === null || value === undefined) throw new Error(`The screen shows no ${what}: ${JSON.stringify(currentCard())}`)
    return value
  }

  const pressed = async (control: CardControl): Promise<void> => {
    const card = currentCard()
    if (control.kind === 'receipt-undo') {
      const receipt = required(receipts.find(entry => receiptUndoable(entry, wallMs)), 'receipt with Undo')
      for (const unitId of receipt.unitIds) await command(async () => await client.undo(unitId, receipt.commandId), null)
      return
    }
    if (control.kind === 'back') return await send({ kind: 'back' })
    if (card === null) throw new Error(`No card is open for ${control.kind}`)
    if (card.kind === 'unit') {
      const enabled = (button: { readonly enabled: boolean } | null, what: string): void => {
        if (button === null || !button.enabled) throw new Error(`${what} is not enabled on ${card.title}`)
      }
      switch (control.kind) {
        case 'arm': enabled(card.armed === null ? card.dispatch : null, 'Dispatch'); return await send({ kind: 'arm', unitId: card.id, when: null })
        case 'add-stop': enabled(card.armed === null ? card.addStop : null, 'Add stop'); return await send({ kind: 'arm', unitId: card.id, when: 'after' })
        case 'recall': enabled(card.recall, 'Return'); return await command(async () => await client.recall(card.id), { unitIds: [card.id], target: shown().words.return })
        case 'undo-last': enabled(card.undo, 'Undo'); return await command(async () => await client.undo(card.id, required(card.undo.commandId, 'order to undo')), null)
        case 'remove-stop': return await command(async () => await client.removeStop(card.id, control.stopId), null)
        case 'target-row': {
          const row = required(card.armed?.rows.find(entry => stopObjectId(entry.target) === control.objectId), `target row for ${control.objectId}`)
          return await send({ kind: 'target-row', target: row.target })
        }
        case 'busy': {
          if (card.armed?.slot.kind !== 'busy') throw new Error(`${card.title} offers no busy choice`)
          return await send({ kind: 'prompt', choice: control.choice })
        }
        case 'deliver-to': {
          const unit = required(shown().units.find(entry => entry.id === card.id), 'unit')
          required(card.armed === null ? card.deliverTo.find(site => site.siteId === control.siteId) : null, `Deliver-to chip for ${control.siteId}`)
          return await order(deliverToOrder(unit, control.siteId))
        }
        default: throw new Error(`A unit card has no ${control.kind}`)
      }
    }
    if (card.kind === 'call') {
      const proposal = card.proposal
      switch (control.kind) {
        case 'dispatch': {
          if (!proposal.button.enabled || proposal.order === null) throw new Error(`Dispatch is not enabled on ${card.label}: ${proposal.button.reason}`)
          return await order(proposal.order)
        }
        case 'refresh': {
          if (!proposal.refresh.enabled) throw new Error(`Refresh is not enabled on ${card.label}`)
          return await pin(card.id)
        }
        case 'chip': {
          const current = required(pinned, 'pinned proposal')
          const dropped = new Set(current.dropped)
          if (dropped.has(control.unitId)) dropped.delete(control.unitId)
          else dropped.add(control.unitId)
          pinned = { ...current, dropped }
          return
        }
        case 'alternative': {
          const unit = required(card.alternatives.flatMap(entry => entry.units).find(entry => entry.unitId === control.unitId), `alternative ${control.unitId}`)
          return await order(unit.order)
        }
        case 'deliver-to': {
          const chip = required(card.deliverTo.filter(entry => entry.enabled).flatMap(entry => entry.sites).find(site => site.siteId === control.siteId), `live Deliver-to chip for ${control.siteId}`)
          return await order(chip.order)
        }
        case 'close':
          if (confirming === card.id) return
          confirming = card.id
          return
        case 'confirm-close':
          if (confirming !== card.id) throw new Error(`Close of ${card.label} asks no confirm`)
          confirming = null
          return await command(async () => await client.closeTask(card.id), null)
        default: throw new Error(`A call card has no ${control.kind}`)
      }
    }
    if (card.kind === 'site' && control.kind === 'site-toggle') {
      const receiving = required(card.receiving, `Accepting toggle on ${card.title}`)
      return await command(async () => await client.setSite(card.id, receiving.toggle.accepting), null)
    }
    throw new Error(`A ${card.kind} card has no ${control.kind}`)
  }

  const promptOf = (): { readonly labels: ReadonlyArray<string>; readonly choices: ReadonlyArray<'move' | OrderWhen> } | null => {
    const armed = selection.selection
    if (armed.kind !== 'armed' || armed.prompt === null || situation === null) return null
    if (armed.prompt.kind === 'move') return { labels: [movePromptText(situation, armed.unitId)], choices: ['move'] }
    if (armed.prompt.job === null) return null
    const choices = busyChoices(armed.prompt.job)
    return { labels: [choices.after, choices.now], choices: ['after', 'now'] }
  }

  await sync()
  return {
    actor,
    actions: () => actions,
    resetActions: () => { actions = 0 },
    calls,
    situation: shown,
    selection: () => selection.selection,
    card: currentCard,
    lists: currentLists,
    receipts: () => receipts,
    feedback: () => feedback,
    prompt: () => promptOf()?.labels ?? null,
    mapSelection: () => mapSelection,
    sync,
    mapTap: async (objectId, gapMs = paceMs) => {
      step(gapMs)
      const object = objects().find(entry => entry.id === objectId)
      if (object === undefined) throw new Error(`The map shows no ${objectId}`)
      await follow(routeObjectClick(object, mapClickContext()))
      await sync()
    },
    groundTap: async (position, gapMs = paceMs) => {
      step(gapMs)
      await follow(routeGroundClick(geoPointFromLonLat(position[0], position[1]), mapClickContext()))
      await sync()
    },
    row: async (object, gapMs = paceMs) => {
      step(gapMs)
      await guarded(async () => await send({ kind: 'click', on: object, atMs: wallMs }))
      await sync()
    },
    press: async (control, gapMs = paceMs) => {
      step(gapMs)
      await guarded(async () => await pressed(control))
      await sync()
    },
    promptTap: async (index, gapMs = paceMs) => {
      step(gapMs)
      const prompt = promptOf()
      if (prompt === null) throw new Error('The map shows no prompt')
      const choice = prompt.choices[index]
      if (choice === undefined) throw new Error(`The map prompt has no option ${index}`)
      await send({ kind: 'prompt', choice })
      await sync()
    },
    wait: ms => {
      wallMs += ms
      void send({ kind: 'tick', atMs: wallMs })
    },
  }
}

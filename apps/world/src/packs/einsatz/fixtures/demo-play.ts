import type { OperationalObject } from '../../../core/model/index.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import type { EinsatzConfig } from '../config-schema.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import type { TaskData, UnitData } from '../engine/model.ts'
import type { SituationCall, UnitOptions } from '../situation/schema.ts'
import { einsatzPackId } from '../ids.ts'
import { isUnserved, slowedRouting } from './border-demo.ts'
import { openCardScreen, type CardScreen } from './card-harness.ts'
import { openRun, type OpenRun } from './run-harness.ts'

/**
 * Test-only: plays a demo Scenario Definition headless on a real Run, in
 * fixed steps of Run time, by a dispatcher at a Dispatch panel screen
 * (`card-harness.ts`): every order is given by the panel's own clicks and
 * counted. The good dispatcher takes each call it should in the list's
 * order, opens its card and taps its Dispatch, the 2-click path, while the
 * suggestion holds; at a beat it gives the beat's order by the taps the
 * beat names. The play logs what the demo's objectives are judged on.
 * Calls, units and places are found by the Run's objects, by when a cue
 * created them and where they stand, never by a type or template name.
 * Production code never imports this file.
 */

export { slowedRouting }

/** What a beat's taps read: the Run as the screen sees it, at the step the beat falls due. */
export interface BeatContext {
  readonly nowS: number
  readonly run: OpenRun
  readonly screen: CardScreen
  /** The calls a cue created at this Run second, in the order the Run holds them: the order the cues created them. */
  readonly callsCreatedAt: (atS: number) => ReadonlyArray<OperationalObject>
  readonly units: () => ReadonlyArray<OperationalObject>
}

/** A good dispatcher's planned move at a beat: the taps it makes at `atS`, besides taking the suggestions. */
export interface Beat {
  readonly name: string
  readonly atS: number
  readonly tap: (context: BeatContext) => Promise<void>
}

export type Policy =
  /** Never acts. */
  | { readonly kind: 'nothing' }
  /**
   * Takes the suggestion of each unserved call, in list order, as it
   * arrives and until the call is served, leaving a call alone that a unit
   * holds as a queued stop. Where no free unit can help, it diverts the
   * nearest unit on its way to a call of lower priority that can serve this
   * one: the suggestions propose free units only, so a divert is always the
   * dispatcher's own move. At each beat it first makes the beat's taps.
   */
  | { readonly kind: 'recommendations'; readonly beats: ReadonlyArray<Beat> }

export interface CallLog {
  readonly id: string
  readonly label: string
  readonly template: string
  readonly priority: string
  readonly createdS: number
  /** When a unit first stood on scene there (on task), to the step. */
  firstOnSceneS?: number
  closedS?: number
  /** Units seen on task there. */
  readonly onScene: Set<string>
}

export interface OrderLog {
  readonly atS: number
  /** The move it belongs to: a suggestion taken, a divert, or a beat by its name. */
  readonly move: 'suggestion' | 'divert' | 'beat'
  readonly beat?: string
  readonly capabilityId: string
  readonly input: unknown
  readonly ok: boolean
  /** A refusal's code, as the result sets it. */
  readonly code?: string
  readonly reason?: string
  /** The clicks of the move it belongs to, every order of it included: a suggestion is the call's row and its Dispatch; a divert that row, then the busy unit's 4 clicks; a beat its taps. */
  readonly clicks: number
}

export interface PlayLog {
  readonly calls: ReadonlyArray<CallLog>
  readonly orders: ReadonlyArray<OrderLog>
  readonly run: OpenRun
}

const isTask = (data: unknown): data is TaskData => (data as { readonly type?: unknown }).type === 'task'
const isUnit = (data: unknown): data is UnitData => (data as { readonly type?: unknown }).type === 'unit'

/** The Einsatz configuration of a Definition. */
export const configOf = (definition: unknown): EinsatzConfig =>
  einsatzConfigSchema.parse((definition as { readonly packs: ReadonlyArray<{ readonly id: string; readonly config: unknown }> }).packs.find(pack => pack.id === einsatzPackId)!.config)

/** Metres between two points, flat at their mean latitude: enough to compare short distances in a town. */
export const metresBetween = (a: readonly [number, number], b: readonly [number, number]): number => {
  const meanLat = ((a[1] + b[1]) / 2) * Math.PI / 180
  return Math.hypot((b[0] - a[0]) * 111_320 * Math.cos(meanLat), (b[1] - a[1]) * 110_540)
}
export const lonLatOf = (object: OperationalObject): [number, number] => {
  const point = object.spatial.position?.point.coordinates
  if (point === undefined) throw new Error(`${object.id} stands nowhere`)
  return [point[0]!, point[1]!]
}

/** The calls the good dispatcher leaves alone: those a unit holds as a queued stop, which the unit takes next. */
const queuedCalls = (screen: CardScreen): ReadonlySet<string> =>
  new Set(screen.situation().units.flatMap(unit => unit.plan.flatMap(stop => stop.state === 'queued' && 'taskId' in stop.target ? [stop.target.taskId] : [])))

/**
 * Plays the Definition until `untilS` in `stepS` steps by one dispatcher at
 * a Dispatch panel screen, with its policy. The dispatcher reacts `reactS`
 * after each call arrives, as a person at an iPad does: it acts on a call,
 * and makes a beat's taps, only once that long has passed since the call
 * or the beat.
 */
export const playDemo = async (options: {
  readonly definition: unknown
  readonly policy: Policy
  readonly untilS: number
  readonly stepS?: number
  readonly reactS?: number
  readonly routing?: RoutingAdapter
}): Promise<PlayLog> => {
  const stepS = options.stepS ?? 5
  const reactS = options.reactS ?? 0
  const run = await openRun({ definition: options.definition, ...(options.routing === undefined ? {} : { routing: options.routing }) })
  const startMs = run.nowMs()
  const screen = await openCardScreen(run)
  const calls = new Map<string, CallLog>()
  const orders: OrderLog[] = []
  const beatsDone = new Set<string>()
  const nowS = () => Math.round((run.nowMs() - startMs) / 1_000)
  const objects = () => run.run.snapshot().objects.filter(object => object.packId === einsatzPackId)
  const secondsOf = (ms: number) => Math.round((ms - startMs) / 1_000)

  /** Logs the orders a move of the dispatcher gave since it began, each with the move's clicks. */
  const logMove = (kind: OrderLog['move'], beat: string | undefined, since: { readonly clicks: number; readonly sent: number }): void => {
    const clicks = screen.actions() - since.clicks
    const sentBefore = since.sent
    for (const call of screen.calls.slice(sentBefore)) {
      orders.push({
        atS: nowS(),
        move: kind,
        ...(beat === undefined ? {} : { beat }),
        capabilityId: call.capabilityId,
        input: call.input,
        ok: call.result.ok,
        ...(call.result.ok ? {} : { reason: call.result.reason, ...(call.result.code === undefined ? {} : { code: call.result.code }) }),
        clicks,
      })
    }
  }

  /** The nearest unit on its way to a call of lower priority whose options take this call; null when there is none. */
  const divertable = async (call: SituationCall): Promise<string | null> => {
    const situation = screen.situation()
    const rankOf = (taskId: string | undefined): number => situation.calls.find(entry => entry.id === taskId)?.priority.rank ?? -1
    const callObject = run.object(call.id)
    if (callObject === undefined) return null
    const candidates = objects().filter(object => isUnit(object.packData) && (object.packData.phase === 'en-route' || object.packData.phase === 'mobilizing') && rankOf(object.packData.taskId) > call.priority.rank)
      .sort((a, b) => metresBetween(lonLatOf(a), lonLatOf(callObject)) - metresBetween(lonLatOf(b), lonLatOf(callObject)))
    for (const unit of candidates) {
      const options = await run.query<UnitOptions>('world.einsatz.unit.options', { unitId: unit.id }, screen.actor)
      if (options.targets.some(target => 'taskId' in target.target && target.target.taskId === call.id && target.canReplace)) return unit.id
    }
    return null
  }

  /** Each unserved call in list order: its suggestion by its row and its Dispatch, or, where no free unit can help, a divert. */
  const takeSuggestions = async (): Promise<void> => {
    const tried = new Set<string>()
    for (let round = 0; round < 40; round++) {
      const queued = queuedCalls(screen)
      const call = screen.situation().calls.find(entry => !tried.has(entry.id) && isUnserved(entry) && !queued.has(entry.id) && entry.waitingS >= reactS)
      if (call === undefined) return
      tried.add(call.id)
      if (screen.selection().kind === 'unit') await screen.press({ kind: 'back' })
      const since = { clicks: screen.actions(), sent: screen.calls.length }
      await screen.row({ id: call.id, kind: 'call' })
      const card = screen.card()
      if (card?.kind !== 'call') continue
      if (card.proposal.button.enabled) {
        await screen.press({ kind: 'dispatch' })
        logMove('suggestion', undefined, since)
        continue
      }
      const unitId = await divertable(call)
      if (unitId === null) continue
      await screen.mapTap(unitId)
      await screen.mapTap(call.id)
      const decision = screen.decision()
      if (decision?.kind !== 'order' || !decision.replace) throw new Error(`No replacement for diverting ${unitId} to ${call.label}: ${screen.feedback() ?? JSON.stringify(screen.card())}`)
      await screen.decide('replace')
      logMove('divert', undefined, since)
    }
  }

  const observe = (): void => {
    const all = objects()
    for (const object of all) {
      const data = object.packData
      if (!isTask(data)) continue
      const call = calls.get(object.id) ?? { id: object.id, label: object.label, template: data.template, priority: data.priority, createdS: secondsOf(data.createdAtMs), onScene: new Set<string>() }
      calls.set(object.id, call)
      const here = all.filter(entry => isUnit(entry.packData) && entry.packData.taskId === object.id && entry.packData.phase === 'on-task')
      for (const unit of here) call.onScene.add(unit.id)
      if (call.firstOnSceneS === undefined && (here.length > 0 || Object.keys(data.pickedUp).length > 0 || Object.keys(data.served).length > 0)) call.firstOnSceneS = nowS()
      if (call.closedS === undefined && data.closedAtMs !== undefined) call.closedS = secondsOf(data.closedAtMs)
    }
  }

  const dispatch = async (): Promise<void> => {
    const policy = options.policy
    if (policy.kind === 'nothing') return
    const context: BeatContext = {
      nowS: nowS(),
      run,
      screen,
      callsCreatedAt: atS => objects().filter(object => isTask(object.packData) && secondsOf(object.packData.createdAtMs) === atS),
      units: () => objects().filter(object => isUnit(object.packData)),
    }
    for (const beat of policy.beats) {
      if (beatsDone.has(beat.name) || beat.atS + reactS > nowS()) continue
      beatsDone.add(beat.name)
      const since = { clicks: screen.actions(), sent: screen.calls.length }
      await beat.tap(context)
      logMove('beat', beat.name, since)
    }
    await takeSuggestions()
  }

  observe()
  while (nowS() < options.untilS) {
    await screen.sync()
    await dispatch()
    observe()
    run.forward(stepS * 1_000)
    await run.settle()
    observe()
  }
  return { calls: [...calls.values()], orders, run }
}

/**
 * A beat: when a call arrives that a busy unit already on scene could serve
 * next, give it to the nearest such unit in three clicks: the unit, the
 * call, then "Add to plan".
 */
export const afterNearestBusy = (name: string, atS: number): Beat => ({
  name,
  atS,
  tap: async ({ run, screen, callsCreatedAt, units }) => {
    const [call] = callsCreatedAt(atS)
    if (call === undefined) throw new Error(`${name}: no call arrived at ${atS} s`)
    const answer = await run.query<{ readonly whyNot: ReadonlyArray<{ readonly unitId: string }> }>('world.einsatz.recommend', { taskId: call.id }, screen.actor)
    const able = new Set(answer.whyNot.map(entry => entry.unitId))
    const nearest = units().filter(unit => able.has(unit.id) && isUnit(unit.packData) && unit.packData.phase === 'on-task')
      .sort((a, b) => metresBetween(lonLatOf(a), lonLatOf(call)) - metresBetween(lonLatOf(b), lonLatOf(call)))[0]
    if (nearest === undefined) throw new Error(`${name}: no busy unit on scene could serve ${call.label}`)
    await screen.mapTap(nearest.id)
    await screen.mapTap(call.id)
    const decision = screen.decision()
    if (decision?.kind !== 'order' || !decision.add) throw new Error(`${name}: ${nearest.label} cannot add ${call.label}: ${screen.feedback() ?? JSON.stringify(screen.card())}`)
    await screen.decide('add')
  },
})

/**
 * A beat: when two calls arrive together, give both to the unit suggested
 * for the first, in one plan. Four clicks: the unit, the first call, the
 * second call, then "Add to plan".
 */
export const bothToOne = (name: string, atS: number): Beat => ({
  name,
  atS,
  tap: async ({ run, screen, callsCreatedAt }) => {
    const [first, second] = callsCreatedAt(atS)
    if (first === undefined || second === undefined) throw new Error(`${name}: two calls should arrive at ${atS} s`)
    const answer = await run.query<{ readonly proposal: { readonly units: ReadonlyArray<{ readonly unitId: string }> } | null }>('world.einsatz.recommend', { taskId: first.id }, screen.actor)
    const unitId = answer.proposal?.units[0]?.unitId
    if (unitId === undefined) throw new Error(`${name}: no unit is suggested for ${first.label}`)
    await screen.mapTap(unitId)
    await screen.mapTap(first.id)
    await screen.mapTap(second.id)
    await screen.decide('add')
  },
})

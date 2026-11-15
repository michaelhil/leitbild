import type { SimulationRunId } from '../../../core/model/index.ts'
import { missingArtworkMessage } from '../../../ui/map-runtime/catalogue-symbol-atlas.ts'
import { invokeSimulationRunCapability, querySimulationRunCapability } from '../../../ui/simulation-run-client.ts'
import type { CapabilityInvocationResponse } from '../../../ui/types.ts'
import type { EinsatzCommandId, einsatzQueryIds } from '../capabilities.ts'
import { unitOrderInputSchema, unitRecallInputSchema, unitStopRemoveInputSchema, unitUndoInputSchema, type UnitOrderInput } from '../order-schema.ts'
import { recommendAnswerSchema, type RecommendAnswer } from '../recommendation-schema.ts'
import { refusalText } from './presenters.ts'
import { situationInputSchema, situationSchema, unitOptionsInputSchema, unitOptionsSchema, type Situation, type UnitOptions } from '../situation/schema.ts'

/**
 * The Dispatch panel's calls to its Run, through the World-direct run-scoped
 * invoke, which carries the screen's role set (never the Host broker, which
 * carries none). Every input is validated with the schema its Capability
 * declares before it is sent, and every answer when it arrives.
 *
 * - `situation` on open and on each data revision; `unitOptions` when a
 *   unit is armed and on each data revision while it stays armed;
 *   `recommend` once when a call card opens (the pinned proposal) and on
 *   Refresh.
 * - Commands resolve with their outcome: accepted with its `commandId`, or
 *   refused with the refusal's `code` and message, which the panel shows at
 *   the target or in the card. A failed request rejects.
 */

type EinsatzQueryId = typeof einsatzQueryIds[keyof typeof einsatzQueryIds]

/** The Capability ids the panel calls. The Capabilities module pulls in the engine, so the panel names the ids itself; their types tie them to the Capabilities, so a renamed id fails to compile. */
export const dispatchQueryIds = {
  situation: 'world.einsatz.situation',
  unitOptions: 'world.einsatz.unit.options',
  recommend: 'world.einsatz.recommend',
} as const satisfies Readonly<Record<string, EinsatzQueryId>>

export const dispatchCommandIds = {
  order: 'world.einsatz.unit.order',
  undo: 'world.einsatz.unit.undo',
  stopRemove: 'world.einsatz.unit.stop.remove',
  recall: 'world.einsatz.unit.recall',
  taskClose: 'world.einsatz.task.close',
  siteSet: 'world.einsatz.site.set',
} as const satisfies Readonly<Record<string, EinsatzCommandId>>

export type DispatchCommandId = typeof dispatchCommandIds[keyof typeof dispatchCommandIds]

export type CommandOutcome =
  | { readonly ok: true; readonly commandId: string }
  /** `code` is the code the refused result sets; null for one that sets none (a core gate's). */
  | { readonly ok: false; readonly code: string | null; readonly text: string }

export interface EinsatzClient {
  readonly situation: () => Promise<Situation>
  readonly unitOptions: (unitId: string) => Promise<UnitOptions>
  readonly recommend: (taskId: string) => Promise<RecommendAnswer>
  readonly order: (input: UnitOrderInput) => Promise<CommandOutcome>
  readonly undo: (unitId: string, commandId: string) => Promise<CommandOutcome>
  readonly removeStop: (unitId: string, stopId: string) => Promise<CommandOutcome>
  readonly recall: (unitId: string) => Promise<CommandOutcome>
  readonly closeTask: (taskId: string) => Promise<CommandOutcome>
  readonly setSite: (siteId: string, accepting: boolean) => Promise<CommandOutcome>
}

export interface EinsatzClientPorts {
  readonly query: (capabilityId: EinsatzQueryId, input: unknown) => Promise<unknown>
  readonly invoke: (capabilityId: DispatchCommandId, input: unknown) => Promise<CapabilityInvocationResponse>
}

/** A refused result's code, which the result itself sets (null for a refusal that sets none, a core gate's), and its message without the code. */
export const refusalOf = (result: { readonly reason: string; readonly code?: string }): { readonly code: string | null; readonly text: string } =>
  ({ code: result.code ?? null, text: refusalText(result.reason) })

export const createEinsatzClient = (ports: EinsatzClientPorts): EinsatzClient => {
  const command = async (capabilityId: DispatchCommandId, input: unknown): Promise<CommandOutcome> => {
    const answer = await ports.invoke(capabilityId, input)
    if (answer.kind !== 'command') throw new Error(`${capabilityId} answered as a ${answer.kind}, not a command`)
    const result = answer.result
    return result.ok ? { ok: true, commandId: result.commandId } : { ok: false, ...refusalOf(result) }
  }
  return {
    situation: async () => situationSchema.parse(await ports.query(dispatchQueryIds.situation, situationInputSchema.parse({}))),
    unitOptions: async unitId => unitOptionsSchema.parse(await ports.query(dispatchQueryIds.unitOptions, unitOptionsInputSchema.parse({ unitId }))),
    recommend: async taskId => recommendAnswerSchema.parse(await ports.query(dispatchQueryIds.recommend, { taskId })),
    order: async input => await command(dispatchCommandIds.order, unitOrderInputSchema.parse(input)),
    undo: async (unitId, commandId) => await command(dispatchCommandIds.undo, unitUndoInputSchema.parse({ unitId, commandId })),
    removeStop: async (unitId, stopId) => await command(dispatchCommandIds.stopRemove, unitStopRemoveInputSchema.parse({ unitId, stopId })),
    recall: async unitId => await command(dispatchCommandIds.recall, unitRecallInputSchema.parse({ unitId })),
    closeTask: async taskId => await command(dispatchCommandIds.taskClose, { taskId }),
    setSite: async (siteId, accepting) => await command(dispatchCommandIds.siteSet, { siteId, accepting }),
  }
}

/** The client of one Run, as this screen. */
export const runEinsatzClient = (simulationRunId: SimulationRunId): EinsatzClient => createEinsatzClient({
  query: async (capabilityId, input) => await querySimulationRunCapability<unknown>(simulationRunId, capabilityId, input),
  invoke: async (capabilityId, input) => await invokeSimulationRunCapability(simulationRunId, { capabilityId, input }),
})

// ——— Icons ———

/**
 * The catalogue artwork the panel draws beside its rows and cards: the same
 * icons the map draws, loaded on demand through the map symbol Capability.
 * Each id is asked for once; one that does not load is reported and never
 * asked again.
 */
export interface IconCache {
  readonly request: (ids: Iterable<string>) => void
  readonly svg: (id: string) => string | undefined
  /** "No map artwork for icon: …", or null when none is missing. */
  readonly missing: () => string | null
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const createIconCache = (ports: { readonly load: (ids: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>; readonly changed: () => void }): IconCache => {
  const artwork = new Map<string, string>()
  const loading = new Set<string>()
  const failed = new Map<string, string | undefined>()
  const load = async (ids: ReadonlyArray<string>): Promise<void> => {
    try {
      const loaded = await ports.load(ids)
      for (const id of ids) {
        const svg = loaded.get(id)
        if (svg === undefined) failed.set(id, undefined)
        else artwork.set(id, svg)
      }
    } catch (error) {
      for (const id of ids) failed.set(id, messageOf(error))
    } finally {
      for (const id of ids) loading.delete(id)
    }
    ports.changed()
  }
  return {
    request: ids => {
      const wanted = [...new Set(ids)].filter(id => !artwork.has(id) && !loading.has(id) && !failed.has(id))
      if (wanted.length === 0) return
      for (const id of wanted) loading.add(id)
      void load(wanted)
    },
    svg: id => artwork.get(id),
    missing: () => {
      if (failed.size === 0) return null
      const causes = [...new Set([...failed.values()].filter((cause): cause is string => cause !== undefined))]
      return missingArtworkMessage([...failed.keys()].sort(), causes.length === 0 ? undefined : causes.join('; '))
    },
  }
}

/** Every icon a situation draws. */
export const situationIconIds = (situation: Situation): ReadonlyArray<string> =>
  [...new Set([...situation.calls.map(call => call.icon), ...situation.units.map(unit => unit.icon), ...situation.sites.map(site => site.icon)])]

/** An SVG document as an image source; an image never runs what it holds. */
export const svgImageSource = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

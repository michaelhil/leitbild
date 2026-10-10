import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { composedDisplayLayout } from './composition.ts'
import { textWidth, unmeasurable } from './mimic/text-metrics.ts'

// The Plant's annunciator systems as its I&C config declares them, in their
// declared order, each with the rules whose alarms and trips name it: the
// first level an overview summarises its alarms by. The config guarantees
// that every alarm names exactly one declared system, so a quiet tile is a
// quiet system.

export interface AnnunciatorSystem {
  readonly id: string
  /** As operators name it ("Reactor coolant system"). */
  readonly name: string
  /** What its tile says at the display's tile width: the name, or the declared short label where the name does not fit. Never cut. */
  readonly label: string
  /** The rules whose alarms or trips it annunciates. */
  readonly ruleIds: ReadonlyArray<string>
}

export type AnnunciatorSystemsResult =
  | { readonly ok: true; readonly systems: ReadonlyArray<AnnunciatorSystem> }
  | { readonly ok: false; readonly issues: ReadonlyArray<string> }

const fits = (text: string, room: number): boolean => unmeasurable('tag', text).length === 0 && textWidth('tag', text) <= room

/** The declared systems with what each tile says at a tile width (composedDisplayLayout.annunciatorTile.widths). */
export const annunciatorSystems = (plant: CompiledProcessPlant, tileWidth: number): AnnunciatorSystemsResult => {
  const ruleIds = new Map<string, string[]>()
  for (const rule of plant.automation.rules) {
    if (!rule.enabled) continue
    const systems = new Set(rule.effects.flatMap(effect => (effect.type === 'alarm.enter' || effect.type === 'trip.enter') && effect.annunciator?.system !== undefined ? [effect.annunciator.system] : []))
    for (const system of systems) ruleIds.set(system, [...(ruleIds.get(system) ?? []), rule.id])
  }
  const room = tileWidth - composedDisplayLayout.annunciatorTile.inset
  const issues: string[] = []
  const systems = plant.automation.annunciatorSystems.map(system => {
    const label = [system.label, system.shortLabel].find((candidate): candidate is string => candidate !== undefined && fits(candidate, room))
    if (label === undefined) issues.push(`annunciator system ${system.id}: neither "${system.label}" nor its short label${system.shortLabel === undefined ? ' (none declared)' : ` "${system.shortLabel}"`} fits a tile ${room} px wide; declare a short label that does`)
    return { id: system.id, name: system.label, label: label ?? system.label, ruleIds: ruleIds.get(system.id) ?? [] }
  })
  return issues.length > 0 ? { ok: false, issues } : { ok: true, systems }
}

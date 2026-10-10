import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { composedDisplayLayout } from './composition.ts'
import { textWidth, unmeasurable } from './mimic/text-metrics.ts'

// The Plant's annunciator systems, as its I&C rules declare them on each
// alarm and trip ("steam generators", "electrical"): the first level an
// overview summarises its alarms by. Systems keep the order the model first
// declares them in, so their tiles never move as alarms come and go.

export interface AnnunciatorSystem {
  /** As the model declares it. */
  readonly name: string
  /**
   * What its tile says: the name with a capital, or its initials ("RCS")
   * where the name does not fit a tile at its least width. Text is never cut.
   */
  readonly label: string
  /** The rules whose alarms or trips it annunciates. */
  readonly ruleIds: ReadonlyArray<string>
}

export type AnnunciatorSystemsResult =
  | { readonly ok: true; readonly systems: ReadonlyArray<AnnunciatorSystem> }
  | { readonly ok: false; readonly issues: ReadonlyArray<string> }

const capitalised = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`
const initials = (name: string): string => name.split(/\s+/).filter(word => word.length > 0).map(word => word.charAt(0).toUpperCase()).join('')

/**
 * Every declared system with its rules. A tile that looks quiet must be
 * quiet, so either every alarm and trip names its system, or none does (the
 * Plant then has no tiles), and no rule annunciates on two systems.
 */
export const annunciatorSystems = (plant: CompiledProcessPlant): AnnunciatorSystemsResult => {
  const systems = new Map<string, string[]>()
  const unnamed: string[] = []
  const spanning: string[] = []
  for (const rule of plant.automation.rules) {
    if (!rule.enabled) continue
    const effects = rule.effects.filter(effect => effect.type === 'alarm.enter' || effect.type === 'trip.enter')
    const names = [...new Set(effects.flatMap(effect => effect.annunciator?.system ?? []))]
    if (effects.some(effect => effect.annunciator?.system === undefined)) unnamed.push(rule.id)
    if (names.length > 1) spanning.push(`${rule.id} (${names.join(', ')})`)
    for (const name of names) systems.set(name, [...(systems.get(name) ?? []), rule.id])
  }
  if (systems.size === 0) return { ok: true, systems: [] }
  const issues = [
    ...(unnamed.length === 0 ? [] : [`alarms of ${unnamed.join(', ')} name no annunciator system, so a system's tile could look quiet while they are active`]),
    ...(spanning.length === 0 ? [] : [`rules annunciate on more than one system: ${spanning.join('; ')}`]),
  ]
  const tile = composedDisplayLayout.annunciatorTile
  const room = tile.width - tile.inset
  const labelled = [...systems].map(([name, ruleIds]) => {
    const label = [capitalised(name), initials(name)].find(candidate => unmeasurable('tag', candidate).length === 0 && textWidth('tag', candidate) <= room)
    if (label === undefined) issues.push(`the annunciator system "${name}" cannot be named on a tile ${room} px wide`)
    return { name, label: label ?? name, ruleIds }
  })
  return issues.length > 0 ? { ok: false, issues } : { ok: true, systems: labelled }
}

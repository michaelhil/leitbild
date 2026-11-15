import { z } from 'zod'
import type { roeModes } from './config-schema.ts'

/** The closed phase set of a unit. Integrity (healthy, damaged, destroyed) is separate state. */
export const unitPhases = ['available', 'mobilizing', 'en-route', 'on-task', 'transporting', 'at-site', 'returning', 'holding', 'destroyed'] as const
export type UnitPhase = typeof unitPhases[number]

/** Words a unit type may set for its own units: its phases. */
export const unitLexiconKeys = [...unitPhases] as const
/**
 * Words of the dispatch surface, which only the whole configuration sets:
 * the headings of the calls, units and sites lists and what an empty list
 * says; the verbs for sending units to a target (`send`), sending a unit
 * back to base (`return`), sending it to a map point (`move`) and closing a
 * task (`close`); the words for a unit's ordered stops (`plan`) and one of
 * them (`stop`). The track words name the Contacts section of combat
 * configurations: its heading and tiers, its groups and what it says while
 * empty.
 */
export const surfaceLexiconKeys = ['calls', 'units', 'sites', 'send', 'return', 'move', 'close', 'plan', 'stop', 'noCalls', 'noUnits'] as const
export const trackLexiconKeys = ['tracks', 'contact', 'identified', 'engageable', 'otherTracks', 'noTracks'] as const
export const lexiconKeys = [...surfaceLexiconKeys, ...trackLexiconKeys, ...unitLexiconKeys] as const

export type UnitLexiconKey = typeof unitLexiconKeys[number]
export type SurfaceLexiconKey = typeof surfaceLexiconKeys[number]
export type LexiconKey = typeof lexiconKeys[number]

/** Neutral wording used until a configuration words it otherwise; all domain words come from configuration. */
export const neutralLexicon: Readonly<Record<LexiconKey, string>> = {
  calls: 'Calls',
  units: 'Units',
  sites: 'Sites',
  send: 'Dispatch',
  return: 'Return to base',
  move: 'Move',
  close: 'Close call',
  plan: 'Plan',
  stop: 'Stop',
  noCalls: 'No calls waiting',
  noUnits: 'No units',
  tracks: 'Tracks',
  contact: 'Contact',
  identified: 'Identified',
  engageable: 'Engageable',
  otherTracks: 'Other',
  noTracks: 'None',
  available: 'Available',
  mobilizing: 'Mobilizing',
  'en-route': 'En route',
  'on-task': 'On task',
  transporting: 'Transporting',
  'at-site': 'At site',
  returning: 'Returning',
  holding: 'Holding',
  destroyed: 'Destroyed',
}

/** A unit's rules of engagement in neutral mechanism words, as the engine's log and the Contacts section name them. */
export const roeWords: Readonly<Record<typeof roeModes[number], string>> = {
  hold: 'weapons hold',
  'return-fire': 'return fire',
  free: 'weapons free',
}

const word = z.string().trim().min(1).max(120)
export const lexiconSchema = z.partialRecord(z.enum(lexiconKeys), word)
export const unitLexiconSchema = z.partialRecord(z.enum(unitLexiconKeys), word)
export type Lexicon = z.output<typeof lexiconSchema>
export type UnitLexicon = z.output<typeof unitLexiconSchema>

const isUnitKey = (key: LexiconKey): key is UnitLexiconKey => (unitLexiconKeys as ReadonlyArray<string>).includes(key)

/** A unit type's own word, else the configuration's, else the neutral one. */
export const wordFor = (lexicon: Lexicon, key: LexiconKey, unitLexicon?: UnitLexicon): string =>
  (unitLexicon !== undefined && isUnitKey(key) ? unitLexicon[key] : undefined) ?? lexicon[key] ?? neutralLexicon[key]

import { z } from 'zod'

/**
 * Einsatz refusal convention: every refusal reads `<code>: <message>`. The
 * code is stable and machine-readable, so tests and callers assert it; the
 * message is written in the configuration's own words. Command results reuse
 * this convention for `CommandResult.reason`.
 */

/** Refusals of a configuration that parses but cannot be run as written. */
export const configurationRefusalCodes = [
  'duplicate_id',
  'duplicate_code',
  'unknown_task_template',
  'unknown_load_class',
  'unknown_tag',
  'unknown_service',
  'unknown_property',
  'unknown_enum_value',
  'unknown_icon',
  'unknown_priority',
  'priorities_required',
  'stationary_type_not_site',
  'property_conflict',
  'property_kind_mismatch',
  'condition_out_of_range',
  'invalid_range',
  'default_out_of_range',
  'too_many_shown_properties',
  'refused_combination',
  'identify_exceeds_detect',
  'order_requires_component',
  'component_requires_order',
  'self_hostility',
] as const

export type ConfigurationRefusalCode = typeof configurationRefusalCodes[number]

/**
 * Refusals of a configuration against the Scenario it runs in: hostility
 * names declared sides, and the roles' labels fit `lastAction.by` and never
 * read as a standing order there. In a Scenario with sides, groups become
 * roles, so they need declared roles and name a declared side; without
 * sides a group names none. Only a declared group's own role has an id of
 * the form `group:<id>`.
 */
export const scenarioConfigRefusalCodes = [
  'unknown_side',
  'role_labels_too_long',
  'role_label_reserved',
  'group_side_required',
  'group_side_not_declared',
  'reserved_role_id',
] as const
export type ScenarioConfigRefusalCode = typeof scenarioConfigRefusalCodes[number]

/**
 * Refusals of an intent against the current engine state. Intents reuse the
 * configuration codes where the meaning is the same (an undeclared template,
 * load class, priority or property, a repeated id).
 */
export const engineRefusalCodes = [
  'unknown_unit_type',
  'not_in_picture',
  'not_a_site',
  'cross_side_reference',
  'side_required',
  'side_not_declared',
  'public_takes_no_side',
  'unit_committed',
  'unit_loaded',
  'unit_unavailable',
  'divert_from_higher_priority',
  'divert_after_arrival',
  'requirement_unmet',
  'requirement_covered',
  'task_closed',
  'site_not_accepting',
  'property_out_of_range',
  'routing_unavailable',
  'no_road_near_point',
  'no_effector',
  'track_not_engageable',
  'track_not_deletable',
  'reserved_id',
  'chain_full',
  'when_required',
  'drops_mismatch',
  'newer_order_exists',
  'nothing_to_undo',
  'step_not_found',
  'plan_changed',
  'group_required',
  'unknown_group',
  'group_not_declared',
  'group_side_mismatch',
  'public_takes_no_group',
] as const

export type EngineRefusalCode = typeof engineRefusalCodes[number]

/**
 * Refusals of a caller by who it plays: a controller-only Capability, a unit
 * its roles do not command, a recommendation for a task outside its roles'
 * queue. Core gates use `role_controller_only` too; Einsatz reuses the code.
 */
export const authorityRefusalCodes = ['role_controller_only', 'unit_not_authorized', 'task_not_in_role_queue'] as const
export type AuthorityRefusalCode = typeof authorityRefusalCodes[number]

/**
 * Refusals of a command the runtime does not run: it is unavailable, does
 * not accept the command kind, the input does not parse, or the Run kept
 * deleting Einsatz records while the command was routing. A Run whose saved
 * Einsatz state does not read as this runtime's state does not restore
 * (`einsatz_saved_state_invalid`): there is no migration.
 */
export const runtimeRefusalCodes = ['runtime_unavailable', 'command_not_accepted', 'invalid_input', 'records_changed', 'einsatz_saved_state_invalid'] as const
export type RuntimeRefusalCode = typeof runtimeRefusalCodes[number]

export type EinsatzRefusalCode = ConfigurationRefusalCode | ScenarioConfigRefusalCode | EngineRefusalCode | AuthorityRefusalCode | RuntimeRefusalCode

export const einsatzRefusalCodes = [...configurationRefusalCodes, ...scenarioConfigRefusalCodes, ...engineRefusalCodes, ...authorityRefusalCodes, ...runtimeRefusalCodes] as const
/** Every Einsatz refusal code, for wire answers that name one. */
export const einsatzRefusalCodeSchema = z.enum(einsatzRefusalCodes)

const knownCodes: ReadonlySet<string> = new Set<string>(einsatzRefusalCodes)

export const refusal = (code: EinsatzRefusalCode, message: string): string => `${code}: ${message}`

/** Reads the code back from a refusal; anything outside the convention is an error, never a guess. */
export const refusalCode = (reason: string): EinsatzRefusalCode => {
  const code = /^([a-z][a-z0-9_]*): \S/.exec(reason)?.[1]
  if (code === undefined || !knownCodes.has(code)) throw new Error(`Not an Einsatz refusal: ${reason}`)
  return code as EinsatzRefusalCode
}

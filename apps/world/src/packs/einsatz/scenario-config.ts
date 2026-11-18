import type { PackScenarioConfigContext, PackScenarioConfigIssue } from '../../core/packs/protocol.ts'
import { einsatzConfigShapeSchema } from './config-schema.ts'
import { lastActionByMaxLength } from './engine/model.ts'
import { groupOfRoleId, groupRoleId, isStandingOrderBy, standingOrderByPrefix } from './ids.ts'
import { refusal, type ScenarioConfigRefusalCode } from './refusal.ts'
import { rolesText } from './viewer.ts'

/**
 * Checks an Einsatz configuration against the Scenario it runs in, each issue
 * at its path within the configuration:
 * - hostility is between declared sides (`unknown_side`);
 * - `lastAction.by` names a caller's roles by label, so the labels of every
 *   declared role, held at once, must fit it (`role_labels_too_long`, at the
 *   configuration as a whole): a Run must never write a record it cannot
 *   read back;
 * - no role's label starts as `lastAction.by` names a standing order
 *   (`role_label_reserved`), so a person's order never reads as a reflex's:
 *   a group's label is refused at the group's label, a declared role's at
 *   the configuration as a whole;
 * - in a Scenario with sides groups become roles (core refuses sides
 *   without declared roles), and each names a declared side
 *   (`group_side_required`, `unknown_side`); without sides a group is a
 *   heading only and names no side (`group_side_not_declared`);
 * - only a declared group's own role has an id of the form `group:<id>`
 *   (`reserved_role_id`, at the configuration as a whole).
 *
 * The roles checked include those the groups derive (`groups.ts`), which core
 * adds before this check runs.
 */
export const validateEinsatzScenarioConfig = (raw: unknown, context: PackScenarioConfigContext): ReadonlyArray<PackScenarioConfigIssue> => {
  const config = einsatzConfigShapeSchema.parse(raw)
  const issue = (path: ReadonlyArray<string | number>, code: ScenarioConfigRefusalCode, message: string): PackScenarioConfigIssue =>
    ({ path, code, message: refusal(code, message) })
  const sides = new Set(context.sides.map(side => side.id))
  const undeclaredSide = (side: string) => context.sides.length === 0
    ? `Side "${side}" is not declared: the Scenario declares no sides`
    : `Side "${side}" is not declared; the Scenario declares ${context.sides.map(entry => entry.id).join(', ')}`
  const hostility = Object.entries(config.hostility).flatMap(([side, hostile]) => [
    ...(sides.has(side) ? [] : [issue(['hostility', side], 'unknown_side', undeclaredSide(side))]),
    ...hostile.flatMap((other, index) => sides.has(other) ? [] : [issue(['hostility', side, index], 'unknown_side', undeclaredSide(other))]),
  ])
  const attribution = rolesText(context.roles)
  const labels = attribution.length <= lastActionByMaxLength ? [] : [issue([], 'role_labels_too_long',
    `The labels of all ${context.roles.length} declared roles, held at once, read ${attribution.length} characters; Einsatz names the roles that gave an order in at most ${lastActionByMaxLength}: shorten the labels`)]
  const reservedWhy = `Einsatz names its standing orders "${standingOrderByPrefix}…" where it names the roles that gave an order, so the label would make a person's order read as a standing order`
  const reserved = context.roles.filter(role => isStandingOrderBy(role.label)).map(role => {
    const group = config.groups.findIndex(entry => groupRoleId(entry.id) === role.id)
    return group < 0
      ? issue([], 'role_label_reserved', `Role "${role.id}" is labelled "${role.label}"; ${reservedWhy}: relabel the role`)
      : issue(['groups', group, 'label'], 'role_label_reserved', `Group "${config.groups[group]!.id}" is labelled "${role.label}"; ${reservedWhy}: relabel the group`)
  })
  const groups = context.sides.length === 0
    ? config.groups.flatMap((group, index) => group.side === undefined ? []
      : [issue(['groups', index, 'side'], 'group_side_not_declared', `Group "${group.id}" names side "${group.side}", but the Scenario declares no sides`)])
    : config.groups.flatMap((group, index) => {
      const path = ['groups', index, 'side']
      if (group.side === undefined) return [issue(path, 'group_side_required', `Group "${group.id}" needs a side: ${context.sides.map(side => side.id).join(', ')}`)]
      return sides.has(group.side) ? [] : [issue(path, 'unknown_side', undeclaredSide(group.side))]
    })
  const groupRoles = new Set(context.sides.length === 0 ? [] : config.groups.map(group => groupRoleId(group.id)))
  const imitations = context.roles.filter(role => groupOfRoleId(role.id) !== undefined && !groupRoles.has(role.id)).map(role => issue([], 'reserved_role_id',
    `Role "${role.id}" takes the form of a group's role, but no group "${groupOfRoleId(role.id)}" makes one: rename the role`))
  return [...hostility, ...labels, ...reserved, ...groups, ...imitations]
}

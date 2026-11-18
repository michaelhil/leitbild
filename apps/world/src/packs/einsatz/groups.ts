import type { ScenarioRole } from '../../core/model/index.ts'
import type { PackScenarioRolesContext } from '../../core/packs/protocol.ts'
import { einsatzConfigShapeSchema, type Group } from './config-schema.ts'
import { groupRoleId } from './ids.ts'

/**
 * Groups as roles, in sided Scenarios only. In a Scenario with sides each
 * declared group becomes one operator role, which core adds to the
 * Scenario's declared roles at compile (`WorldPack.scenarioRoles`): its id is
 * `group:<group id>`, its label the group's label, its category the group's
 * category, and it sees the group's side. It commands exactly the group's
 * units, and its queue holds the tasks of its picture that those units can
 * serve (`picture.ts`). In a Scenario without sides a group is a heading
 * only: it makes no role, so the Run stays open, with no role gate, and
 * every caller, an AI agent included, commands every unit.
 */
export const groupRole = (group: Group): ScenarioRole => ({
  id: groupRoleId(group.id),
  label: group.label,
  class: 'operator',
  category: group.category,
  // A sided Scenario's group without a side is refused (`group_side_required`) before its role compiles.
  ...(group.side === undefined ? {} : { sees: [group.side] }),
})

/** The roles an Einsatz configuration derives: in a sided Scenario one per declared group, in declaration order; none without sides. */
export const einsatzScenarioRoles = (raw: unknown, context: PackScenarioRolesContext): ReadonlyArray<ScenarioRole> =>
  context.sides.length === 0 ? [] : einsatzConfigShapeSchema.parse(raw).groups.map(groupRole)

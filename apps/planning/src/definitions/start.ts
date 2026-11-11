// Starting a plan from a Definition, inside planning.plan.create. No World call (A1): the plan is unlinked
// and names its World Scenario; the person starts that Scenario through Host and links the Run with an edit.
import { planningError } from '../errors.ts'
import { applyEdits, requireAuthority, type ChangeRecord, type StoredActor } from '../plan/edits.ts'
import type { Edit } from '../plan/edit-schema.ts'
import { planInputsSchema, type Plan } from '../plan/schema.ts'
import { changeSummary } from '../plan/summary.ts'
import type { PlanDefinition, PlanDefinitionsPort } from './index.ts'

/** The exact revision a caller names, or 404: a start never falls back to another revision. */
export const definitionRevision = (definitions: PlanDefinitionsPort, reference: { readonly id: string; readonly revisionId: string }): PlanDefinition => {
  const found = definitions.list().find(entry => entry.id === reference.id)
  if (found === undefined || found.revisionId !== reference.revisionId) throw planningError(404, 'definition_not_found', 'This plan Definition revision is not available; read the Definitions again')
  return found
}

/**
 * Builds the plan: the Definition's inputs with no Run, then the caller's edits. Create takes no
 * authority, so an edit that weakens a rule is refused here; make it afterwards with planning.plan.edit.
 */
export const startPlan = (start: {
  readonly definition: PlanDefinition
  readonly workspaceId: Plan['workspaceId']
  readonly id: string
  readonly at: string
  readonly by: StoredActor
  readonly edits: readonly Edit[]
}): { readonly plan: Plan; readonly changes: readonly ChangeRecord[] } => {
  const { definition, at, by } = start
  const inputs = planInputsSchema.parse({ ...structuredClone(definition.inputs), settings: { ...definition.inputs.settings, run: null } })
  const outcome = start.edits.length === 0 ? { inputs, changes: [], weakens: [] } : applyEdits(inputs, start.edits, { now: at, by })
  requireAuthority(outcome.weakens, undefined)
  const summary = `Created from '${definition.title}'${outcome.changes.length === 0 ? '' : `; ${changeSummary(outcome.changes, outcome.inputs)}`}`
  return {
    plan: {
      id: start.id, workspaceId: start.workspaceId, revision: 1, createdAt: at, updatedAt: at,
      inputs: outcome.inputs, options: null, baselines: [],
      changes: [{ seq: 1, at, by, revision: 1, summary: summary.length <= 240 ? summary : `${summary.slice(0, 239)}…`, kinds: [...new Set(start.edits.map(edit => edit.edit))].slice(0, 16) }],
      droppedChanges: 0,
    },
    changes: outcome.changes,
  }
}

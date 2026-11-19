// Build a plan from its Definition and edits, inside planning.plan.create. The caller owns persistence
// and any World read, including the guided delivery demo's initial read.
import { planningError } from '../errors.ts'
import { applyEdits, requireAuthority, type ChangeRecord, type StoredActor } from '../plan/edits.ts'
import type { Edit } from '../plan/edit-schema.ts'
import { planInputsSchema, type Plan } from '../plan/schema.ts'
import { changeSummary, clip } from '../plan/summary.ts'
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
  /** The plan's time step, chosen at create; without one the Definition's own (New plan: 30min). */
  readonly grid?: Plan['inputs']['settings']['grid']
}): { readonly plan: Plan; readonly changes: readonly ChangeRecord[] } => {
  const { definition, at, by } = start
  // A plan made from a case Definition is not named like the World Scenario it links to, so the Workspace
  // never shows two cards with one title (walk 2, R2-9); the caller's own title edit still wins.
  const settings = definition.inputs.settings
  const title = settings.scenario === undefined ? settings.title : `${settings.title}: plan`
  const inputs = planInputsSchema.parse({ ...structuredClone(definition.inputs), settings: { ...settings, title, run: null, grid: start.grid ?? settings.grid } })
  const outcome = start.edits.length === 0 ? { inputs, changes: [], weakens: [], drafts: [] } : applyEdits(inputs, start.edits, { now: at, by })
  requireAuthority(outcome.weakens, undefined, inputs)
  const summary = `Created from '${definition.title}'${outcome.changes.length === 0 ? '' : `; ${changeSummary(outcome.changes, outcome.inputs)}`}`
  return {
    plan: {
      id: start.id, workspaceId: start.workspaceId, revision: 1, createdAt: at, updatedAt: at,
      inputs: outcome.inputs, options: null, baselines: [],
      changes: [{ seq: 1, at, by, revision: 1, summary: clip(summary, 240), kinds: [...new Set(start.edits.map(edit => edit.edit))].slice(0, 16) }],
      droppedChanges: 0,
      ...(outcome.drafts.length === 0 ? {} : { drafts: [...outcome.drafts] }),
    },
    changes: outcome.changes,
  }
}

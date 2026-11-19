// The World Run each linked plan is about, for the `about` link on its Resource. The Run id is in the plan
// (settings.run), not in its summary line, and the Resource listing runs on every catalogue read, so a plan
// is read in full once per summary line: the memo is keyed on the plan's id, revision and updatedAt, holds
// Run ids only and keeps exactly the linked plans of the Workspace's latest listing. It lives as long as the
// Module API that owns it (one per service) and is rebuilt from the files after a restart.
import { resourceIdSchema, type WorkspaceId } from '@leitbild/contracts'
import { isPlanningError } from '../errors.ts'
import type { PlanStore, PlanSummary } from '../plan/store.ts'

/** `runId` null: the stored plan is damaged, or its Run id cannot name a Resource. No link, and no second read. */
interface Remembered { readonly revision: number; readonly updatedAt: string; readonly runId: string | null }

export interface RunLinks {
  /** Run id by plan id, for the listed plans that are linked and readable. Never throws for a plan. */
  readonly forListing: (workspaceId: WorkspaceId, plans: ReadonlyArray<PlanSummary>) => Promise<ReadonlyMap<string, string>>
  readonly forgetWorkspace: (workspaceId: WorkspaceId) => void
}

export const createRunLinks = (read: PlanStore['read']): RunLinks => {
  // A plan whose body is damaged under a valid `linked` summary line is remembered as "no Run" under that
  // line's key, so a repair by hand that keeps the summary line is not noticed until the service restarts.
  const byWorkspace = new Map<string, Map<string, Remembered>>()
  return {
    forListing: async (workspaceId, plans) => {
      const known = byWorkspace.get(workspaceId)
      const listed = new Map<string, Remembered>()
      for (const summary of plans) {
        if (!summary.linked) continue
        const kept = known?.get(summary.id)
        if (kept !== undefined && kept.revision === summary.revision && kept.updatedAt === summary.updatedAt) { listed.set(summary.id, kept); continue }
        try {
          // Keyed on the plan as read: a plan saved since the listing is remembered under its own line.
          const plan = await read(workspaceId, summary.id)
          const runId = plan.inputs.settings.run?.id
          listed.set(plan.id, { revision: plan.revision, updatedAt: plan.updatedAt, runId: runId !== undefined && resourceIdSchema.safeParse(runId).success ? runId : null })
        } catch (error) {
          // A damaged plan stays damaged under the same summary line, so it is not read again. A plan deleted
          // since the listing, or a file that could not be read just now, is not remembered: no link this time.
          if (isPlanningError(error) && error.code === 'plan_damaged') listed.set(summary.id, { revision: summary.revision, updatedAt: summary.updatedAt, runId: null })
          else if (!isPlanningError(error) || error.code !== 'plan_not_found') console.error(`Planning could not read plan ${summary.id} for its Run link`, error)
        }
      }
      if (listed.size === 0) byWorkspace.delete(workspaceId)
      else byWorkspace.set(workspaceId, listed)
      return new Map([...listed].flatMap(([id, { runId }]) => runId === null ? [] : [[id, runId] as const]))
    },
    forgetWorkspace: workspaceId => { byWorkspace.delete(workspaceId) },
  }
}

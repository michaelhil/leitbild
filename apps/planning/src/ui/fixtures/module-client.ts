// The screen's own client (ui/api.ts) on the Planning Module's API in a test harness: each capability call
// passed on as the Host passes it, so a test reads a plan exactly as the screen does (read-plan.ts).
import type { Harness } from '../../api/fixtures/harness.ts'
import { createPlanningClient, type PlanningClient } from '../api.ts'

export const moduleClient = (harness: Harness): PlanningClient => createPlanningClient(harness.workspaceId, async (path, init) => {
  const capability = decodeURIComponent(String(path).split('/capabilities/')[1]!.replace('/invoke', ''))
  const body = JSON.parse(String(init!.body)) as { readonly resource?: { readonly id: string }; readonly input?: unknown; readonly expectedRevision?: number }
  const answer = await harness.call(capability, { input: body.input ?? {}, ...(body.resource === undefined ? {} : { resource: body.resource.id }), ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }) })
  return Response.json(answer.body, { status: answer.status })
})

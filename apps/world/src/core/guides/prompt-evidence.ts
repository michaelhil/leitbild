import { moduleCapabilityInvocationResultSchema, presentationPromptEvidenceSchema, type PresentationPromptEvidence, type WorkspaceResourceReference } from '@leitbild/contracts'
import type { Actor } from '../simulation-runs/actors.ts'
import { guideFailure } from './errors.ts'
import { presentationDeliveryMs } from './presentation.ts'

export interface GuidePromptRead {
  readonly room: WorkspaceResourceReference
  readonly subject: WorkspaceResourceReference
  readonly requestId: string
  readonly messageId: string
  readonly actor: Actor
}
export type GuidePromptEvidenceReader = (input: GuidePromptRead) => Promise<PresentationPromptEvidence>

/** World reads Agents' published facts through Host; it never reads another Module's files or implementation. */
export const createGuidePromptEvidenceReader = (hostUrl: string): GuidePromptEvidenceReader => async input => {
  const path = `/api/workspaces/${encodeURIComponent(input.subject.workspaceId)}/capabilities/agents.room.prompt-evidence.read/invoke`
  let response: Response
  try {
    response = await fetch(new URL(path, hostUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(presentationDeliveryMs),
      body: JSON.stringify({ resource: input.room, input: { requestId: input.requestId, messageId: input.messageId, subject: input.subject },
        actor: { kind: 'human', id: input.actor.id, displayName: input.actor.displayName ?? input.actor.label } }),
    })
  } catch (error) { throw guideFailure('guide_prompt_evidence_unavailable', `The Agents evidence read did not finish: ${error instanceof Error ? error.message : String(error)}`, 503) }
  if (!response.ok) throw guideFailure('guide_prompt_evidence_unavailable', `Agents could not establish prompt evidence (HTTP ${response.status}); retry or skip this optional task`, 503)
  return presentationPromptEvidenceSchema.parse(moduleCapabilityInvocationResultSchema.parse(await response.json()).result)
}

import { scenarioEditorMessageSchema, type ScenarioEditorMessage, type WorkspaceDefinitionRevisionReference } from '@leitbild/contracts'

export const readScenarioEditorMessage = (
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  editor: { origin: string; source: Window; documentId: string; workspaceId: string },
): ScenarioEditorMessage | null => {
  if (event.origin !== editor.origin || event.source !== editor.source) return null
  const parsed = scenarioEditorMessageSchema.safeParse(event.data)
  if (!parsed.success || parsed.data.documentId !== editor.documentId) return null
  const message = parsed.data
  if ('subject' in message && message.subject !== null && message.subject.workspaceId !== editor.workspaceId) return null
  return message
}

export const sameSavedScenario = (
  saved: WorkspaceDefinitionRevisionReference, requested: WorkspaceDefinitionRevisionReference,
): boolean =>
  saved.workspaceId === requested.workspaceId && saved.moduleId === requested.moduleId && saved.type === requested.type
  && saved.id === requested.id && saved.revisionId === requested.revisionId

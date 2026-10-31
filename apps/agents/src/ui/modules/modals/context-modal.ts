// Request snapshots and actual execution records remain distinct evidence sources.
import { createModal, createButton, createCodeBlock, prettyJson } from './detail-modal.ts'
import { safeFetchJson } from '../fetch-helpers.ts'
import { showToast } from '../toast.ts'
import { $rooms, type AgentContext, type UIMessage } from '../stores.ts'
import { showGenerationInspector, executionPath } from './generation-inspector.ts'
import { readableEvidence, type ExecutionInspection, type GenerationQueryInspection } from './execution-journey.ts'
import type { ExecutionTurn } from '../../../core/executions/store.ts'
export { extractToolInteractions } from '../../../core/tool-evidence.ts'
export { readableQueryMessage, continuationMetadata, extractPromptSections } from './execution-journey.ts'
export type { GenerationQueryInspection, PromptInspectionSection } from './execution-journey.ts'

export const showRoomExecutions = async (roomId: string): Promise<void> => {
  const modal = createModal({ title: 'Conversation executions', width: 'max-w-4xl' })
  modal.header.appendChild(createButton({ label: 'Close', title: 'Close execution history (Escape)', onClick: modal.close }))
  document.body.appendChild(modal.overlay)
  let cursor: { startedAt: number; id: string } | undefined
  const more = document.createElement('button')
  more.className = 'btn btn-ghost'
  more.textContent = 'Load older turns'
  const load = async (): Promise<void> => {
    const params = new URLSearchParams({ limit: '30', ...(cursor ? { beforeStartedAt: String(cursor.startedAt), beforeId: cursor.id } : {}) })
    const page = await safeFetchJson<{ turns: ExecutionTurn[]; next?: { startedAt: number; id: string } }>(`/rooms/${encodeURIComponent(roomId)}/executions?${params}`)
    if (!page) { showToast(document.body, 'Execution history is unavailable.', { type: 'error', position: 'fixed' }); return }
    if (page.turns.length === 0 && !cursor) modal.scrollBody.textContent = 'No execution turns recorded in this Room.'
    for (const turn of page.turns) {
      const button = document.createElement('button')
      button.className = 'btn btn-ghost block mb-2 text-left'
      button.textContent = `${new Date(turn.startedAt).toLocaleString()} · ${turn.status} · ${turn.agentId}${turn.messageId ? '' : ' · no posted message'}`
      button.onclick = async () => {
        const inspection = await safeFetchJson<ExecutionInspection>(executionPath(roomId, turn.id))
        if (!inspection) { showToast(document.body, 'Execution turn is unavailable.', { type: 'error', position: 'fixed' }); return }
        showGenerationInspector({ execution: inspection })
      }
      modal.scrollBody.appendChild(button)
    }
    cursor = page.next
    more.hidden = !cursor
  }
  more.onclick = () => { void load() }
  modal.footer.appendChild(more)
  await load()
}

const appendWarnings = (host: HTMLElement, warnings?: ReadonlyArray<string>): void => {
  if (!warnings || warnings.length === 0) return
  const box = document.createElement('div')
  box.className = 'text-xs text-warning bg-warning-bg rounded p-2 mb-3 space-y-0.5'
  for (const warning of warnings) {
    const line = document.createElement('div')
    line.textContent = `\u26a0 ${warning}`
    box.appendChild(line)
  }
  host.appendChild(box)
}

export const showContextModal = (context: AgentContext, warnings?: string[]): void => {
  const modal = createModal({ title: 'Initial Generation Context', width: 'max-w-3xl' })
  const header = document.createElement('div')
  header.className = 'text-xs text-text-subtle mb-3'
  header.textContent = `Model: ${context.model} | Temperature: ${context.temperature ?? 'default'} | Tools: ${context.toolCount}`
  modal.scrollBody.appendChild(header)
  appendWarnings(modal.scrollBody, warnings)
  modal.scrollBody.appendChild(createCodeBlock(prettyJson(readableEvidence(context.messages).value), '65vh'))
  modal.header.appendChild(createButton({ label: 'Close', title: 'Close initial context (Escape)', onClick: modal.close }))
  document.body.appendChild(modal.overlay)
}

export const showGenerationQueryModal = (inspection: GenerationQueryInspection, execution?: ExecutionInspection): void => {
  showGenerationInspector({ inspection, execution })
}

export const handleViewContext = async (message: UIMessage): Promise<void> => {
  if (!message.roomId) return
  const room = $rooms.get()[message.roomId]
  if (!room) return
  if (message.progress === true && message.progressEvidence) {
    const execution = await safeFetchJson<ExecutionInspection>(executionPath(room.id, message.progressEvidence.turnId))
    if (!execution) {
      showToast(document.body, 'Recorded activity is unavailable for this update.', { type: 'error', position: 'fixed' })
      return
    }
    showGenerationInspector({ execution, activity: { content: message.content, evidence: message.progressEvidence } })
    return
  }
  if (!message.generationTraceId) return
  const [inspection, execution] = await Promise.all([
    safeFetchJson<GenerationQueryInspection>(`/rooms/${encodeURIComponent(room.id)}/messages/${encodeURIComponent(message.id)}/generation-query`),
    safeFetchJson<ExecutionInspection>(executionPath(room.id, message.generationTraceId)),
  ])
  if (!inspection) {
    if (execution) {
      showGenerationInspector({ execution })
      return
    }
    showToast(document.body, 'Generation query is unavailable for this response.', { type: 'error', position: 'fixed' })
    return
  }
  showGenerationQueryModal(inspection, execution ?? undefined)
}

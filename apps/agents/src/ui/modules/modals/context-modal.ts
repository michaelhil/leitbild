// LLM request inspection. The in-progress view shows the initial context;
// completed responses fetch their durable, exact final generation request.

import { createModal, createCodeBlock, createSectionLabel, prettyJson } from './detail-modal.ts'
import { safeFetchJson } from '../fetch-helpers.ts'
import { showToast } from '../toast.ts'
import { $rooms, type AgentContext, type UIMessage } from '../stores.ts'

interface GenerationQueryInspection {
  readonly messageId: string
  readonly traceId: string
  readonly query: {
    readonly model: string
    readonly messages: ReadonlyArray<Record<string, unknown> & { readonly role: string; readonly content: string }>
    readonly tools?: ReadonlyArray<Record<string, unknown> & {
      readonly function?: { readonly name?: string; readonly description?: string; readonly parameters?: unknown }
    }>
    readonly systemBlocks?: ReadonlyArray<{ readonly text: string; readonly cacheable?: boolean }>
    readonly [key: string]: unknown
  }
  readonly generation: Readonly<Record<string, unknown>>
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

// The thinking card can only expose the initial request because the tool loop
// has not finished yet. Completed messages use the exact final query below.
export const showContextModal = (context: AgentContext, warnings?: string[]): void => {
  const modal = createModal({ title: 'Initial Generation Context', width: 'max-w-3xl' })
  const header = document.createElement('div')
  header.className = 'text-xs text-text-subtle mb-3'
  header.textContent = `Model: ${context.model} | Temperature: ${context.temperature ?? 'default'} | Tools: ${context.toolCount}`
  modal.scrollBody.appendChild(header)
  appendWarnings(modal.scrollBody, warnings)
  modal.scrollBody.appendChild(createCodeBlock(prettyJson(context.messages), '65vh'))
  document.body.appendChild(modal.overlay)
}

const appendDetails = (host: HTMLElement, title: string, value: unknown, open = false): void => {
  const details = document.createElement('details')
  details.className = 'mb-3'
  details.open = open
  const summary = document.createElement('summary')
  summary.className = 'text-xs font-semibold text-text-muted cursor-pointer py-1'
  summary.textContent = title
  details.appendChild(summary)
  details.appendChild(createCodeBlock(prettyJson(value), '55vh'))
  host.appendChild(details)
}

const showGenerationQueryModal = (inspection: GenerationQueryInspection): void => {
  const modal = createModal({ title: 'Generation Query', width: 'max-w-4xl' })
  const note = document.createElement('div')
  note.className = 'text-xs text-text-subtle mb-3'
  note.textContent = 'Complete provider-independent LLM request. It includes system instructions, conversation context, tool calls and results, and tool schemas. Credentials and transport headers are never part of this request.'
  modal.scrollBody.appendChild(note)

  modal.scrollBody.appendChild(createSectionLabel('Generation'))
  modal.scrollBody.appendChild(createCodeBlock(prettyJson({ traceId: inspection.traceId, ...inspection.generation }), '14rem'))

  modal.scrollBody.appendChild(createSectionLabel(`Messages (${inspection.query.messages.length})`))
  inspection.query.messages.forEach((message, index) => {
    appendDetails(modal.scrollBody, `${index + 1}. ${message.role}`, message, message.role === 'system')
  })

  if (inspection.query.tools && inspection.query.tools.length > 0) {
    modal.scrollBody.appendChild(createSectionLabel(`Tool schemas (${inspection.query.tools.length})`))
    for (const tool of inspection.query.tools) appendDetails(modal.scrollBody, tool.function?.name ?? 'tool', tool)
  }

  if (inspection.query.systemBlocks && inspection.query.systemBlocks.length > 0) {
    modal.scrollBody.appendChild(createSectionLabel('Provider cache blocks'))
    appendDetails(modal.scrollBody, `${inspection.query.systemBlocks.length} system blocks`, inspection.query.systemBlocks)
  }

  modal.scrollBody.appendChild(createSectionLabel('Complete raw query'))
  appendDetails(modal.scrollBody, 'JSON', inspection.query)

  const row = document.createElement('div')
  row.className = 'flex justify-end'
  const copy = document.createElement('button')
  copy.className = 'btn btn-ghost'
  copy.textContent = 'Copy complete query'
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(prettyJson(inspection.query))
      showToast(document.body, 'Generation query copied', { type: 'success', position: 'fixed' })
    } catch {
      showToast(document.body, 'Copy failed — clipboard unavailable', { type: 'error', position: 'fixed' })
    }
  }
  row.appendChild(copy)
  modal.footer.appendChild(row)
  document.body.appendChild(modal.overlay)
}

export const handleViewContext = async (message: UIMessage): Promise<void> => {
  if (!message.roomId || !message.generationTraceId) return
  const room = $rooms.get()[message.roomId]
  if (!room) return
  const inspection = await safeFetchJson<GenerationQueryInspection>(
    `/rooms/${encodeURIComponent(room.id)}/messages/${encodeURIComponent(message.id)}/generation-query`,
  )
  if (!inspection) {
    showToast(document.body, 'Generation query is unavailable for this response.', { type: 'error', position: 'fixed' })
    return
  }
  showGenerationQueryModal(inspection)
}

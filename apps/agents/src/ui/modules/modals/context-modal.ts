// LLM request inspection. The in-progress view shows the initial context;
// completed responses fetch their durable, exact final generation request.

import { createModal, createCodeBlock, prettyJson } from './detail-modal.ts'
import { safeFetchJson } from '../fetch-helpers.ts'
import { showToast } from '../toast.ts'
import { $rooms, type AgentContext, type UIMessage } from '../stores.ts'
import { extractToolInteractions } from '../../../core/tool-evidence.ts'
import type { ExecutionCall, ExecutionCallSummary, ExecutionTurn } from '../../../core/executions/store.ts'
import type { ProviderContinuation } from '../../../core/types/llm.ts'
export { extractToolInteractions } from '../../../core/tool-evidence.ts'

interface QueryMessage extends Record<string, unknown> {
  readonly role: string
  readonly content: string
  readonly toolCalls?: ReadonlyArray<{
    readonly id?: string
    readonly function: { readonly name: string; readonly arguments: unknown }
  }>
  readonly toolCallId?: string
  readonly name?: string
  readonly continuation?: ProviderContinuation
}

// Ordinary prompt/tool inspection must not disclose provider protocol payloads.
// The original inspection remains intact for explicit sensitive inspection/copy.
export const readableQueryMessage = (message: QueryMessage): Omit<QueryMessage, 'continuation'> => {
  const { continuation: _continuation, ...readable } = message
  return readable
}

export const continuationMetadata = (messages: ReadonlyArray<QueryMessage>) => messages.flatMap((message, index) => {
  const state = message.continuation
  return state ? [{
    messageIndex: index,
    provider: state.provider,
    model: state.model,
    endpointHash: state.endpointHash,
    detailCount: state.reasoningDetails?.length ?? 0,
    detailTypes: [...new Set(state.reasoningDetails?.map(detail => detail.type).filter(type => typeof type === 'string'))],
    hasReasoning: state.reasoning !== undefined,
    bytes: new TextEncoder().encode(JSON.stringify(state)).byteLength,
  }] : []
})

export interface GenerationQueryInspection {
  readonly messageId: string
  readonly traceId: string
  readonly query: {
    readonly model: string
    readonly messages: ReadonlyArray<QueryMessage>
    readonly tools?: ReadonlyArray<Record<string, unknown> & {
      readonly function?: { readonly name?: string; readonly description?: string; readonly parameters?: unknown }
    }>
    readonly systemBlocks?: ReadonlyArray<{ readonly text: string; readonly cacheable?: boolean }>
    readonly [key: string]: unknown
  }
  readonly generation: Readonly<Record<string, unknown>>
  readonly executionCalls?: ReadonlyArray<unknown>
  readonly startingInput?: unknown
  readonly nestedQueries?: ReadonlyArray<GenerationQueryInspection['query']>
}

interface ExecutionInspection {
  readonly turn: ExecutionTurn
  readonly calls: ReadonlyArray<ExecutionCallSummary>
}

const executionPath = (roomId: string, turnId: string): string =>
  `/rooms/${encodeURIComponent(roomId)}/executions/${encodeURIComponent(turnId)}`

const appendExecution = (host: HTMLElement, inspection: ExecutionInspection): void => {
  appendDisclosure(host, 'Turn status', inspection.turn)
  const warning = document.createElement('p')
  warning.className = 'text-xs text-text-subtle mb-3'
  warning.textContent = 'Actual durable tool attempts and observed outcomes. An absent outcome is unknown, not a failed or safe-to-repeat action. Records describe historical observations, not current state.'
  host.appendChild(warning)
  for (const call of inspection.calls) {
    const details = appendDisclosure(host, `${call.id} · ${call.tool} · ${call.completedAt === undefined ? 'outcome unknown' : 'outcome recorded'}`, call)
    const load = document.createElement('button')
    load.className = 'btn btn-ghost m-2'
    load.textContent = 'Load exact arguments and outcome'
    load.onclick = async () => {
      const record = await safeFetchJson<ExecutionCall>(`${executionPath(inspection.turn.roomId, inspection.turn.id)}/calls/${encodeURIComponent(call.id)}`)
      if (!record) {
        showToast(document.body, 'Execution call is unavailable.', { type: 'error', position: 'fixed' })
        return
      }
      appendDisclosure(details, 'Arguments', record.arguments, true, true)
      appendDisclosure(details, 'Observed outcome', record.result ?? 'Unknown — no durable outcome. Inspect current state before retrying.', true, true)
      load.remove()
    }
    details.appendChild(load)
  }
}

export const showRoomExecutions = async (roomId: string): Promise<void> => {
  const modal = createModal({ title: 'Conversation executions', width: 'max-w-4xl' })
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
        const detail = createModal({ title: 'Execution Inspector', width: 'max-w-4xl' })
        appendExecution(detail.scrollBody, inspection)
        document.body.appendChild(detail.overlay)
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

export interface PromptInspectionSection {
  readonly key: string
  readonly label: string
  readonly content: string
}

const PROMPT_LABELS: Readonly<Record<string, string>> = {
  workspace_rules: 'Workspace rules',
  room: 'Room prompt',
  identity: 'Agent identity',
  skills: 'Skills',
  wikis: 'Wiki catalogue',
  response_format: 'Response format',
  context: 'Runtime context',
}

export const extractPromptSections = (systemPrompt: string): ReadonlyArray<PromptInspectionSection> => {
  const sections: PromptInspectionSection[] = []
  const pattern = /<leitbild:([a-z_]+)(?:\s[^>]*)?>([\s\S]*?)<\/leitbild:\1>/g
  for (const match of systemPrompt.matchAll(pattern)) {
    const key = match[1]!
    sections.push({
      key,
      label: PROMPT_LABELS[key] ?? key.replaceAll('_', ' '),
      content: match[2]!.trim(),
    })
  }
  return sections.length > 0
    ? sections
    : [{ key: 'system', label: 'System prompt', content: systemPrompt }]
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

const appendDisclosure = (
  host: HTMLElement,
  title: string,
  value: unknown,
  open = false,
  nested = false,
): HTMLDetailsElement => {
  const details = document.createElement('details')
  details.className = nested
    ? 'ml-3 mb-2 border-l border-border pl-3'
    : 'mb-3 rounded border border-border bg-surface-raised'
  details.open = open
  const summary = document.createElement('summary')
  summary.className = nested
    ? 'text-xs font-semibold text-text-muted cursor-pointer py-1 select-none'
    : 'text-sm font-semibold text-text cursor-pointer px-3 py-2 select-none'
  summary.textContent = title
  details.appendChild(summary)
  const content = document.createElement('div')
  content.className = nested ? 'pb-2' : 'px-3 pb-3'
  content.appendChild(createCodeBlock(typeof value === 'string' ? value : prettyJson(value), '55vh'))
  details.appendChild(content)
  host.appendChild(details)
  return details
}

const appendCategory = (
  host: HTMLElement,
  title: string,
  render: (body: HTMLDivElement) => void,
  open = false,
): void => {
  const details = document.createElement('details')
  details.className = 'mb-3 rounded border border-border bg-surface-raised'
  details.open = open
  const summary = document.createElement('summary')
  summary.className = 'text-sm font-semibold text-text cursor-pointer px-3 py-2 select-none'
  summary.textContent = title
  details.appendChild(summary)
  const body = document.createElement('div')
  body.className = 'px-3 pb-3'
  render(body)
  details.appendChild(body)
  host.appendChild(details)
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

export const showGenerationQueryModal = (inspection: GenerationQueryInspection, execution?: ExecutionInspection): void => {
  const modal = createModal({ title: 'Prompt & Generation Inspector', width: 'max-w-5xl' })
  const note = document.createElement('div')
  note.className = 'text-xs text-text-subtle mb-3'
  note.textContent = 'Exact provider-independent request supplied for the final model call, including any retained provider continuation. Request evidence may omit later executed calls or context removed before this request. Actual execution facts appear separately below. Wire transformations are not a captured HTTP request; sensitive protocol state requires explicit disclosure.'
  modal.scrollBody.appendChild(note)

  if (execution) appendCategory(modal.scrollBody, `Actual execution (${execution.calls.length} calls)`, body => appendExecution(body, execution))
  if (inspection.executionCalls) appendCategory(modal.scrollBody, `Actual comparison execution (${inspection.executionCalls.length} calls)`, body => {
    inspection.executionCalls!.forEach((call, index) => {
      const tool = call && typeof call === 'object' && 'tool' in call ? String(call.tool) : 'tool call'
      appendDisclosure(body, `${index + 1}. ${tool}`, call, false, true)
    })
  })
  if (inspection.startingInput) appendDisclosure(modal.scrollBody, 'Captured task starting input (before original tool calls)', inspection.startingInput)
  if (inspection.nestedQueries?.length) appendCategory(modal.scrollBody, `Nested model requests (${inspection.nestedQueries.length})`, body => {
    inspection.nestedQueries!.forEach((query, index) => appendDisclosure(body, `${index + 1}. ${query.model}`, {
      ...query, messages: query.messages.map(readableQueryMessage),
    }, false, true))
  })

  appendCategory(modal.scrollBody, 'Generation overview', body => {
    body.appendChild(createCodeBlock(prettyJson({
      messageId: inspection.messageId,
      traceId: inspection.traceId,
      ...inspection.generation,
    }), '18rem'))
  })

  const systemPrompt = inspection.query.systemBlocks?.map(block => block.text).filter(Boolean).join('\n\n')
    ?? inspection.query.messages.find(message => message.role === 'system')?.content
  appendCategory(modal.scrollBody, 'Prompts & instructions', body => {
    if (!systemPrompt) {
      body.textContent = 'No system prompt was present in this request.'
      return
    }
    for (const section of extractPromptSections(systemPrompt)) {
      appendDisclosure(body, section.label, section.content, false, true)
    }
  })

  const dialogue = inspection.query.messages.filter(message =>
    message.role !== 'system' && message.role !== 'tool' && !message.toolCalls?.length,
  )
  appendCategory(modal.scrollBody, `Conversation context (${dialogue.length})`, body => {
    dialogue.forEach((message, index) => {
      appendDisclosure(body, `${index + 1}. ${message.role}`, readableQueryMessage(message), false, true)
    })
  })

  const toolInteractions = extractToolInteractions(inspection.query.messages)
  const trace = Array.isArray(inspection.generation.toolTrace) ? inspection.generation.toolTrace : []
  if (toolInteractions.length > 0 || trace.length > 0) {
    appendCategory(modal.scrollBody, `Tool evidence in model request (${toolInteractions.length})`, body => {
      toolInteractions.forEach((interaction, index) => {
        appendDisclosure(body, `${index + 1}. ${interaction.name}`, interaction, false, true)
      })
      if (trace.length > toolInteractions.length) {
        appendDisclosure(body, 'Additional execution trace', trace, false, true)
      }
    })
  }

  if (inspection.query.tools && inspection.query.tools.length > 0) {
    appendCategory(modal.scrollBody, `Available tool schemas (${inspection.query.tools.length})`, body => {
      for (const tool of inspection.query.tools!) {
        appendDisclosure(body, tool.function?.name ?? 'tool', tool, false, true)
      }
    })
  }

  if (inspection.query.systemBlocks && inspection.query.systemBlocks.length > 0) {
    appendCategory(modal.scrollBody, `Provider cache layout (${inspection.query.systemBlocks.length} blocks)`, body => {
      inspection.query.systemBlocks!.forEach((block, index) => {
        appendDisclosure(body, `${index + 1}. ${block.cacheable ? 'Cacheable' : 'Dynamic'} system block`, block, false, true)
      })
    })
  }

  const { messages: _messages, tools: _tools, systemBlocks: _systemBlocks, ...settings } = inspection.query
  appendCategory(modal.scrollBody, 'Request settings', body => {
    body.appendChild(createCodeBlock(prettyJson(settings), '18rem'))
  })

  const protocol = continuationMetadata([
    ...inspection.query.messages,
    ...(inspection.nestedQueries ?? []).flatMap(query => query.messages),
  ])
  if (protocol.length) appendDisclosure(modal.scrollBody, 'Provider continuation metadata (not prompt prose)', protocol)
  const row = document.createElement('div')
  row.className = 'flex justify-end'
  const copy = document.createElement('button')
  copy.className = 'btn btn-ghost'
  copy.textContent = protocol.length ? 'Copy complete record (sensitive protocol included)' : 'Copy complete record'
  copy.disabled = protocol.length > 0
  const showRaw = (): void => {
    appendCategory(modal.scrollBody, 'Complete raw inspection record', body => {
      body.appendChild(createCodeBlock(prettyJson(inspection), '65vh'))
    })
    copy.disabled = false
  }
  if (protocol.length) {
    const reveal = document.createElement('button')
    reveal.className = 'btn btn-ghost mb-3'
    reveal.textContent = 'Enable sensitive protocol inspection and complete-record copy'
    reveal.onclick = () => { showRaw(); reveal.remove() }
    modal.scrollBody.appendChild(reveal)
  } else showRaw()
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(prettyJson(inspection))
      showToast(document.body, 'Generation record copied', { type: 'success', position: 'fixed' })
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
  const [inspection, execution] = await Promise.all([
    safeFetchJson<GenerationQueryInspection>(`/rooms/${encodeURIComponent(room.id)}/messages/${encodeURIComponent(message.id)}/generation-query`),
    safeFetchJson<ExecutionInspection>(executionPath(room.id, message.generationTraceId)),
  ])
  if (!inspection) {
    if (execution) {
      const modal = createModal({ title: 'Execution Inspector', width: 'max-w-4xl' })
      appendExecution(modal.scrollBody, execution)
      document.body.appendChild(modal.overlay)
      return
    }
    showToast(document.body, 'Generation query is unavailable for this response.', { type: 'error', position: 'fixed' })
    return
  }
  showGenerationQueryModal(inspection, execution ?? undefined)
}

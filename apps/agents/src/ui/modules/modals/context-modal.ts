// LLM request inspection. The in-progress view shows the initial context;
// completed responses fetch their durable, exact final generation request.

import { createModal, createCodeBlock, prettyJson } from './detail-modal.ts'
import { safeFetchJson } from '../fetch-helpers.ts'
import { showToast } from '../toast.ts'
import { $rooms, type AgentContext, type UIMessage } from '../stores.ts'

interface QueryMessage extends Record<string, unknown> {
  readonly role: string
  readonly content: string
  readonly toolCalls?: ReadonlyArray<{
    readonly id?: string
    readonly function: { readonly name: string; readonly arguments: unknown }
  }>
  readonly toolCallId?: string
  readonly name?: string
}

interface GenerationQueryInspection {
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
}

export interface PromptInspectionSection {
  readonly key: string
  readonly label: string
  readonly content: string
}

export interface ToolInteractionInspection {
  readonly id: string
  readonly name: string
  readonly arguments: unknown
  readonly result?: { readonly content: string; readonly name?: string }
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

export const extractToolInteractions = (
  messages: ReadonlyArray<QueryMessage>,
): ReadonlyArray<ToolInteractionInspection> => {
  const results = new Map<string, { content: string; name?: string }>()
  for (const message of messages) {
    if (message.role !== 'tool' || !message.toolCallId) continue
    results.set(message.toolCallId, {
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    })
  }
  const interactions: ToolInteractionInspection[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue
    for (const [index, call] of message.toolCalls.entries()) {
      const id = call.id ?? `call_${index}`
      interactions.push({
        id,
        name: call.function.name,
        arguments: call.function.arguments,
        ...(results.has(id) ? { result: results.get(id)! } : {}),
      })
    }
  }
  return interactions
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

const showGenerationQueryModal = (inspection: GenerationQueryInspection): void => {
  const modal = createModal({ title: 'Prompt & Generation Inspector', width: 'max-w-5xl' })
  const note = document.createElement('div')
  note.className = 'text-xs text-text-subtle mb-3'
  note.textContent = 'Complete provider-independent request supplied by Leitbild for the final model call, plus generation telemetry. In tool-using turns this request contains the accumulated exact tool calls and results. Provider-side hidden instructions, SDK wire transformations, authentication headers, and transport metadata are outside Leitbild and are not available.'
  modal.scrollBody.appendChild(note)

  appendCategory(modal.scrollBody, 'Generation overview', body => {
    body.appendChild(createCodeBlock(prettyJson({
      messageId: inspection.messageId,
      traceId: inspection.traceId,
      ...inspection.generation,
    }), '18rem'))
  }, true)

  const systemMessage = inspection.query.messages.find(message => message.role === 'system')
  appendCategory(modal.scrollBody, 'Prompts & instructions', body => {
    if (!systemMessage) {
      body.textContent = 'No system prompt was present in this request.'
      return
    }
    for (const section of extractPromptSections(systemMessage.content)) {
      appendDisclosure(body, section.label, section.content, false, true)
    }
  }, true)

  const dialogue = inspection.query.messages.filter(message =>
    message.role !== 'system' && message.role !== 'tool' && !message.toolCalls?.length,
  )
  appendCategory(modal.scrollBody, `Conversation context (${dialogue.length})`, body => {
    dialogue.forEach((message, index) => {
      appendDisclosure(body, `${index + 1}. ${message.role}`, message, false, true)
    })
  })

  const toolInteractions = extractToolInteractions(inspection.query.messages)
  const trace = Array.isArray(inspection.generation.toolTrace) ? inspection.generation.toolTrace : []
  if (toolInteractions.length > 0 || trace.length > 0) {
    appendCategory(modal.scrollBody, `Tool activity (${Math.max(toolInteractions.length, trace.length)})`, body => {
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

  appendCategory(modal.scrollBody, 'Complete raw inspection record', body => {
    body.appendChild(createCodeBlock(prettyJson(inspection), '65vh'))
  })

  const row = document.createElement('div')
  row.className = 'flex justify-end'
  const copy = document.createElement('button')
  copy.className = 'btn btn-ghost'
  copy.textContent = 'Copy complete record'
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
  const inspection = await safeFetchJson<GenerationQueryInspection>(
    `/rooms/${encodeURIComponent(room.id)}/messages/${encodeURIComponent(message.id)}/generation-query`,
  )
  if (!inspection) {
    showToast(document.body, 'Generation query is unavailable for this response.', { type: 'error', position: 'fixed' })
    return
  }
  showGenerationQueryModal(inspection)
}

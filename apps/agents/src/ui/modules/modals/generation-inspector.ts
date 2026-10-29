import { createModal, createButton, createCodeBlock, prettyJson } from './detail-modal.ts'
import { safeFetchJson } from '../fetch-helpers.ts'
import { showToast } from '../toast.ts'
import { buildExecutionJourney, readableEvidence, extractPromptSections, formatElapsed, type ExecutionInspection, type GenerationQueryInspection, type JourneyActor, type JourneyEvent } from './execution-journey.ts'
import type { ExecutionCall } from '../../../core/executions/store.ts'
import type { ExecutionModelCall } from '../../../core/executions/model-evidence.ts'
import { progressActivityEvents, recordedOperations, recordedOperationView, type ProgressActivity } from './progress-activity.ts'
import { currentWorkspaceId } from '../api-client.ts'
import { embeddedViewFragment, embeddedViewPath } from '@leitbild/contracts/embedded-view-route'

export const executionPath = (roomId: string, turnId: string): string =>
  `/rooms/${encodeURIComponent(roomId)}/executions/${encodeURIComponent(turnId)}`

const text = (tag: string, content: string, className = ''): HTMLElement => {
  const element = document.createElement(tag)
  element.textContent = content
  element.className = className
  return element
}
const note = (host: HTMLElement, content: string): void => { host.appendChild(text('p', content, 'inspector-note')) }
const value = (host: HTMLElement, label: string, content: unknown): void => {
  host.appendChild(text('h4', label, 'inspector-section-title'))
  host.appendChild(createCodeBlock(typeof content === 'string' ? content : prettyJson(content), 'none'))
}
// Exact payloads and schemas can be large. Do not stringify until deliberately opened.
const lazyDisclosure = (host: HTMLElement, title: string, render: (body: HTMLElement) => void): void => {
  const details = document.createElement('details')
  details.className = 'inspector-disclosure'
  details.appendChild(text('summary', title))
  let rendered = false
  details.ontoggle = () => {
    if (!details.open || rendered) return
    rendered = true
    const body = document.createElement('div')
    render(body)
    details.appendChild(body)
  }
  host.appendChild(details)
}
const phase = (host: HTMLElement, label: string, description: string): void => {
  const row = document.createElement('div')
  row.className = 'inspector-fact'
  row.append(text('strong', label), text('span', description))
  host.appendChild(row)
}
const actorLabels: Readonly<Record<JourneyActor, string>> = { context: 'Context', model: 'Model', tools: 'Tools', system: 'Runtime' }
const stateLabel = (event: JourneyEvent): string => event.state === 'recorded' ? event.source.kind === 'model' ? 'Response recorded' : 'Recorded' : event.state === 'unknown' ? 'Outcome unknown' : event.state[0]!.toUpperCase() + event.state.slice(1)

/** One evidence inspector, two projections of the same selected event.
 * Runtime records, request snapshots and unknown outcomes stay distinct. */
export const showGenerationInspector = (options: {
  readonly inspection?: GenerationQueryInspection
  readonly execution?: ExecutionInspection
  readonly activity?: ProgressActivity
}): void => {
  const { inspection, execution, activity } = options
  const modal = createModal({ title: activity ? 'Activity behind this update' : 'Prompt & Generation Inspector', width: 'max-w-6xl', maxHeight: '94vh' })
  modal.card.classList.add('execution-inspector')
  modal.scrollBody.classList.add('execution-inspector-body')
  const close = createButton({ label: 'Close', title: 'Close Inspector (Escape)', onClick: modal.close })
  modal.header.appendChild(close)
  // Keep keyboard traversal inside this dialog. This listener belongs to the
  // card, so removal releases it with no extra document-level lifecycle.
  modal.card.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const controls = [...modal.card.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')].filter(element => element.getClientRects().length > 0)
    const first = controls[0], last = controls.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  })
  const allEvents = buildExecutionJourney(execution, inspection)
  const activityEvents = execution && activity ? progressActivityEvents(execution, allEvents, activity) : undefined
  let events = activity ? activityEvents ?? [] : allEvents
  const bar = document.createElement('div')
  bar.className = 'inspector-toolbar'
  const chips = document.createElement('div')
  chips.className = 'inspector-chips'
  if (execution) {
    chips.append(text('span', execution.turn.status, 'inspector-chip'), text('span', execution.modelCapture === 'unavailable' ? 'Model history unavailable' : `${execution.models.length} model call${execution.models.length === 1 ? '' : 's'}${activity ? ' in turn' : ''}`, 'inspector-chip'), text('span', `${execution.calls.length} tool attempt${execution.calls.length === 1 ? '' : 's'}${activity ? ' in turn' : ''}`, 'inspector-chip'))
    if (execution.turn.finishedAt !== undefined) chips.appendChild(text('span', formatElapsed(execution.turn.finishedAt - execution.turn.startedAt), 'inspector-chip'))
  } else chips.appendChild(text('span', 'Request snapshots', 'inspector-chip'))
  const modes = document.createElement('div')
  modes.className = 'inspector-mode'
  modes.setAttribute('aria-label', 'Execution view')
  if (activity) {
    const scope = document.createElement('div')
    scope.className = 'inspector-mode'
    scope.setAttribute('aria-label', 'Activity scope')
    const update = createButton({ label: 'This update', onClick: () => {
      events = activityEvents ?? []; update.setAttribute('aria-pressed', 'true'); full.setAttribute('aria-pressed', 'false')
      const selected = events.find(event => event.id === selectedId)
      if (selected) select(selected); else renderOverview()
    } })
    const full = createButton({ label: 'Full turn', onClick: () => {
      events = allEvents; update.setAttribute('aria-pressed', 'false'); full.setAttribute('aria-pressed', 'true')
      const selected = events.find(event => event.id === selectedId)
      if (selected) select(selected); else renderOverview()
    } })
    update.setAttribute('aria-pressed', 'true'); full.setAttribute('aria-pressed', 'false')
    scope.append(update, full); modes.appendChild(scope)
  }
  const master = document.createElement('nav')
  master.className = 'inspector-master'
  master.setAttribute('aria-label', 'Recorded execution events')
  const detail = document.createElement('section')
  detail.className = 'inspector-detail'
  detail.setAttribute('aria-label', 'Selected evidence')
  detail.tabIndex = -1
  const panels = document.createElement('div')
  panels.className = 'inspector-panels'
  panels.append(master, detail)
  bar.append(chips, modes)
  modal.scrollBody.append(bar, panels)
  let selectedId = 'overview'
  let selection = 0
  let mode: 'journey' | 'sequence' = 'journey'
  const toolRecords = new Map<string, ExecutionCall>()
  const modelRecords = new Map<string, ExecutionModelCall>()
  const modeButtons: HTMLButtonElement[] = []
  for (const [id, label] of [['journey', 'Journey'], ['sequence', 'Sequence']] as const) {
    const button = createButton({ label, onClick: () => {
      mode = id
      modeButtons.forEach(item => item.setAttribute('aria-pressed', String(item === button)))
      renderMaster()
    } })
    button.setAttribute('aria-pressed', String(id === mode))
    modeButtons.push(button); modes.appendChild(button)
  }

  const error = (host: HTMLElement, message: string, retry: () => void): void => {
    note(host, message)
    host.appendChild(createButton({ label: 'Retry loading evidence', onClick: retry }))
  }
  const renderRaw = (host: HTMLElement, record: unknown, sensitive = false): void => {
    const readable = sensitive ? { value: record, protocolPaths: [] } : readableEvidence(record)
    host.appendChild(createCodeBlock(prettyJson(readable.value), 'none'))
    host.appendChild(createButton({ label: sensitive ? 'Copy complete sensitive record' : 'Copy selected record', onClick: async () => {
      try {
        await navigator.clipboard.writeText(prettyJson(readable.value))
        showToast(document.body, 'Selected evidence copied', { type: 'success', position: 'fixed' })
      } catch { showToast(document.body, 'Copy failed — clipboard unavailable', { type: 'error', position: 'fixed' }) }
    } }))
    if (readable.protocolPaths.length) {
      note(host, `${readable.protocolPaths.length} provider continuation ${readable.protocolPaths.length === 1 ? 'record is' : 'records are'} withheld from ordinary inspection and copy.`)
      host.appendChild(createButton({ label: 'Reveal sensitive protocol and enable complete copy', onClick: () => {
        host.replaceChildren(text('p', 'Sensitive provider protocol included by explicit request.', 'inspector-note'))
        renderRaw(host, record, true)
      } }))
    }
  }
  // A schema-neutral view of the owning Module's recorded evidence. Nested
  // values mount only when opened; large historical payloads remain lazy.
  const renderStructured = (host: HTMLElement, label: string, record: unknown, open = false): void => {
    if (record === null || typeof record !== 'object') {
      const row = document.createElement('div'); row.className = 'inspector-tree-leaf'
      row.append(text('strong', label), text('span', record === undefined ? 'Not recorded' : String(record)))
      host.appendChild(row); return
    }
    const entries = Object.entries(record)
    const details = document.createElement('details'); details.className = 'inspector-tree'
    details.appendChild(text('summary', `${label} · ${entries.length} ${Array.isArray(record) ? 'items' : 'fields'}`))
    let rendered = false
    const render = (): void => {
      if (rendered || !details.open) return
      rendered = true
      const body = document.createElement('div')
      for (const [key, value] of entries) renderStructured(body, Array.isArray(record) ? String(Number(key) + 1) : key, value)
      details.appendChild(body)
    }
    details.ontoggle = render; host.appendChild(details)
    if (open) { details.open = true; render() }
  }
  const tabs = (host: HTMLElement, choices: ReadonlyArray<{ readonly label: string; readonly render: (body: HTMLElement) => void }>): void => {
    const row = document.createElement('div')
    row.className = 'inspector-detail-tabs'
    row.setAttribute('aria-label', 'Evidence category')
    const body = document.createElement('div')
    body.className = 'inspector-evidence'
    const buttons: HTMLButtonElement[] = []
    for (const choice of choices) {
      const button = createButton({ label: choice.label, onClick: () => {
        buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)))
        body.replaceChildren(); choice.render(body)
      } })
      button.setAttribute('aria-pressed', String(buttons.length === 0))
      buttons.push(button); row.appendChild(button)
    }
    host.append(row, body)
    choices[0]!.render(body)
  }
  const renderQuery = (host: HTMLElement, query: GenerationQueryInspection['query'], output?: (body: HTMLElement) => void, raw?: (body: HTMLElement) => void): void => {
    const systemPrompt = query.systemBlocks?.map(block => block.text).join('\n\n') ?? query.messages.find(message => message.role === 'system')?.content
    tabs(host, [
      ...(output ? [{ label: 'Output', render: output }] : []),
      { label: 'Instructions', render: body => {
        if (!systemPrompt) { note(body, 'No system prompt is present in this request.'); return }
        const sections = extractPromptSections(systemPrompt)
        const selector = document.createElement('select')
        selector.setAttribute('aria-label', 'Prompt section')
        for (const [index, section] of sections.entries()) {
          const option = document.createElement('option'); option.value = String(index); option.textContent = section.label; selector.appendChild(option)
        }
        const content = document.createElement('div')
        const render = (): void => { content.replaceChildren(); value(content, sections[Number(selector.value)]!.label, sections[Number(selector.value)]!.content) }
        selector.onchange = render
        body.append(selector, content); render()
        if (query.systemBlocks?.length) lazyDisclosure(body, 'Provider cache blocks', target => renderRaw(target, query.systemBlocks))
      } },
      { label: 'Messages', render: body => {
        note(body, 'Exact request messages. Provider continuation is withheld from this view.')
        const selector = document.createElement('select')
        selector.setAttribute('aria-label', 'Request message')
        for (const [index, message] of query.messages.entries()) {
          const option = document.createElement('option'); option.value = String(index); option.textContent = `${index + 1}. ${message.role}${message.name ? ` · ${message.name}` : ''}${message.toolCalls?.length ? ` · ${message.toolCalls.length} tool requests` : ''}`; selector.appendChild(option)
        }
        const content = document.createElement('div')
        const render = (): void => { content.replaceChildren(); const message = query.messages[Number(selector.value)]; if (message) renderRaw(content, message); else note(content, 'No request messages.'); }
        selector.onchange = render; body.append(selector, content); render()
      } },
      { label: 'Available tools', render: body => {
        note(body, 'Available schemas describe what could be called. They are not execution records.')
        if (!query.tools?.length) { note(body, 'No tool schemas in this request.'); return }
        for (const tool of query.tools) lazyDisclosure(body, tool.function?.name ?? 'Tool schema', target => renderRaw(target, tool))
      } },
      { label: 'Settings', render: body => { const { messages: _messages, tools: _tools, systemBlocks: _blocks, ...settings } = query; renderRaw(body, settings) } },
      { label: 'Raw', render: raw ?? (body => renderSnapshotRaw(body, query)) },
    ])
  }
  const renderSnapshotRaw = (host: HTMLElement, query: GenerationQueryInspection['query']): void => {
    renderRaw(host, query)
  }

  const renderModel = async (host: HTMLElement, event: JourneyEvent, token: number, sensitive = false): Promise<void> => {
    if (!execution || event.source.kind !== 'model') return
    const call = event.source.call
    const path = `${execution.evidencePath ?? executionPath(execution.turn.roomId, execution.turn.id)}/models/${encodeURIComponent(call.id)}`
    const record = sensitive ? await safeFetchJson<ExecutionModelCall>(`${path}?sensitive=1`) : modelRecords.get(call.id) ?? await safeFetchJson<ExecutionModelCall>(path)
    if (token !== selection || !modal.overlay.isConnected) return
    host.replaceChildren()
    if (!record) { error(host, 'The exact model record is unavailable.', () => { void renderModel(host, event, token, sensitive) }); return }
    if (!sensitive) modelRecords.set(call.id, record)
    if (sensitive) { note(host, 'Sensitive provider protocol included by explicit request.'); renderRaw(host, record, true); return }
    phase(host, 'Input', `${record.messageCount} messages · ${record.toolCount} available tools`)
    renderQuery(host, record.request as unknown as GenerationQueryInspection['query'], body => {
      if (record.error) value(body, 'Recorded model error', record.error)
      if (record.response) {
        if (record.status !== 'completed') note(body, 'This is a partial response captured before the model call ended. Its recorded status remains ' + record.status + '.')
        if (record.response.content) body.appendChild(text('div', record.response.content, 'inspector-prose'))
        if (!record.response.content && !record.requestedTools?.length) note(body, 'The recorded response contains no text or tool requests.')
        if (record.response.finishReason) phase(body, 'Finish reason', record.response.finishReason)
        for (const requested of record.requestedTools ?? []) {
          const actual = requested.executionCallId ? allEvents.find(item => item.source.kind === 'tool' && item.source.call.id === requested.executionCallId) : undefined
          const row = document.createElement('div'); row.className = 'inspector-fact'
          row.appendChild(text('strong', requested.tool))
          row.appendChild(actual ? createButton({ label: 'Inspect actual attempt', onClick: () => select(actual) }) : text('span', 'Requested · no matching execution record'))
          body.appendChild(row)
        }
        lazyDisclosure(body, 'Recorded response and metrics', target => renderRaw(target, record.response))
      } else note(body, 'No durable model response was captured. Its outcome is unknown; the turn status does not establish the model outcome.')
    }, body => {
      renderRaw(body, record)
      if (record.protocolWithheld) body.appendChild(createButton({ label: 'Reveal sensitive protocol and enable complete copy', onClick: () => { body.replaceChildren(text('p', 'Loading sensitive record…', 'inspector-note')); void renderModel(body, event, token, true) } }))
    })
  }
  const renderTool = async (host: HTMLElement, event: JourneyEvent, token: number): Promise<void> => {
    if (!execution || event.source.kind !== 'tool') return
    const call = event.source.call
    const record = toolRecords.get(call.id) ?? await safeFetchJson<ExecutionCall>(`${execution.evidencePath ?? executionPath(execution.turn.roomId, execution.turn.id)}/calls/${encodeURIComponent(call.id)}`)
    if (token !== selection || !modal.overlay.isConnected) return
    host.replaceChildren()
    if (!record) { error(host, 'The exact tool record is unavailable.', () => { void renderTool(host, event, token) }); return }
    if (record.completedAt !== undefined) toolRecords.set(call.id, record)
    if (record.arguments && typeof record.arguments === 'object' && 'operationId' in record.arguments && typeof record.arguments.operationId === 'string') phase(host, 'Operation', record.arguments.operationId)
    phase(host, 'Observed outcome', record.result === undefined ? 'Unknown — no durable result' : record.result.success ? 'Tool reported success' : 'Tool reported an error')
    note(host, 'A recorded tool result is historical evidence. Accepted commands do not by themselves prove the plant reached the intended state.')
    const operations = recordedOperations(record)
    const focusedKey = activity?.evidence.callId === call.id ? activity.evidence.operationKey : undefined
    const focused = focusedKey === undefined ? undefined : operations.find(operation => operation.key === focusedKey)
    const published = focused === undefined ? undefined : recordedOperationView(focused, currentWorkspaceId())
    const renderOperation = (body: HTMLElement, operation: (typeof operations)[number]): void => {
      phase(body, operation.operationId, operation.result === undefined ? 'Outcome not recorded' : operation.result.success === true ? 'Operation accepted' : 'Operation refused')
      if (operation.target !== undefined) renderStructured(body, 'Target', operation.target)
      renderStructured(body, 'Input', operation.input)
      if (operation.result === undefined) note(body, 'No matching durable result. This does not establish that nothing happened.')
      else if (operation.result.success === true) renderStructured(body, 'Recorded result', operation.result.data, true)
      else renderStructured(body, 'Recorded refusal', operation.result, true)
    }
    tabs(host, [
      ...(published ? [{ label: 'Published view', render: (body: HTMLElement) => {
        if (published.kind === 'refused') { note(body, `${published.code}: ${published.error}`); return }
        const envelope = published.envelope
        const frame = document.createElement('iframe')
        frame.title = envelope.title
        frame.src = embeddedViewPath(envelope) + embeddedViewFragment(envelope)
        frame.style.cssText = `display:block;width:100%;height:${envelope.height}px;border:0`
        frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'")
        frame.setAttribute('referrerpolicy', 'same-origin')
        body.appendChild(frame)
      } }] : []),
      ...(operations.length ? [{ label: 'Operations', render: (body: HTMLElement) => {
        if (focused) renderOperation(body, focused)
        for (const operation of operations) {
          if (operation === focused) continue
          if (focused) lazyDisclosure(body, operation.operationId, target => renderOperation(target, operation))
          else renderOperation(body, operation)
        }
      } }] : []),
      { label: 'Result', render: body => { if (record.result === undefined) note(body, 'Inspect current state before retrying an action with no recorded result.'); else renderRaw(body, record.result) } },
      { label: 'Arguments', render: body => renderRaw(body, record.arguments) },
      { label: 'Raw', render: body => renderRaw(body, record) },
    ])
  }
  const renderOverview = (): void => {
    selection++; selectedId = 'overview'; detail.replaceChildren()
    if (activity) {
      detail.appendChild(text('div', activity.content, 'inspector-update'))
      note(detail, events === allEvents ? 'Showing the complete recorded turn.' : activityEvents === undefined ? 'The exact activity boundary is unavailable. Full turn shows only the evidence actually retained.' : 'Recorded activity since the previous update. Full turn includes earlier context and later work.')
    }
    detail.appendChild(text('h3', execution?.turn.messageId ? 'How this response was produced' : 'Recorded execution', 'inspector-detail-title'))
    note(detail, 'Choose a recorded step to inspect its exact input and observed output.')
    const flow = document.createElement('div'); flow.className = 'inspector-flow'
    for (const label of ['Context', 'Model', 'Tools', 'Response']) flow.appendChild(text('span', label))
    detail.appendChild(flow)
    if (execution) {
      phase(detail, 'Turn', execution.turn.status)
      phase(detail, 'Started', new Date(execution.turn.startedAt).toLocaleString())
      phase(detail, 'Agent', execution.turn.agentId)
      if (execution.turn.reason) note(detail, execution.turn.reason)
      if (execution.modelCapture === 'unavailable') note(detail, 'Model-by-model capture is unavailable for this historical turn. The retained final request does not reconstruct earlier model iterations.')
      if (execution.modelCapture === 'recorded' && execution.models.length === 0) note(detail, 'No model call was recorded in this turn. Inspect the runtime stages for preparation or cancellation.')
      const unknown = execution.calls.filter(call => call.completedAt === undefined).length
      if (unknown) note(detail, `${unknown} tool ${unknown === 1 ? 'attempt has' : 'attempts have'} no durable outcome. Do not assume failure or safe retry.`)
      lazyDisclosure(detail, 'Execution index', body => renderRaw(body, execution))
    } else note(detail, 'This record contains request snapshots, not a complete timed execution history.')
    note(detail, 'Captured at the provider-independent generation boundary. Provider HTTP exchanges, internal retries and private reasoning are not reconstructed.')
    if (inspection) {
      lazyDisclosure(detail, 'Generation metadata', body => renderRaw(body, { messageId: inspection.messageId, traceId: inspection.traceId, ...inspection.generation }))
      if (execution?.modelCapture === 'recorded') lazyDisclosure(detail, 'Retained final request archive', body => renderQuery(body, inspection.query))
      lazyDisclosure(detail, 'Complete inspection snapshot', body => renderRaw(body, inspection))
    }
    renderMaster()
  }
  const select = (event: JourneyEvent, focusDetail = false): void => {
    const token = ++selection
    selectedId = event.id
    detail.replaceChildren(text('div', actorLabels[event.actor], 'inspector-eyebrow'), text('h3', event.title, 'inspector-detail-title'))
    if (activity) detail.prepend(text('div', activity.content, 'inspector-update'))
    phase(detail, stateLabel(event), event.description)
    if (event.at !== undefined) phase(detail, 'Time', `${new Date(event.at).toLocaleTimeString()}${event.finishedAt !== undefined ? ` · ${formatElapsed(event.finishedAt - event.at)}` : ''}`)
    const body = document.createElement('div'); detail.appendChild(body)
    switch (event.source.kind) {
      case 'model': body.appendChild(text('p', 'Loading exact model evidence…', 'inspector-note')); void renderModel(body, event, token); break
      case 'tool': body.appendChild(text('p', 'Loading exact tool evidence…', 'inspector-note')); void renderTool(body, event, token); break
      case 'stage': value(body, 'Recorded runtime stage', event.source.stage.event); break
      case 'snapshot': note(body, 'A retained request snapshot, not a captured model response or complete iteration history.'); renderQuery(body, event.source.query); break
      case 'comparison': body.appendChild(text('h4', 'Exact comparison evidence', 'inspector-section-title')); renderRaw(body, event.source.record); break
      case 'starting': body.appendChild(text('h4', 'Captured task starting input', 'inspector-section-title')); renderRaw(body, event.source.input); break
    }
    renderMaster()
    if (focusDetail) detail.focus()
  }
  const renderMaster = (): void => {
    const scrollTop = master.scrollTop
    master.replaceChildren()
    master.dataset.mode = mode
    const overview = createButton({ label: 'Overview', className: 'inspector-overview', onClick: event => { renderOverview(); if (event.detail === 0) detail.focus() } })
    overview.setAttribute('aria-current', String(selectedId === 'overview'))
    master.appendChild(overview)
    if (mode === 'sequence') {
      const lanes = document.createElement('div'); lanes.className = 'inspector-lanes'
      for (const label of Object.values(actorLabels)) lanes.appendChild(text('span', label))
      master.appendChild(lanes)
    }
    let untimed = false
    for (const event of events) {
      if (event.at === undefined && !untimed) { master.appendChild(text('div', 'Untimed snapshots', 'inspector-untimed')); untimed = true }
      const row = document.createElement('div'); row.className = 'inspector-event-row'; row.dataset.actor = event.actor
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'inspector-event'; button.dataset.state = event.state
      button.setAttribute('aria-current', String(selectedId === event.id))
      button.title = `${event.title} · ${event.description} · ${stateLabel(event)}`
      const number = text('span', event.source.kind === 'model' ? String(event.source.call.ordinal) : event.actor === 'tools' ? '↗' : event.state === 'warning' ? '!' : '•', 'inspector-event-mark')
      const content = document.createElement('span'); content.className = 'inspector-event-label'
      content.append(text('strong', event.title), text('span', event.description))
      if (event.at !== undefined) content.appendChild(text('small', `${execution ? '+' + formatElapsed(event.at - execution.turn.startedAt) : new Date(event.at).toLocaleTimeString()} · ${stateLabel(event)}`))
      else content.appendChild(text('small', stateLabel(event)))
      button.append(number, content)
      button.onclick = mouse => select(event, mouse.detail === 0)
      row.appendChild(button); master.appendChild(row)
    }
    if (events.length === 0) note(master, 'No event evidence was recorded.')
    master.scrollTop = scrollTop
  }
  document.body.appendChild(modal.overlay)
  const boundary = activityEvents?.find(event => event.source.kind === 'tool' && event.source.call.id === activity?.evidence.callId)
  if (boundary) select(boundary)
  else renderOverview()
  close.focus()
}

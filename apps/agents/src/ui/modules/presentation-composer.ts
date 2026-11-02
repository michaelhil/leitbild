import { currentWorkspaceId } from './api-client.ts'
import { $selectedRoomId } from './stores.ts'
import { createPresentationComposerModel, type DraftChoice } from './presentation-composer-model.ts'
import { parsePresentationClear, parsePresentationDraft, parsePresentationOffer, sameRecipient } from './presentation-wire.ts'
import type { WSOutbound } from '../../core/types/ws-protocol.ts'
import { perspectiveView, samePerspectiveResource } from './perspective-view.ts'

export const initPresentationComposer = (deps: { chatInput: HTMLTextAreaElement; chatForm: HTMLFormElement; resetHeight: () => void }) => {
  const host = document.createElement('section')
  host.setAttribute('aria-label', 'Suggested prompts')
  host.setAttribute('aria-live', 'polite')
  host.className = 'px-3 text-sm'
  deps.chatForm.before(host)
  const relay = (message: unknown): void => { if (window.parent !== window) window.parent.postMessage(message, location.origin) }
  const model = createPresentationComposerModel({ workspaceId: currentWorkspaceId(), roomId: () => $selectedRoomId.get(),
    receipt: receipt => relay({ type: 'leitbild:presentation-receipt', receipt }),
    evidence: value => relay({ type: 'leitbild:presentation-evidence', ...value }),
  })
  const ready = (): void => {
    const id = $selectedRoomId.get()
    if (id) relay({ type: 'leitbild:presentation-ready', room: { workspaceId: currentWorkspaceId(), moduleId: 'agents', type: 'agents.room', id } })
  }
  const render = (): void => {
    host.replaceChildren()
    for (const { request } of model.suggestions()) {
      const card = document.createElement('div')
      card.className = 'my-2 p-3 rounded border border-border bg-surface'
      const title = document.createElement('strong')
      title.textContent = `${request.source.label} · suggested prompt`
      const purpose = document.createElement('p')
      purpose.textContent = request.purpose
      const text = document.createElement('pre')
      text.className = 'whitespace-pre-wrap my-2 text-text'
      text.textContent = request.action.kind === 'draft' ? request.action.text : ''
      const note = document.createElement('p')
      note.className = 'text-xs text-text-muted mb-2'
      note.textContent = 'Choose how to add it. Edit freely, then Send as yourself. Inserting does not send a message.'
      const choices = document.createElement('div')
      choices.className = 'flex flex-wrap gap-2'
      for (const [choice, label] of [['insert', 'Insert into empty draft'], ['append', 'Append to draft'], ['replace', 'Replace draft']] as const) {
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'mode-btn'; button.textContent = label
        button.disabled = choice === 'insert' && deps.chatInput.value.length !== 0
        button.addEventListener('click', () => {
          const next = model.choose(request.id, choice as DraftChoice, deps.chatInput.value)
          if (next !== undefined) {
            deps.chatInput.value = next
            deps.resetHeight(); deps.chatInput.focus()
          }
          render()
        })
        choices.append(button)
      }
      const dismiss = document.createElement('button')
      dismiss.type = 'button'; dismiss.className = 'mode-btn'; dismiss.textContent = 'Dismiss'
      dismiss.addEventListener('click', () => { model.dismiss(request.id); render() })
      choices.append(dismiss)
      card.append(title, purpose, text, note, choices); host.append(card)
    }
    const chosen = model.chosen()
    if (chosen !== undefined) {
      const notice = document.createElement('p')
      notice.className = 'my-2 text-xs text-text-muted'
      notice.append(document.createTextNode(`Prompt linked to ${chosen.label}. Edit freely and Send as yourself. `))
      const unlink = document.createElement('button')
      unlink.type = 'button'; unlink.className = 'underline'; unlink.textContent = 'Remove link'
      unlink.addEventListener('click', () => { model.unlink(); render() })
      notice.append(unlink); host.append(notice)
    }
    host.hidden = host.childElementCount === 0
  }
  const receive = (event: MessageEvent): void => {
    if (event.origin !== location.origin || event.source !== window.parent || window.parent === window) return
    const offer = parsePresentationOffer(event.data)
    if (offer !== null) {
      const privateSubject = perspectiveView.current()?.perspective
      if (perspectiveView.privateIntent && offer.recipient !== null && (privateSubject === undefined || !samePerspectiveResource(offer.recipient.subject, privateSubject))) {
        model.offer(null); render(); return
      }
      model.offer(offer.recipient); render(); ready(); return
    }
    const draft = parsePresentationDraft(event.data)
    if (draft !== null) { model.receive(draft.request, draft.room); render(); return }
    const clear = parsePresentationClear(event.data), current = model.recipient()
    if (clear !== null && current !== undefined && sameRecipient(clear.recipient, current)) {
      const matchingRoom = clear.room.id === $selectedRoomId.get()
      if (matchingRoom) { model.clear(clear.requestId); render() } // Never erase text already edited by the person.
      if (clear.clearRequestId !== undefined) relay({ type: 'leitbild:presentation-receipt', receipt: {
        requestId: clear.clearRequestId, documentId: current.documentId,
        status: matchingRoom ? 'applied' : 'unavailable', at: new Date().toISOString(),
        reason: matchingRoom ? 'Owned suggestion and prompt link cleared; edited text retained' : 'The exact Assistant Room is no longer open',
      } })
    }
  }
  window.addEventListener('message', receive)
  deps.chatInput.addEventListener('beforeinput', event => {
    const input = event as InputEvent
    if (deps.chatInput.value.length > 0 && deps.chatInput.selectionStart === 0 && deps.chatInput.selectionEnd === deps.chatInput.value.length
      && (input.inputType.startsWith('insert') || input.inputType.startsWith('delete'))) model.input(deps.chatInput.value, true)
  })
  deps.chatInput.addEventListener('input', () => { model.input(deps.chatInput.value); render() })
  $selectedRoomId.listen(() => { model.roomChanged(); render(); ready() })
  render()
  ready()
  return {
    postContext: model.postContext,
    submitted: () => { model.submitted(); render() },
    clearSource: () => { model.input('', true); render() },
    observeWire(raw: unknown): void {
      const msg = raw as WSOutbound
      if (msg.type === 'presentation_prompt_posted') model.acknowledge(msg.link, msg.roomId, msg.messageId)
      if (msg.type === 'message' && msg.message.generationTraceId !== undefined) model.response(msg.message.inReplyTo ?? [])
      if (msg.type === 'agent_state' && msg.state === 'idle') model.refreshEvidence()
    },
  }
}

// ```leitbild-view post-render processor. A fence becomes a live Module view
// only inside a posted AI answer whose own turn produced it; everywhere else
// (human messages, comparison alternatives) it is an explicit notice.
import { addPostRenderProcessor } from '../extensions/post-render-registry.ts'
import { apiFetch, currentWorkspaceId } from '../api-client.ts'
import { VIEW_FENCE_LANGUAGE } from '../../../core/render-validators/view-fence.ts'
import { resolveViewFence } from './resolve.ts'
import { registerLiveView } from './liveness.ts'

const fetchJson = async (path: string): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await apiFetch(path)
  return { status: response.status, body: response.status === 200 ? await response.json() : null }
}

const notice = (text: string): HTMLElement => {
  const element = document.createElement('div')
  element.className = 'my-2 px-3 py-2 rounded border border-border text-xs text-text-muted'
  element.textContent = text
  return element
}

const renderViewBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll<HTMLElement>(`code.language-${VIEW_FENCE_LANGUAGE}`)
  if (blocks.length === 0) return
  const roomId = container.dataset.viewRoom
  const turnId = container.dataset.viewTurn
  for (const code of blocks) {
    const pre = code.closest('pre') ?? code
    if (roomId === undefined || turnId === undefined) {
      pre.replaceWith(notice('Live displays appear only in the posted answer that composed them.'))
      continue
    }
    const wrapper = document.createElement('div')
    wrapper.className = 'my-2 rounded border border-border overflow-hidden'
    const body = document.createElement('div')
    wrapper.appendChild(body)
    body.appendChild(notice('Preparing display…'))
    pre.replaceWith(wrapper)
    const resolution = await resolveViewFence(code.textContent ?? '', { roomId, turnId, workspaceId: currentWorkspaceId() }, fetchJson)
    if (resolution.kind === 'refused') {
      wrapper.replaceWith(notice(`This display cannot be shown (${resolution.code}): ${resolution.message}.`))
      continue
    }
    registerLiveView(wrapper, body, resolution.envelope)
  }
}

addPostRenderProcessor('leitbild-view', renderViewBlocks)

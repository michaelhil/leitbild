import type { PresentationRecipient, PresentationRequest, PresentationReceipt, WorldPerspectiveReference } from '@leitbild/contracts'
import type { PresentationApplication } from './guidance-session.ts'
import type { PerspectiveOwnerClient } from './perspective-client.ts'

export interface PerspectiveAttentionScreen {
  recipient: PresentationRecipient | null
  suggestion: PresentationRequest | null
  cue: PresentationRequest | null
  error: string | null
}

const sameSubject = (left: PresentationRecipient['subject'], right: WorldPerspectiveReference): boolean =>
  left.workspaceId === right.workspaceId && left.moduleId === right.moduleId && left.type === right.type && left.id === right.id

/** A second delivery lease, never a replacement for the human Guide's canonical-Run lease. */
export const createPerspectivePresentationSession = (config: {
  resource: WorldPerspectiveReference
  owner: PerspectiveOwnerClient
  validate: () => Promise<boolean>
  apply: (request: PresentationRequest, signal: AbortSignal, cameraAllowed: boolean) => Promise<PresentationApplication>
  clear: (request: PresentationRequest) => void
  changed: (screen: PerspectiveAttentionScreen) => void
}) => {
  let closed = false, polling = false, connecting = false
  let screen: PerspectiveAttentionScreen = { recipient: null, suggestion: null, cue: null, error: null }
  const handled = new Set<string>(), applications = new Map<string, AbortController>()
  const update = (patch: Partial<PerspectiveAttentionScreen>): void => { if (!closed) { screen = { ...screen, ...patch }; config.changed(screen) } }
  const owned = (request: PresentationRequest): boolean => Boolean(screen.recipient
    && sameSubject(request.recipient.subject, config.resource)
    && request.recipient.documentId === screen.recipient.documentId && request.recipient.leaseId === screen.recipient.leaseId)
  const finish = async (request: PresentationRequest, result: PresentationApplication): Promise<void> => {
    if (closed || !owned(request) || !screen.recipient) return
    const receipt: PresentationReceipt = { requestId: request.id, documentId: request.recipient.documentId, ...result, at: new Date().toISOString() }
    await config.owner.receipt(config.resource, screen.recipient, receipt)
  }
  const clearVisualCue = (reason = 'cue-superseded'): void => {
    for (const application of applications.values()) application.abort(reason)
    applications.clear()
    if (screen.cue) { config.clear(screen.cue); update({ cue: null }) }
  }
  const apply = async (request: PresentationRequest): Promise<void> => {
    if (!owned(request)) return
    if (Date.parse(request.expiresAt) <= Date.now()) return finish(request, { status: 'expired', reason: 'The attention request expired before delivery' })
    if (request.action.kind === 'clear') {
      if (screen.cue?.id === request.action.requestId) clearVisualCue('cue-cleared')
      return finish(request, { status: 'applied' })
    }
    // The role pilot advertises this closed presentation subset; a draft cannot become an implicit command route.
    if (request.action.kind === 'draft' || request.mode !== 'suggest') return finish(request, { status: 'unavailable', reason: 'This Perspective supports accepted read-only attention suggestions only' })
    clearVisualCue()
    update({ cue: request })
    const controller = new AbortController()
    applications.set(request.id, controller)
    const timer = setTimeout(() => controller.abort('expired'), Math.max(0, Date.parse(request.expiresAt) - Date.now()))
    try { await finish(request, await config.apply(request, controller.signal, true)) }
    catch (error) {
      await finish(request, controller.signal.aborted
        ? { status: controller.signal.reason === 'manual-camera' ? 'superseded' : controller.signal.reason === 'expired' ? 'expired' : 'cancelled', reason: 'The owning attention cue was interrupted' }
        : { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
    } finally { clearTimeout(timer); applications.delete(request.id) }
  }
  const poll = async (): Promise<void> => {
    if (closed || polling || !screen.recipient) return
    polling = true
    try {
      if (!await config.validate() || closed || !screen.recipient) return
      const result = await config.owner.poll(config.resource, screen.recipient)
      if (closed) return
      if (!sameSubject(result.recipient.subject, config.resource) || result.recipient.documentId !== screen.recipient.documentId || result.recipient.leaseId !== screen.recipient.leaseId) throw new Error('The Perspective delivery document changed')
      update({ recipient: result.recipient, error: null })
      for (const request of result.requests) {
        if (!owned(request) || handled.has(request.id)) continue
        handled.add(request.id)
        if (handled.size > 256) handled.delete(handled.values().next().value!)
        if (request.action.kind === 'clear') await apply(request)
        else if (request.action.kind === 'draft' || request.mode !== 'suggest') await finish(request, { status: 'unavailable', reason: 'This Perspective supports accepted read-only attention suggestions only' })
        else if (screen.suggestion) await finish(request, { status: 'declined', reason: 'Another attention suggestion is waiting for your choice' })
        else update({ suggestion: request })
      }
      if (screen.suggestion && Date.parse(screen.suggestion.expiresAt) <= Date.now()) {
        const request = screen.suggestion
        update({ suggestion: null }); await finish(request, { status: 'expired', reason: 'The suggestion expired before you accepted it' })
      }
    } catch (error) {
      if (!closed) {
        clearVisualCue('receiver-unavailable')
        update({ recipient: null, suggestion: null, error: error instanceof Error ? error.message : String(error) })
      }
    } finally { polling = false }
  }
  const connect = async (): Promise<void> => {
    if (closed || connecting) return
    connecting = true
    const prior = screen.recipient
    clearVisualCue('receiver-replaced')
    update({ recipient: null, suggestion: null, error: null })
    try {
      if (prior) await config.owner.unregister(config.resource, prior)
      if (!await config.validate() || closed) return
      const recipient = await config.owner.register(config.resource)
      if (!sameSubject(recipient.subject, config.resource)) throw new Error('The owner returned a delivery lease for another Resource')
      if (closed) { await config.owner.unregister(config.resource, recipient); return }
      update({ recipient }); await poll()
    } catch (error) { update({ error: error instanceof Error ? error.message : String(error) }) }
    finally { connecting = false }
  }
  const timer = setInterval(() => { void poll() }, 3_000)
  void connect()
  return {
    reconnect: connect,
    accept: async () => { const request = screen.suggestion; if (!request) return; update({ suggestion: null }); await apply(request) },
    decline: async () => { const request = screen.suggestion; if (!request) return; update({ suggestion: null }); await finish(request, { status: 'declined', reason: 'You declined this attention suggestion' }) },
    clearVisualCue,
    clearCue: () => clearVisualCue('cue-cleared'),
    manualCamera: () => {
      if (screen.cue?.action.kind === 'focus' || screen.cue?.action.kind === 'reveal' && screen.cue.target.type === 'world.object') applications.get(screen.cue.id)?.abort('manual-camera')
    },
    stop: () => {
      if (closed) return
      clearVisualCue('receiver-closed'); closed = true; clearInterval(timer)
      const recipient = screen.recipient
      if (recipient) void config.owner.unregister(config.resource, recipient).catch(() => { console.warn('The detached Perspective view could not confirm lease closure; owner expiry still applies.') })
    },
  }
}
export type PerspectivePresentationSession = ReturnType<typeof createPerspectivePresentationSession>

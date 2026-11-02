import {
  presentationOfferMessageSchema, presentationReceiptMessageSchema, presentationEvidenceMessageSchema,
  presentationComposerRequestMessageSchema, presentationAssistantOpenMessageSchema, type PresentationRequest, type PresentationRecipient, type PresentationReceipt,
} from '@leitbild/contracts'
import { guideReadingSchema, presentationOutputs, type GuideReading } from '../core/guides/wire.ts'
import { withActiveRoleSet } from './roles/role-session.ts'
import { workspaceApiPath } from './workspace-context.ts'

export interface GuidanceScreen {
  recipient: PresentationRecipient | null
  guide: GuideReading | null
  suggestion: PresentationRequest | null
  cue: PresentationRequest | null
  busy: boolean
  error: string | null
  restored: boolean
  explored: boolean
}
export type PresentationApplication = { status: PresentationReceipt['status']; reason?: string }
export interface GuidanceSession {
  action: (action: 'start' | 'show' | 'next' | 'skip' | 'pause' | 'resume' | 'stop', takeover?: boolean) => Promise<void>
  read: () => Promise<void>
  reconnect: () => Promise<void>
  accept: () => Promise<void>
  decline: () => Promise<void>
  explore: () => void
  clearCue: () => void
  stop: () => void
  receive: (event: MessageEvent) => void
  manualCamera: () => void
}

/** Browser delivery is transient. Only an opaque attempt reference is retained; World owns all progress. */
export const createGuidanceSession = (config: {
  runId: string
  perspective: string
  apply: (request: PresentationRequest) => Promise<PresentationApplication>
  clear: (request: PresentationRequest) => void
  changed: (screen: GuidanceScreen) => void
  post: (message: unknown) => void
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}): GuidanceSession => {
  const key = `leitbild.guide-attempt:${config.runId}:${config.perspective}`
  let attempt: string | null = null
  try { attempt = config.storage.getItem(key) } catch { /* Denied storage leaves an independent attempt. */ }
  let screen: GuidanceScreen = { recipient: null, guide: null, suggestion: null, cue: null, busy: false, error: null, restored: attempt !== null, explored: false }
  let closed = false, polling = false, cameraHeld = false, guideUnavailable = false
  const handled = new Set<string>(), pendingDrafts = new Map<string, PresentationRequest>(), pendingClears = new Map<string, PresentationRequest>()
  const controller = new AbortController()
  const update = (patch: Partial<GuidanceScreen>): void => {
    if (closed) return
    if (patch.guide?.attemptId && patch.guide.attemptId === screen.guide?.attemptId && (patch.guide.revision ?? 0) < (screen.guide.revision ?? 0)) { const { guide: _stale, ...rest } = patch; patch = rest }
    screen = { ...screen, ...patch }; config.changed(screen)
  }
  const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
  const call = async (family: 'guide' | 'presentation', kind: string, input: unknown): Promise<unknown> => {
    const response = await fetch(withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(config.runId)}/${family}/${kind}`)), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), cache: 'no-store', signal: controller.signal,
    })
    const body = await response.json() as { result?: unknown; error?: { message?: string; code?: string } }
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `World answered HTTP ${response.status}`), { code: body.error?.code })
    return body.result
  }
  const readGuide = async (): Promise<void> => {
    if (guideUnavailable) return
    try {
      const readingAttempt = attempt
      const guide = guideReadingSchema.parse(await call('guide', 'read', { ...(attempt ? { attemptId: attempt } : {}), ...(screen.recipient && !screen.restored ? { recipient: screen.recipient } : {}) }))
      if (attempt === readingAttempt) update({ guide })
    } catch (error) {
      if ((error as { code?: string }).code === 'guide_not_available') { guideUnavailable = true; update({ guide: null }); return }
      if ((error as { code?: string }).code === 'guide_step_unavailable' && screen.guide?.attemptId) {
        const prior = screen.guide
        update({ guide: { available: true, title: prior.title, attemptId: prior.attemptId, ...(prior.status === undefined ? {} : { status: prior.status }), ...(prior.revision === undefined ? {} : { revision: prior.revision }), ...(prior.stepAttemptId === undefined ? {} : { stepAttemptId: prior.stepAttemptId }), problem: errorText(error) } })
      }
      throw error
    }
  }
  const owned = (request: PresentationRequest): boolean => Boolean(screen.recipient && request.recipient.documentId === screen.recipient.documentId && request.recipient.leaseId === screen.recipient.leaseId)
  const finish = async (request: PresentationRequest, result: PresentationApplication): Promise<void> => {
    if (closed || !owned(request) || !screen.recipient) return
    const receipt: PresentationReceipt = { requestId: request.id, documentId: request.recipient.documentId, ...result, at: new Date().toISOString() }
    const guide = screen.guide, effect = guide?.step?.effects.find(effect => effect.requestId === request.id)
    if (request.source.kind === 'guide' && guide?.attemptId === request.source.id && guide.stepAttemptId === request.source.executionId && effect) {
      update({ guide: guideReadingSchema.parse(await call('guide', 'receipt', { attemptId: guide.attemptId, stepAttemptId: guide.stepAttemptId, effectId: effect.id, recipient: screen.recipient, receipt })) })
    } else await call('presentation', 'receipt', { recipient: screen.recipient, receipt })
  }
  const clear = (): void => {
    if (screen.cue) config.clear(screen.cue)
    for (const draft of pendingDrafts.values()) if (draft.action.kind === 'draft') config.post({ type: 'leitbild:presentation-clear', recipient: draft.recipient, requestId: draft.id })
    pendingDrafts.clear()
    update({ cue: null })
  }
  const apply = async (request: PresentationRequest): Promise<void> => {
    if (!owned(request)) return
    if (Date.parse(request.expiresAt) <= Date.now()) return finish(request, { status: 'expired', reason: 'This presentation request expired before delivery' })
    if (request.action.kind === 'clear') {
      if (screen.cue?.id === request.action.requestId) { config.clear(screen.cue); update({ cue: null }) }
      const draft = pendingDrafts.get(request.action.requestId)
      if (draft) {
        pendingClears.set(request.id, request)
        config.post({ type: 'leitbild:presentation-clear', recipient: draft.recipient, requestId: draft.id, clearRequestId: request.id })
        pendingDrafts.delete(draft.id)
        return
      }
      return finish(request, { status: 'applied' })
    }
    if (request.mode === 'guide' && (screen.guide?.status !== 'active' || screen.restored || request.source.id !== screen.guide.attemptId || request.source.executionId !== screen.guide.stepAttemptId)) return finish(request, { status: 'unavailable', reason: 'This guide step is no longer active in this document; use Show to request it here' })
    if (request.action.kind === 'focus' && cameraHeld) return finish(request, { status: 'superseded', reason: 'Your map gesture took priority; use Show to request guidance again' })
    if (request.action.kind === 'reveal' && request.target.type === 'world.control' && request.target.id === 'assistant') {
      pendingDrafts.set(request.id, request)
      config.post(presentationAssistantOpenMessageSchema.parse({ type: 'leitbild:presentation-assistant-open', request }))
      return
    }
    if (request.action.kind === 'draft') {
      pendingDrafts.set(request.id, request)
      config.post(presentationComposerRequestMessageSchema.parse({ type: 'leitbild:presentation-compose', request }))
      return
    }
    if (screen.cue) config.clear(screen.cue)
    update({ cue: request })
    try { await finish(request, await config.apply(request)) }
    catch (error) { await finish(request, { status: 'unavailable', reason: errorText(error) }) }
  }
  const poll = async (): Promise<void> => {
    if (closed || polling || !screen.recipient) return
    polling = true
    try {
      const result = presentationOutputs.poll.parse(await call('presentation', 'poll', { recipient: screen.recipient }))
      if (closed) return
      update({ recipient: result.recipient })
      config.post(presentationOfferMessageSchema.parse({ type: 'leitbild:presentation-offer', recipient: result.recipient }))
      await readGuide()
      for (const request of result.requests) {
        if (handled.has(request.id)) continue
        handled.add(request.id)
        if (handled.size > 256) handled.delete(handled.values().next().value!)
        if (request.mode === 'suggest' && request.action.kind !== 'clear') {
          if (screen.suggestion) await finish(request, { status: 'declined', reason: 'Another attention suggestion is awaiting your choice' })
          else update({ suggestion: request })
        } else await apply(request)
      }
      if (screen.suggestion && Date.parse(screen.suggestion.expiresAt) <= Date.now()) update({ suggestion: null })
    } catch (error) {
      if (!closed) {
        const code = (error as { code?: string }).code
        update({ error: errorText(error), ...(code === 'guide_lease_conflict' ? { restored: true } : {}), ...(['no_recipient', 'presentation_perspective_changed'].includes(code ?? '') ? { recipient: null, restored: attempt !== null } : {}) })
        clear(); config.post({ type: 'leitbild:presentation-offer', recipient: null })
      }
    } finally { polling = false }
  }
  const action: GuidanceSession['action'] = async (kind, takeover = false) => {
    if (screen.busy || !screen.recipient) return
    update({ busy: true, error: null })
    try {
      const input = kind === 'start' ? { recipient: screen.recipient }
        : kind === 'show' ? { attemptId: attempt, recipient: screen.recipient, takeover }
        : { attemptId: attempt, recipient: screen.recipient, expectedRevision: screen.guide?.revision, action: kind, takeover }
      const guide = guideReadingSchema.parse(await call('guide', kind === 'start' || kind === 'show' ? kind : 'advance', input))
      if (guide.stepAttemptId !== screen.guide?.stepAttemptId || guide.status !== 'active') clear()
      if (['start', 'show', 'resume'].includes(kind)) cameraHeld = false
      attempt = guide.attemptId ?? null
      try { if (attempt) config.storage.setItem(key, attempt) } catch { /* Guide state remains on World. */ }
      update({ guide, restored: false, explored: false })
      await poll()
    } catch (error) { update({ error: errorText(error), ...((error as { code?: string }).code === 'guide_lease_conflict' ? { restored: true } : {}) }) }
    finally { update({ busy: false }) }
  }
  const receive: GuidanceSession['receive'] = (event) => {
    if (event.origin !== location.origin || event.source !== window.parent || closed) return
    if ((event.data as { type?: unknown } | null)?.type === 'leitbild:presentation-receipt') {
      const parsed = presentationReceiptMessageSchema.safeParse(event.data)
      if (!parsed.success) { update({ error: 'Host sent an invalid presentation receipt' }); return }
      const request = pendingDrafts.get(parsed.data.receipt.requestId) ?? pendingClears.get(parsed.data.receipt.requestId)
      if (!request || !owned(request) || parsed.data.receipt.documentId !== request.recipient.documentId) return
      pendingClears.delete(parsed.data.receipt.requestId)
      void finish(request, { status: parsed.data.receipt.status, ...(parsed.data.receipt.reason === undefined ? {} : { reason: parsed.data.receipt.reason }) }).catch(error => update({ error: errorText(error) }))
    }
    if ((event.data as { type?: unknown } | null)?.type === 'leitbild:presentation-evidence') {
      const parsed = presentationEvidenceMessageSchema.safeParse(event.data)
      if (!parsed.success) { update({ error: 'Host sent an invalid prompt evidence hint' }); return }
      const request = pendingDrafts.get(parsed.data.requestId), guide = screen.guide
      const effect = guide?.step?.effects.find(effect => effect.requestId === parsed.data.requestId)
      if (!request || request.action.kind !== 'draft' || !owned(request) || parsed.data.recipient.leaseId !== request.recipient.leaseId || !guide?.attemptId || !guide.stepAttemptId || !effect) return
      void call('guide', 'prompt', { attemptId: guide.attemptId, stepAttemptId: guide.stepAttemptId, effectId: effect.id, recipient: screen.recipient, room: parsed.data.room, requestId: parsed.data.requestId, messageId: parsed.data.messageId })
        .then(result => update({ guide: guideReadingSchema.parse(result), error: null })).catch(error => update({ error: errorText(error) }))
    }
  }
  const timer = setInterval(() => { void poll() }, 3_000)
  const connect = async (): Promise<void> => {
    try {
      update({ busy: true, error: null })
      const recipient = presentationOutputs.register.parse(await call('presentation', 'register', { clientId: crypto.randomUUID(), documentId: crypto.randomUUID() }))
      if (closed) { await call('presentation', 'unregister', { recipient }); return }
      update({ recipient }); config.post({ type: 'leitbild:presentation-offer', recipient }); await readGuide(); await poll()
    } catch (error) { if (!closed) update({ error: errorText(error) }) }
    finally { update({ busy: false }) }
  }
  void connect()
  return {
    action,
    reconnect: async () => { if (screen.busy) return; clear(); update({ recipient: null, suggestion: null, restored: attempt !== null }); config.post({ type: 'leitbild:presentation-offer', recipient: null }); await connect() },
    read: async () => { try { await readGuide() } catch (error) { update({ error: errorText(error) }) } },
    accept: async () => { const request = screen.suggestion; if (!request) return; update({ suggestion: null }); await apply(request) },
    decline: async () => { const request = screen.suggestion; if (!request) return; update({ suggestion: null }); await finish(request, { status: 'declined', reason: 'You declined this attention suggestion' }) },
    explore: () => update({ explored: true }),
    clearCue: clear,
    manualCamera: () => { cameraHeld = true },
    receive,
    stop: () => {
      clear(); clearInterval(timer); config.post({ type: 'leitbild:presentation-offer', recipient: null })
      const recipient = screen.recipient
      closed = true
      if (recipient) void call('presentation', 'unregister', { recipient }).catch(() => { /* The server also expires a lost document lease. */ })
      if (!recipient) controller.abort()
    },
  }
}

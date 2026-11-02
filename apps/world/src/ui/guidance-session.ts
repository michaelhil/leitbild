import {
  presentationOfferMessageSchema, presentationReceiptMessageSchema, presentationEvidenceMessageSchema,
  presentationComposerRequestMessageSchema, presentationAssistantOpenMessageSchema, type PresentationRequest, type PresentationRecipient, type PresentationReceipt,
} from '@leitbild/contracts'
import { guideReadingSchema, presentationOutputs, type GuideReading } from '../core/guides/wire.ts'
import { currentActiveRoleSet, searchWithRoleSet } from './roles/role-session.ts'
import { activeWorkspaceId, workspaceApiPath } from './workspace-context.ts'

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
  forgetAttemptReference: () => void
  invalidateSurface: () => void
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
  apply: (request: PresentationRequest, signal: AbortSignal, cameraAllowed: boolean) => Promise<PresentationApplication>
  clear: (request: PresentationRequest) => void
  changed: (screen: GuidanceScreen) => void
  post: (message: unknown) => void
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}): GuidanceSession => {
  const key = `leitbild.guide-attempt:${activeWorkspaceId()}:${config.runId}:${config.perspective}`
  const apiRoot = workspaceApiPath(`/simulation-runs/${encodeURIComponent(config.runId)}`)
  const ownRoles = currentActiveRoleSet()
  const roleQuery = searchWithRoleSet('', ownRoles)
  let referenceForgotten = false
  let attempt: string | null = null
  try { attempt = config.storage.getItem(key) } catch { /* Denied storage leaves an independent attempt. */ }
  let screen: GuidanceScreen = { recipient: null, guide: null, suggestion: null, cue: null, busy: false, error: null, restored: attempt !== null, explored: false }
  let closed = false, polling = false, cameraHeld = false, guideUnavailable = false, commandToken = 0, guidePresentationSuspended = false
  const appliedDrafts = new Set<string>()
  const handled = new Set<string>(), hostRequests = new Map<string, PresentationRequest>(), pendingClears = new Map<string, PresentationRequest>()
  const controller = new AbortController()
  const applications = new Map<string, AbortController>()
  const update = (patch: Partial<GuidanceScreen>): void => {
    if (closed || referenceForgotten) return
    if (patch.guide?.attemptId && patch.guide.attemptId === screen.guide?.attemptId && (patch.guide.revision ?? 0) < (screen.guide.revision ?? 0)) { const { guide: _stale, ...rest } = patch; patch = rest }
    screen = { ...screen, ...patch }; config.changed(screen)
  }
  const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
  const call = async (family: 'guide' | 'presentation', kind: string, input: unknown): Promise<unknown> => {
    const response = await fetch(`${apiRoot}/${family}/${kind}${roleQuery}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), cache: 'no-store', signal: controller.signal,
    })
    const body = await response.json() as { result?: unknown; error?: { message?: string; code?: string } }
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `World answered HTTP ${response.status}`), { code: body.error?.code })
    return body.result
  }
  // Keep this document's own receipts and commands ordered; World still checks revisions and the document lease.
  let guideWrites: Promise<void> = Promise.resolve()
  const writeGuide = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = guideWrites.then(() => { if (closed || referenceForgotten) throw new Error('The guide document changed'); return operation() })
    // Each caller receives its rejection; this continuation lets the next independent operation proceed.
    guideWrites = result.then(() => undefined, () => undefined)
    return result
  }
  const readGuide = async (): Promise<void> => {
    if (guideUnavailable || closed || referenceForgotten) return
    const readingAttempt = attempt
    try {
      const guide = guideReadingSchema.parse(await call('guide', 'read', { ...(attempt ? { attemptId: attempt } : {}), ...(screen.recipient && !screen.restored ? { recipient: screen.recipient } : {}) }))
      if (attempt === readingAttempt) update({ guide })
    } catch (error) {
      if (closed || referenceForgotten || attempt !== readingAttempt) return
      if ((error as { code?: string }).code === 'guide_attempt_unavailable' && readingAttempt !== null) {
        attempt = null
        try { config.storage.removeItem(key) } catch { /* A denied store cannot hold a resumable reference for this document. */ }
        update({ guide: null, restored: false, error: 'The previous guide attempt no longer exists in this Run. Start a new eligible attempt.' })
        await readGuide()
        return
      }
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
    const record = async (): Promise<void> => {
      if (closed || !owned(request) || !screen.recipient) return
      const guide = screen.guide, effect = guide?.step?.effects.find(effect => effect.requestId === request.id)
      if (request.source.kind === 'guide' && guide?.attemptId === request.source.id && guide.stepAttemptId === request.source.executionId && effect) {
        update({ guide: guideReadingSchema.parse(await call('guide', 'receipt', { attemptId: guide.attemptId, stepAttemptId: guide.stepAttemptId, effectId: effect.id, recipient: screen.recipient, receipt })) })
      } else await call('presentation', 'receipt', { recipient: screen.recipient, receipt })
    }
    if (request.source.kind === 'guide') await writeGuide(record)
    else await record()
  }
  const clear = (matches?: (request: PresentationRequest) => boolean): void => {
    if (!matches) { for (const application of applications.values()) application.abort('cue-cleared'); applications.clear() }
    if (screen.cue && (!matches || matches(screen.cue))) {
      applications.get(screen.cue.id)?.abort('cue-cleared'); applications.delete(screen.cue.id)
      config.clear(screen.cue); update({ cue: null })
    }
    for (const request of hostRequests.values()) if (!matches || matches(request)) {
      config.post({ type: 'leitbild:presentation-clear', recipient: request.recipient, requestId: request.id })
      hostRequests.delete(request.id); appliedDrafts.delete(request.id)
    }
  }
  const clearGuide = (): void => {
    const id = screen.guide?.attemptId
    if (id) clear(request => request.source.kind === 'guide' && request.source.id === id)
  }
  const ownCue = (request: PresentationRequest): void => {
    if (screen.cue) { applications.get(screen.cue.id)?.abort('cue-superseded'); applications.delete(screen.cue.id); config.clear(screen.cue) }
    update({ cue: request })
  }
  const apply = async (request: PresentationRequest, explicit = false): Promise<void> => {
    if (!owned(request)) return
    if (Date.parse(request.expiresAt) <= Date.now()) return finish(request, { status: 'expired', reason: 'This presentation request expired before delivery' })
    if (request.action.kind === 'clear') {
      if (screen.cue?.id === request.action.requestId) { applications.get(screen.cue.id)?.abort('cue-cleared'); applications.delete(screen.cue.id); config.clear(screen.cue); update({ cue: null }) }
      const draft = hostRequests.get(request.action.requestId)
      if (draft) {
        pendingClears.set(request.id, request)
        config.post({ type: 'leitbild:presentation-clear', recipient: draft.recipient, requestId: draft.id, clearRequestId: request.id })
        hostRequests.delete(draft.id); appliedDrafts.delete(draft.id)
        return
      }
      return finish(request, { status: 'applied' })
    }
    if (request.mode === 'guide' && guidePresentationSuspended) return finish(request, { status: 'cancelled', reason: 'The person interrupted guide presentation while its owner command completes' })
    if (request.mode === 'guide' && (screen.guide?.status !== 'active' || screen.restored || request.source.id !== screen.guide.attemptId || request.source.executionId !== screen.guide.stepAttemptId)) return finish(request, { status: 'unavailable', reason: 'This guide step is no longer active in this document; use Show to request it here' })
    if (request.action.kind === 'focus' && cameraHeld && !explicit) return finish(request, { status: 'superseded', reason: 'Your map gesture took priority; use Show to request guidance again' })
    ownCue(request)
    if (request.action.kind === 'reveal' && request.target.type === 'world.control' && request.target.id === 'assistant') {
      hostRequests.set(request.id, request)
      config.post(presentationAssistantOpenMessageSchema.parse({ type: 'leitbild:presentation-assistant-open', request }))
      return
    }
    if (request.action.kind === 'draft') {
      hostRequests.set(request.id, request)
      config.post(presentationComposerRequestMessageSchema.parse({ type: 'leitbild:presentation-compose', request }))
      return
    }
    const application = new AbortController()
    applications.set(request.id, application)
    const expireApplication = setTimeout(() => application.abort('expired'), Math.max(0, Date.parse(request.expiresAt) - Date.now()))
    try { await finish(request, await config.apply(request, application.signal, !cameraHeld || explicit)) }
    catch (error) { await finish(request, application.signal.aborted ? { status: application.signal.reason === 'manual-camera' ? 'superseded' : application.signal.reason === 'expired' ? 'expired' : 'cancelled', reason: 'The owning cue was interrupted before presentation completed' } : { status: 'unavailable', reason: errorText(error) }) }
    finally { clearTimeout(expireApplication); applications.delete(request.id) }
  }
  const poll = async (): Promise<void> => {
    if (closed || polling || !screen.recipient) return
    polling = true
    try {
      const result = presentationOutputs.poll.parse(await call('presentation', 'poll', { recipient: screen.recipient }))
      if (closed) return
      update({ recipient: result.recipient })
      config.post(presentationOfferMessageSchema.parse({ type: 'leitbild:presentation-offer', recipient: result.recipient }))
      try { await readGuide() } catch (error) { update({ error: errorText(error), ...((error as { code?: string }).code === 'guide_lease_conflict' ? { restored: true } : {}) }); clearGuide() }
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
      for (const [id, request] of hostRequests) if (!appliedDrafts.has(id) && Date.parse(request.expiresAt) <= Date.now()) hostRequests.delete(id)
      for (const [id, request] of pendingClears) if (Date.parse(request.expiresAt) <= Date.now()) pendingClears.delete(id)
    } catch (error) {
      if (!closed) {
        const code = (error as { code?: string }).code
        update({ error: errorText(error), ...(code === 'guide_lease_conflict' ? { restored: true } : {}), ...(['no_recipient', 'presentation_perspective_changed'].includes(code ?? '') ? { recipient: null, restored: attempt !== null } : {}) })
        if (['no_recipient', 'presentation_perspective_changed'].includes(code ?? '')) { clear(); config.post({ type: 'leitbild:presentation-offer', recipient: null }) }
        else clearGuide()
      }
    } finally { polling = false }
  }
  const action: GuidanceSession['action'] = async (kind, takeover = false) => {
    if (screen.busy || !screen.recipient) return
    const token = ++commandToken
    update({ busy: true, error: null })
    if (kind === 'pause' || kind === 'stop') { guidePresentationSuspended = true; clearGuide() }
    try {
      await writeGuide(async () => {
        const input = kind === 'start' ? { recipient: screen.recipient }
          : kind === 'show' ? { attemptId: attempt, recipient: screen.recipient, takeover }
          : { attemptId: attempt, recipient: screen.recipient, expectedRevision: screen.guide?.revision, action: kind, takeover }
        const guide = guideReadingSchema.parse(await call('guide', kind === 'start' || kind === 'show' ? kind : 'advance', input))
        if (closed || referenceForgotten || token !== commandToken) return
        if (guide.stepAttemptId !== screen.guide?.stepAttemptId || guide.status !== 'active') clearGuide()
        if (['start', 'show', 'resume'].includes(kind)) cameraHeld = false
        guidePresentationSuspended = guide.status !== 'active'
        attempt = guide.attemptId ?? null
        try { if (attempt) config.storage.setItem(key, attempt) } catch { /* Guide state remains on World. */ }
        update({ guide, restored: false, explored: false, busy: false })
      })
      await poll()
    } catch (error) { update({ error: errorText(error), ...((error as { code?: string }).code === 'guide_lease_conflict' ? { restored: true } : {}) }) }
    finally { if (token === commandToken) update({ busy: false }) }
  }
  const receive: GuidanceSession['receive'] = (event) => {
    if (event.origin !== location.origin || event.source !== window.parent || closed) return
    if ((event.data as { type?: unknown } | null)?.type === 'leitbild:presentation-receipt') {
      const parsed = presentationReceiptMessageSchema.safeParse(event.data)
      if (!parsed.success) { update({ error: 'Host sent an invalid presentation receipt' }); return }
      const request = hostRequests.get(parsed.data.receipt.requestId) ?? pendingClears.get(parsed.data.receipt.requestId)
      if (!request || !owned(request) || parsed.data.receipt.documentId !== request.recipient.documentId) return
      if (parsed.data.receipt.status === 'applied' && request.action.kind === 'draft') appliedDrafts.add(request.id)
      else { hostRequests.delete(parsed.data.receipt.requestId); appliedDrafts.delete(request.id) }
      pendingClears.delete(parsed.data.receipt.requestId)
      void finish(request, { status: parsed.data.receipt.status, ...(parsed.data.receipt.reason === undefined ? {} : { reason: parsed.data.receipt.reason }) }).catch(error => update({ error: errorText(error) }))
    }
    if ((event.data as { type?: unknown } | null)?.type === 'leitbild:presentation-evidence') {
      const parsed = presentationEvidenceMessageSchema.safeParse(event.data)
      if (!parsed.success) { update({ error: 'Host sent an invalid prompt evidence hint' }); return }
      void writeGuide(async () => {
        const request = hostRequests.get(parsed.data.requestId), guide = screen.guide
        const effect = guide?.step?.effects.find(effect => effect.requestId === parsed.data.requestId)
        if (!request || request.action.kind !== 'draft' || !owned(request) || parsed.data.recipient.leaseId !== request.recipient.leaseId || !guide?.attemptId || !guide.stepAttemptId || !effect) return
        const result = await call('guide', 'prompt', { attemptId: guide.attemptId, stepAttemptId: guide.stepAttemptId, effectId: effect.id, recipient: screen.recipient, room: parsed.data.room, requestId: parsed.data.requestId, messageId: parsed.data.messageId })
        update({ guide: guideReadingSchema.parse(result), error: null })
      }).catch(error => update({ error: errorText(error) }))
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
    forgetAttemptReference: () => { clear(); referenceForgotten = true; try { config.storage.removeItem(key) } catch { /* Storage may be denied; this closed scope still cannot repersist it. */ } },
    invalidateSurface: () => {
      cameraHeld = true
      for (const application of applications.values()) application.abort('surface-changed')
      applications.clear()
      if (screen.cue && !hostRequests.has(screen.cue.id)) { config.clear(screen.cue); update({ cue: null }) }
    },
    reconnect: async () => { if (screen.busy) return; clear(); update({ recipient: null, suggestion: null, restored: attempt !== null }); config.post({ type: 'leitbild:presentation-offer', recipient: null }); await connect() },
    read: async () => { try { await readGuide(); update({ error: null }) } catch (error) { update({ error: errorText(error) }) } },
    accept: async () => { const request = screen.suggestion; if (!request) return; update({ suggestion: null }); await apply(request, true) },
    decline: async () => { const request = screen.suggestion; if (!request) return; update({ suggestion: null }); await finish(request, { status: 'declined', reason: 'You declined this attention suggestion' }) },
    explore: () => update({ explored: true }),
    clearCue: () => { const id = screen.cue?.id; if (id) clear(request => request.id === id) },
    manualCamera: () => { cameraHeld = true; if (screen.cue?.action.kind === 'focus' || screen.cue?.action.kind === 'reveal' && screen.cue.target.type === 'world.object') applications.get(screen.cue.id)?.abort('manual-camera') },
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

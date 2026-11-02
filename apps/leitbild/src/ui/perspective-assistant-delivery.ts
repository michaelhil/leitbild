import {
  perspectiveAssistantOfferMessageSchema, perspectiveAssistantSetupResultSchema,
  perspectiveViewLeaseSchema, perspectiveViewReadyMessageSchema,
  type PerspectiveAssistantOffer, type PerspectiveViewLease,
} from '@leitbild/contracts'

export interface PerspectiveDeliveryScreen {
  readonly offer: PerspectiveAssistantOffer | null
  readonly choosing: boolean
  readonly busy: boolean
  readonly lease: PerspectiveViewLease | null
  /** Stable across lease renewal; tokens never enter a request URL. */
  readonly frameUrl: string | null
  readonly ready: boolean
  readonly problem: string | null
}
const empty = (): PerspectiveDeliveryScreen => ({ offer: null, choosing: false, busy: false, lease: null, frameUrl: null, ready: false, problem: null })
const offerKey = (offer: PerspectiveAssistantOffer): string => JSON.stringify([
  offer.requestId, offer.admission?.resource, offer.admission?.admissionGeneration,
  offer.recipient?.clientId, offer.recipient?.documentId, offer.recipient?.leaseId,
])

/** Transient Host delivery only: World chooses roles, Agents owns Room/runtime and view tokens. */
export const createPerspectiveAssistantDelivery = (config: {
  workspaceId: () => string
  available: () => boolean
  postWorld: (data: unknown) => void
  postAgents: (data: unknown) => void
  request: (path: string, body: unknown, signal: AbortSignal) => Promise<unknown>
  changed: (screen: PerspectiveDeliveryScreen) => void
  uuid: () => string
  now: () => number
  timer: (ms: number, action: () => void) => () => void
}) => {
  let screen = empty(), generation = 0, controller = new AbortController(), documentId = config.uuid(), worldDocumentId = config.uuid(), closed = false
  let blocked = false, opening = false
  let stopExpiry = (): void => {}
  const update = (patch: Partial<PerspectiveDeliveryScreen>): void => { screen = { ...screen, ...patch }; if (!closed) config.changed(screen) }
  const reset = (): void => {
    generation++; controller.abort(); controller = new AbortController(); documentId = config.uuid(); blocked = false; opening = false; stopExpiry()
    screen = empty(); if (!closed) config.changed(screen)
  }
  const openView = async (): Promise<void> => {
    const offer = screen.offer
    if (closed || blocked || opening || !config.available() || !offer?.recipient || offer.admission?.status !== 'active') return
    if (offer.admission.runtimeAvailability?.status === 'unavailable') {
      blocked = true; update({ lease: null, frameUrl: null, ready: false, problem: offer.admission.runtimeAvailability.reason ?? 'This scoped runtime is unavailable. Start a fresh Assistant in World.' }); return
    }
    if (Date.parse(offer.recipient.expiresAt) <= config.now()) { update({ lease: null, frameUrl: null, ready: false }); return }
    if (screen.lease && Date.parse(screen.lease.expiresAt) - config.now() > 10_000) return
    const token = generation, expected = offerKey(offer)
    opening = true
    update({ busy: true })
    try {
      const lease = perspectiveViewLeaseSchema.parse(await config.request(`/api/workspaces/${encodeURIComponent(config.workspaceId())}/perspective-view`, {
        recipient: offer.recipient, agentsDocumentId: documentId,
      }, controller.signal))
      if (closed || token !== generation || !screen.offer || offerKey(screen.offer) !== expected) return
      const binding = offer.admission.binding
      if (!binding || lease.room.id !== binding.room.id || lease.room.workspaceId !== config.workspaceId()
        || lease.perspective.id !== offer.admission.resource.id || lease.documentId !== documentId || Date.parse(lease.expiresAt) <= config.now()) throw new Error('The private view does not belong to this exact Assistant document')
      if (screen.lease && (screen.lease.token !== lease.token || screen.lease.documentId !== lease.documentId)) throw new Error('The private view changed identity during renewal. Reconnect explicitly.')
      const frameUrl = screen.frameUrl ?? `/workspaces/${encodeURIComponent(config.workspaceId())}/agents?room=${encodeURIComponent(lease.room.id)}&view=focused#perspective-view=${encodeURIComponent(JSON.stringify(lease))}`
      update({ lease, frameUrl, problem: null })
      stopExpiry()
      stopExpiry = config.timer(Math.max(0, Date.parse(lease.expiresAt) - config.now()), () => {
        if (closed || token !== generation || screen.lease?.expiresAt !== lease.expiresAt) return
        blocked = true
        update({ lease: null, frameUrl: null, ready: false, problem: 'The private view expired before renewal. Reconnect to the current scope.' })
      })
      config.postAgents({ type: 'leitbild:perspective-view', lease })
    } catch (error) {
      if (closed || token !== generation || controller.signal.aborted) return
      blocked = true
      update({ lease: null, frameUrl: null, ready: false, problem: error instanceof Error ? error.message : String(error) })
    } finally { if (token === generation) { opening = false; update({ busy: false }) } }
  }
  return {
    state: () => screen,
    request: (): void => { if (config.available()) config.postWorld({ type: 'leitbild:perspective-assistant-request', worldDocumentId, requestId: config.uuid() }) },
    availabilityChanged: (): void => {
      if (!config.available()) reset()
      config.postWorld({ type: 'leitbild:perspective-assistant-availability', worldDocumentId, available: config.available() })
    },
    fromWorld: (data: unknown): void => {
      const parsed = perspectiveAssistantOfferMessageSchema.safeParse(data)
      if (!parsed.success || !config.available() || parsed.data.worldDocumentId !== worldDocumentId) return
      const offer = parsed.data
      if (offer.admission && offer.admission.resource.workspaceId !== config.workspaceId()) return
      if (!screen.offer || offerKey(screen.offer) !== offerKey(offer)) reset()
      const active = offer.admission?.status === 'active' && offer.recipient !== null
      update({ offer, choosing: offer.admission?.status === 'pending', ...(!active ? { lease: null, frameUrl: null, ready: false } : {}) })
      if (active) void openView()
    },
    choose: async (templateId: string): Promise<void> => {
      const offer = screen.offer
      if (!offer?.admission || offer.admission.status !== 'pending' || screen.busy || !config.available()) return
      const token = generation
      update({ busy: true, problem: null })
      try {
        const template = await config.request(`/api/workspaces/${encodeURIComponent(config.workspaceId())}/capabilities/agents.agent.configuration.read/invoke`, {
          resource: { workspaceId: config.workspaceId(), moduleId: 'agents', type: 'agents.agent', id: templateId }, input: {}, actor: { kind: 'human' },
        }, controller.signal) as { result?: { id?: string; revision?: string } }
        if (token !== generation || controller.signal.aborted) return
        if (template.result?.id !== templateId || typeof template.result.revision !== 'string') throw new Error('The selected template did not return its exact configuration revision')
        const result = perspectiveAssistantSetupResultSchema.parse(await config.request(`/api/workspaces/${encodeURIComponent(config.workspaceId())}/perspective-assistant`, {
          perspective: offer.admission.resource, templateId, templateRevision: template.result.revision, requestId: offer.requestId,
        }, controller.signal))
        if (closed || token !== generation || controller.signal.aborted) return
        if (result.admission.resource.id !== offer.admission.resource.id || result.admission.admissionGeneration !== offer.admission.admissionGeneration) throw new Error('The setup response belongs to another Perspective')
        update({ choosing: false })
        config.postWorld({ type: 'leitbild:perspective-assistant-result', worldDocumentId, requestId: offer.requestId, admission: result.admission })
      } catch (error) {
        if (closed || token !== generation || controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        update({ problem: message })
        config.postWorld({ type: 'leitbild:perspective-assistant-result', worldDocumentId, requestId: offer.requestId, problem: { code: 'perspective_setup_unconfirmed', message: message.slice(0, 500) } })
      } finally { if (token === generation) update({ busy: false }) }
    },
    fromAgents: (data: unknown): boolean => {
      const ready = perspectiveViewReadyMessageSchema.safeParse(data), lease = screen.lease
      if (!ready.success || !lease || Date.parse(lease.expiresAt) <= config.now()) return false
      if (ready.data.documentId !== lease.documentId || ready.data.room.id !== lease.room.id || ready.data.room.workspaceId !== lease.room.workspaceId
        || ready.data.perspective.id !== lease.perspective.id || ready.data.perspective.workspaceId !== lease.perspective.workspaceId) return false
      update({ ready: true }); return true
    },
    agentsLoaded: (replaced = false): void => {
      if (replaced) {
        generation++; controller.abort(); controller = new AbortController(); documentId = config.uuid(); blocked = false; opening = false; stopExpiry()
        update({ lease: null, frameUrl: null, ready: false })
        void openView()
        return
      }
      update({ ready: false })
      if (screen.lease) config.postAgents({ type: 'leitbild:perspective-view', lease: screen.lease })
    },
    retryView: (): void => {
      if (closed || opening || !config.available()) return
      blocked = false
      if (!screen.frameUrl) documentId = config.uuid()
      void openView()
    },
    worldUnloaded: (): void => { worldDocumentId = config.uuid(); reset() },
    dispose: (): void => { closed = true; reset() },
  }
}

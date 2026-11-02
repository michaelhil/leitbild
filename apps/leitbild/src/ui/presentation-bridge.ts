import {
  presentationComposerRequestMessageSchema, presentationAssistantOpenMessageSchema, presentationDraftMessageSchema, presentationEvidenceMessageSchema,
  presentationOfferMessageSchema, presentationReceiptMessageSchema, presentationReadyMessageSchema, presentationCleanupRequestMessageSchema,
  type PresentationRecipient, type PresentationRequest, type WorkspaceResourceReference,
} from '@leitbild/contracts'

const sameResource = (a: WorkspaceResourceReference, b: WorkspaceResourceReference): boolean =>
  a.workspaceId === b.workspaceId && a.moduleId === b.moduleId && a.type === b.type && a.id === b.id
const sameReceiver = (a: PresentationRecipient, b: PresentationRecipient): boolean =>
  sameResource(a.subject, b.subject) && a.clientId === b.clientId && a.documentId === b.documentId && a.leaseId === b.leaseId

/** Host routes transient UI delivery; World owns admission and durable guide evidence. */
export const createPresentationBridge = (config: {
  subject: () => WorkspaceResourceReference | null
  room: () => WorkspaceResourceReference | null
  openAssistant: () => Promise<WorkspaceResourceReference>
  postToWorld: (message: unknown) => void
  postToAgents: (message: unknown) => void
  error: (message: string) => void
  timer: (ms: number, action: () => void) => () => void
}) => {
  let recipient: PresentationRecipient | null = null
  let readyRoom: WorkspaceResourceReference | null = null
  let generation = 0, agentsGeneration = 0
  const deliveries = new Map<string, { request: PresentationRequest; room: WorkspaceResourceReference; stop: () => void; sent: boolean; sentGeneration?: number; acknowledged: boolean; receiptStatus?: 'applied' | 'declined' | 'unavailable' | 'expired' | 'superseded' | 'cancelled' }>()
  const offer = (): void => config.postToAgents(presentationOfferMessageSchema.parse({ type: 'leitbild:presentation-offer', recipient }))
  const current = (request: PresentationRequest): boolean => {
    const subject = config.subject()
    return recipient !== null && subject !== null && sameReceiver(recipient, request.recipient)
      && sameResource(subject, request.target.subject) && Date.parse(recipient.expiresAt) > Date.now()
  }
  const receipt = (request: PresentationRequest, status: 'unavailable' | 'expired', reason: string): void => {
    if (!current(request)) return
    config.postToWorld(presentationReceiptMessageSchema.parse({ type: 'leitbild:presentation-receipt', receipt: {
      requestId: request.id, documentId: request.recipient.documentId, status, reason, at: new Date().toISOString(),
    } }))
  }
  const flush = (): void => {
    for (const delivery of deliveries.values()) {
      if (delivery.sent || !current(delivery.request) || !readyRoom || !sameResource(readyRoom, delivery.room)) continue
      const room = config.room()
      if (!room || !sameResource(room, delivery.room)) continue
      if (Date.parse(delivery.request.expiresAt) <= Date.now()) { delivery.sent = true; delivery.acknowledged = true; delivery.receiptStatus = 'expired'; delivery.stop(); receipt(delivery.request, 'expired', 'The presentation request expired before its Room became ready'); continue }
      delivery.sent = true
      delivery.sentGeneration = agentsGeneration
      if (delivery.request.action.kind === 'reveal') {
        delivery.acknowledged = true; delivery.receiptStatus = 'applied'; delivery.stop()
        config.postToWorld(presentationReceiptMessageSchema.parse({ type: 'leitbild:presentation-receipt', receipt: { requestId: delivery.request.id, documentId: delivery.request.recipient.documentId, status: 'applied', reason: 'The exact Run Assistant Room is shown and its current composer document is ready', at: new Date().toISOString() } }))
      } else config.postToAgents(presentationDraftMessageSchema.parse({ type: 'leitbild:presentation-draft', request: delivery.request, room }))
    }
  }
  const compose = async (request: PresentationRequest): Promise<void> => {
    if (!current(request) || deliveries.has(request.id)) return
    const reveal = request.action.kind === 'reveal' && request.target.type === 'world.control' && request.target.id === 'assistant'
    if (!reveal && (request.target.type !== 'world.composer' || request.target.id !== 'assistant' || request.action.kind !== 'draft')) return receipt(request, 'unavailable', 'This is not the Run Assistant or its composer')
    const expectedGeneration = generation
    try {
      let room: WorkspaceResourceReference
      if (request.source.kind === 'guide' || request.source.kind === 'person') room = await config.openAssistant()
      else {
        const selected = config.room()
        if (!request.source.initiatingRoom || !selected || !sameResource(selected, request.source.initiatingRoom)) throw new Error('The originating Room is not currently shown')
        room = reveal ? await config.openAssistant() : selected
      }
      if (expectedGeneration !== generation || !current(request)) return
      if (Date.parse(request.expiresAt) <= Date.now()) return receipt(request, 'expired', 'The prompt suggestion expired while opening its Room')
      // This ledger survives insertion so evidence can later be relayed to the exact originating document.
      if (deliveries.size >= 64) {
        const terminal = [...deliveries].find(([, delivery]) => delivery.acknowledged && !(delivery.request.action.kind === 'draft' && delivery.receiptStatus === 'applied'))
        if (!terminal) throw new Error('This view is retaining too many pending attention requests or active prompt links; clear an owned cue before showing another')
        terminal[1].stop(); deliveries.delete(terminal[0])
      }
      const stop = config.timer(Math.max(0, Date.parse(request.expiresAt) - Date.now()), () => {
        const delivery = deliveries.get(request.id)
        if (delivery && !delivery.acknowledged) { delivery.sent = true; delivery.acknowledged = true; delivery.receiptStatus = 'expired'; receipt(request, 'expired', 'No presentation outcome was confirmed before delivery expired') }
      })
      deliveries.set(request.id, { request, room, stop, sent: false, acknowledged: false })
      offer(); flush()
    } catch (error) { receipt(request, 'unavailable', error instanceof Error ? error.message : String(error)) }
  }
  const clear = (): void => {
    generation++
    recipient = null
    for (const delivery of deliveries.values()) delivery.stop()
    deliveries.clear()
    offer()
  }
  return {
    fromWorld: (data: unknown): void => {
      const type = (data as { type?: unknown } | null)?.type
      if (type === 'leitbild:presentation-offer') {
        const parsed = presentationOfferMessageSchema.safeParse(data)
        if (!parsed.success) return config.error('World sent an invalid presentation receiver')
        const subject = config.subject(), next = parsed.data.recipient
        if (next && (!subject || !sameResource(subject, next.subject))) return config.error('Presentation receiver belongs to another Run')
        if (recipient && (!next || !sameReceiver(recipient, next))) clear()
        recipient = next; offer(); return
      }
      if (type === 'leitbild:presentation-compose' || type === 'leitbild:presentation-assistant-open') {
        const parsed = (type === 'leitbild:presentation-compose' ? presentationComposerRequestMessageSchema : presentationAssistantOpenMessageSchema).safeParse(data)
        if (!parsed.success) return config.error('World sent an invalid composer request')
        void compose(parsed.data.request)
      }
      if (type === 'leitbild:presentation-clear') {
        const parsed = presentationCleanupRequestMessageSchema.safeParse(data)
        if (!parsed.success) return config.error('World sent an invalid presentation cleanup')
        const value = parsed.data
        if (!recipient || !sameReceiver(value.recipient, recipient)) return
        const delivery = deliveries.get(value.requestId)
        if (!delivery || !current(delivery.request)) return
        config.postToAgents({ type, recipient, room: delivery.room, requestId: value.requestId, ...(value.clearRequestId ? { clearRequestId: value.clearRequestId } : {}) })
        if (value.clearRequestId) deliveries.set(value.clearRequestId, { ...delivery, request: { ...delivery.request, id: value.clearRequestId }, acknowledged: false })
        delivery.stop(); deliveries.delete(value.requestId)
      }
    },
    fromAgents: (data: unknown): void => {
      const type = (data as { type?: unknown } | null)?.type
      if (type === 'leitbild:presentation-ready') {
        const parsed = presentationReadyMessageSchema.safeParse(data)
        if (!parsed.success) return config.error('Agents sent an invalid composer readiness message')
        const room = config.room()
        if (room && sameResource(room, parsed.data.room)) { readyRoom = room; flush() }
        return
      }
      if (type === 'leitbild:presentation-receipt') {
        const parsed = presentationReceiptMessageSchema.safeParse(data)
        if (!parsed.success) return config.error('Agents sent an invalid presentation receipt')
        const delivery = deliveries.get(parsed.data.receipt.requestId), room = config.room()
        if (!delivery || !room || !sameResource(room, delivery.room) || !current(delivery.request)
          || delivery.sentGeneration !== agentsGeneration || parsed.data.receipt.documentId !== delivery.request.recipient.documentId) return
        delivery.acknowledged = true
        delivery.receiptStatus = parsed.data.receipt.status
        delivery.stop()
        config.postToWorld(parsed.data)
      }
      if (type === 'leitbild:presentation-evidence') {
        const parsed = presentationEvidenceMessageSchema.safeParse(data)
        if (!parsed.success) return config.error('Agents sent an invalid prompt evidence hint')
        const delivery = deliveries.get(parsed.data.requestId), room = config.room()
        if (!delivery || !room || !sameResource(room, delivery.room) || !sameResource(parsed.data.room, delivery.room)
          || delivery.sentGeneration !== agentsGeneration || !current(delivery.request) || !sameReceiver(parsed.data.recipient, delivery.request.recipient)) return
        config.postToWorld(parsed.data)
      }
    },
    worldUnloaded: clear,
    agentsUnloaded: (): void => {
      readyRoom = null; agentsGeneration++
      for (const delivery of deliveries.values()) if (delivery.sent && !delivery.acknowledged) receipt(delivery.request, 'unavailable', 'The Agents document closed before confirming delivery')
    },
    agentsLoaded: (): void => { readyRoom = null; agentsGeneration++; offer() },
    dispose: clear,
  }
}

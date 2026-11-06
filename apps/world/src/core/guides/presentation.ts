import {
  presentationRecipientSchema, presentationReceiptSchema, presentationRequestSchema,
  type PresentationAction, type PresentationRecipient, type PresentationRequest, type PresentationReceipt,
  type PresentationTarget,
} from '@leitbild/contracts'
import { guideFailure } from './errors.ts'

// A heartbeat every 15 s tolerates throttled/temporarily suspended tabs. Losing a lease never loses guide progress.
export const presentationLeaseMs = 60_000
// Matches the product's existing display-open wait budget, not a simulation timeout.
export const presentationDeliveryMs = 30_000
// One step and one analyst suggestion can each use the five display verbs plus cleanup, with room for retries.
export const presentationMaxPending = 16

const failure = (code: string, message: string) => guideFailure(code, message, code === 'no_recipient' ? 409 : 422)
const resourceKey = (subject: PresentationRecipient['subject']): string => JSON.stringify(subject)

interface Pending {
  readonly request: PresentationRequest
  readonly allowed: () => boolean
  receipt?: PresentationReceipt
  clearRequestId?: string
}

/** World-owned transient delivery. No physics, shared camera state, persistent browser bindings or background timers. */
export const createPresentationDelivery = (now: () => number = Date.now) => {
  const clients = new Map<string, PresentationRecipient>()
  const viewers = new Map<string, readonly string[]>()
  const guideLeases = new Map<string, string>()
  const requests = new Map<string, Pending>()

  const expire = (): void => {
    for (const [id, client] of clients) if (Date.parse(client.expiresAt) <= now()) { clients.delete(id); viewers.delete(id) }
    for (const id of viewers.keys()) if (!clients.has(id)) viewers.delete(id)
    for (const [id, lease] of guideLeases) if (!clients.has(lease)) guideLeases.delete(id)
    for (const [id, pending] of requests) {
      if (pending.receipt === undefined && Date.parse(pending.request.expiresAt) <= now()) {
        pending.receipt = { requestId: id, documentId: pending.request.recipient.documentId, status: 'expired', at: new Date(now()).toISOString() }
      }
      if (Date.parse(pending.request.expiresAt) + presentationDeliveryMs <= now()) requests.delete(id)
      // Receipts survive the delivery budget while their document lease is active. Guide receipts are saved separately.
      if (!clients.has(pending.request.recipient.leaseId)) requests.delete(id)
    }
  }

  const current = (raw: PresentationRecipient): PresentationRecipient => {
    expire()
    const recipient = presentationRecipientSchema.parse(raw)
    const live = clients.get(recipient.leaseId)
    if (!live || live.clientId !== recipient.clientId || live.documentId !== recipient.documentId
      || resourceKey(live.subject) !== resourceKey(recipient.subject)) {
      throw failure('no_recipient', 'This browser delivery offer is no longer current; open the suggestion in the current view')
    }
    return live
  }

  const acknowledge = (rawRecipient: PresentationRecipient, rawReceipt: PresentationReceipt): PresentationReceipt => {
    const recipient = current(rawRecipient), receipt = presentationReceiptSchema.parse(rawReceipt)
    const pending = requests.get(receipt.requestId)
    if (!pending || pending.request.recipient.leaseId !== recipient.leaseId || receipt.documentId !== recipient.documentId) {
      throw failure('presentation_receipt_stale', 'The receipt does not belong to this current browser request')
    }
    if (pending.receipt !== undefined) return pending.receipt
    // The owner rechecks access even if a client has already fetched the request.
    pending.receipt = pending.allowed() ? { ...receipt, at: new Date(now()).toISOString() }
      : { requestId: receipt.requestId, documentId: recipient.documentId, status: 'unavailable', reason: 'The target is no longer available to this request', at: new Date(now()).toISOString() }
    return pending.receipt
  }

  return {
    register: (input: { subject: PresentationRecipient['subject']; clientId: string; documentId: string }, roleIds: readonly string[] = []): PresentationRecipient => {
      expire()
      // A new document replaces the old one for this client/Run; it cannot consume old pending effects.
      for (const [id, client] of clients) if (client.clientId === input.clientId && resourceKey(client.subject) === resourceKey(input.subject)) clients.delete(id)
      const recipient = presentationRecipientSchema.parse({ ...input, leaseId: crypto.randomUUID(), expiresAt: new Date(now() + presentationLeaseMs).toISOString() })
      clients.set(recipient.leaseId, recipient)
      viewers.set(recipient.leaseId, [...roleIds])
      return recipient
    },
    roleIds: (recipient: PresentationRecipient): readonly string[] => {
      const roles = viewers.get(current(recipient).leaseId)
      if (roles === undefined) throw new Error('A registered presentation receiver has no owner perspective')
      return roles
    },
    unregister: (recipient: PresentationRecipient): void => { clients.delete(current(recipient).leaseId); expire() },
    claimGuide: (attemptId: string, recipient: PresentationRecipient, takeover: boolean): void => {
      const live = current(recipient), key = `${resourceKey(live.subject)}:${attemptId}`
      const prior = guideLeases.get(key)
      if (prior !== undefined && prior !== live.leaseId && !takeover) throw failure('guide_lease_conflict', 'This guide is active in another document; explicitly resume here or start an independent attempt')
      if (prior !== undefined && prior !== live.leaseId) {
        for (const pending of requests.values()) if (pending.request.source.kind === 'guide' && pending.request.source.id === attemptId && pending.receipt === undefined) {
          pending.receipt = { requestId: pending.request.id, documentId: pending.request.recipient.documentId, status: 'superseded', reason: 'The guide resumed in another document', at: new Date(now()).toISOString() }
        }
      }
      guideLeases.set(key, live.leaseId)
    },
    assertGuide: (attemptId: string, recipient: PresentationRecipient): void => {
      const live = current(recipient)
      if (guideLeases.get(`${resourceKey(live.subject)}:${attemptId}`) !== live.leaseId) throw failure('guide_lease_conflict', 'This document does not hold the current guide lease; explicitly resume here')
    },
    cancelGuide: (attemptId: string): void => {
      for (const entry of requests.values()) if (entry.request.source.kind === 'guide' && entry.request.source.id === attemptId && entry.receipt === undefined) {
        entry.receipt = { requestId: entry.request.id, documentId: entry.request.recipient.documentId, status: 'cancelled', reason: 'The person paused or stopped this guide', at: new Date(now()).toISOString() }
      }
    },
    renew: (recipient: PresentationRecipient): PresentationRecipient => {
      const live = current(recipient)
      const next = { ...live, expiresAt: new Date(now() + presentationLeaseMs).toISOString() }
      clients.set(next.leaseId, next)
      return next
    },
    current,
    request: (input: {
      id: string; recipient: PresentationRecipient; source: PresentationRequest['source']; target: PresentationTarget;
      action: PresentationAction; purpose: string; mode: PresentationRequest['mode']; allowed: () => boolean;
    }): PresentationRequest => {
      const recipient = current(input.recipient)
      if (!input.allowed()) throw failure('presentation_target_unavailable', 'The target is not available to this request')
      const prior = requests.get(input.id)
      if (prior !== undefined) {
        const original = prior.request
        if (original.source.id !== input.source.id || original.recipient.leaseId !== recipient.leaseId
          || JSON.stringify([original.target, original.action]) !== JSON.stringify([input.target, input.action])) {
          throw failure('presentation_request_conflict', 'The presentation request identity already names another action')
        }
        return original
      }
      if ([...requests.values()].filter(entry => entry.request.recipient.leaseId === recipient.leaseId && entry.receipt === undefined).length >= presentationMaxPending) {
        throw failure('presentation_busy', 'This browser already has pending attention requests; complete or dismiss them before adding more')
      }
      // The function is an owner policy port, never part of the wire.
      const { allowed: _allowed, ...wire } = input
      const request = presentationRequestSchema.parse({ ...wire, recipient, createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + presentationDeliveryMs).toISOString() })
      requests.set(request.id, { request, allowed: input.allowed })
      return request
    },
    pending: (recipient: PresentationRecipient): ReadonlyArray<PresentationRequest> => {
      const live = current(recipient)
      const pending: PresentationRequest[] = []
      for (const [id, entry] of requests) {
        if (entry.request.recipient.leaseId !== live.leaseId || entry.receipt !== undefined) continue
        if (!entry.allowed()) {
          entry.receipt = { requestId: id, documentId: live.documentId, status: 'unavailable', reason: 'The target is no longer available to this request', at: new Date(now()).toISOString() }
        } else pending.push(entry.request)
      }
      return pending
    },
    receipt: acknowledge,
    cancel: (rawRecipient: PresentationRecipient, requestId: string, issuerId?: string) => {
      const recipient = current(rawRecipient), original = requests.get(requestId)
      if (!original || original.request.recipient.leaseId !== recipient.leaseId || issuerId !== undefined && original.request.source.id !== issuerId) {
        throw failure('presentation_request_unavailable', 'This request is not available for this caller to cancel')
      }
      if (original.request.action.kind === 'clear') throw failure('presentation_request_unavailable', 'Cleanup cannot create another cleanup request')
      if (original.clearRequestId !== undefined) return { requestId, clearRequestId: original.clearRequestId, status: 'cancelled' as const }
      const pendingCount = [...requests.values()].filter(entry => entry.request.recipient.leaseId === recipient.leaseId && entry.receipt === undefined).length
      if (original.receipt !== undefined && pendingCount >= presentationMaxPending) throw failure('presentation_busy', 'Complete or dismiss a pending attention request before clearing another cue')
      if (original.receipt === undefined) original.receipt = { requestId, documentId: recipient.documentId, status: 'cancelled', at: new Date(now()).toISOString() }
      // A completed reveal is not undone. The receiver clears only this request's owned highlight/card/suggestion.
      const clearId = `clear:${crypto.randomUUID()}`
      const request = presentationRequestSchema.parse({ ...original.request, id: clearId, recipient,
        action: { kind: 'clear', requestId }, createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + presentationDeliveryMs).toISOString() })
      requests.set(clearId, { request, allowed: () => true })
      original.clearRequestId = clearId
      return { requestId, clearRequestId: clearId, status: 'cancelled' as const }
    },
    result: (recipient: PresentationRecipient, requestId: string) => {
      const live = current(recipient), pending = requests.get(requestId)
      if (!pending || pending.request.recipient.leaseId !== live.leaseId) throw failure('presentation_request_unavailable', 'This request is not available in the current document')
      return { requestId, status: pending.receipt?.status ?? 'pending', ...(pending.receipt === undefined ? {} : { receipt: pending.receipt }) }
    },
    clear: (subject: PresentationRecipient['subject']): void => {
      for (const [id, client] of clients) if (resourceKey(client.subject) === resourceKey(subject)) clients.delete(id)
      expire()
    },
  }
}
export type PresentationDelivery = ReturnType<typeof createPresentationDelivery>

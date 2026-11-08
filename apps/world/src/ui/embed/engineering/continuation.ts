import { engineeringContinuationReceiptSchema, type EmbeddedViewEnvelope, type EngineeringContinuationReceipt } from '@leitbild/contracts'

export const continuationJobId = (envelope: EmbeddedViewEnvelope): string => {
  if (envelope.moduleId !== 'world' || envelope.subject.type !== 'world.simulation-run' || envelope.viewType !== 'engineering.continuation') throw new Error('This view requires a World Run continuation')
  const state: unknown = JSON.parse(envelope.state)
  if (typeof state !== 'object' || state === null || Array.isArray(state) || Object.keys(state).join() !== 'jobId'
    || !('jobId' in state) || typeof state.jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(state.jobId)) throw new Error('The continuation locator is invalid')
  return state.jobId
}

export const continuationActive = (receipt: EngineeringContinuationReceipt): boolean =>
  ['queued', 'running', 'cancellation-requested'].includes(receipt.status)

/** A retry of a network request retains its key; an intentional new case gets a
 * new key. Replaying keeps the captured origin, refreshing captures the Run. */
export const continuationRequest = (receipt: EngineeringContinuationReceipt, refresh: boolean) => {
  const { replayJobId: _previous, ...request } = receipt.request
  return { ...request, ...(refresh ? {} : { replayJobId: receipt.jobId }) }
}

export const continuationClient = (envelope: EmbeddedViewEnvelope, request: typeof fetch = fetch) => {
  const invoke = async (operation: 'inspect' | 'submit' | 'cancel', input: unknown, idempotencyKey?: string): Promise<EngineeringContinuationReceipt> => {
    const response = await request(`/api/workspaces/${encodeURIComponent(envelope.subject.workspaceId)}/capabilities/world.engineering.continuation.${operation}/invoke`, {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: envelope.subject, input, actor: { kind: 'human' }, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(typeof body.error?.message === 'string' ? body.error.message : `Continuation ${operation} failed (${response.status})`)
    const receipt = engineeringContinuationReceiptSchema.parse(body.result)
    if (receipt.source.workspaceId !== envelope.subject.workspaceId || receipt.source.id !== envelope.subject.id || receipt.source.moduleId !== 'world') throw new Error('The returned continuation belongs to a different Run')
    if (operation !== 'submit' && receipt.jobId !== (input as { jobId: string }).jobId) throw new Error('The returned job does not match the requested continuation')
    return receipt
  }
  return {
    inspect: (jobId: string, offset = 0) => invoke('inspect', { jobId, offset, limit: 20 }),
    cancel: (jobId: string) => invoke('cancel', { jobId }),
    submit: (receipt: EngineeringContinuationReceipt, refresh: boolean, key: string) => invoke('submit', continuationRequest(receipt, refresh), key),
  }
}

/** Compare only samples established at the exact same elapsed time. A missing
 * remainder is never extrapolated into an endpoint or favourable difference. */
export const alignedContinuationSamples = (receipt: EngineeringContinuationReceipt) => {
  const baseline = receipt.cases.find(item => item.id === 'baseline')
  const variant = receipt.cases.find(item => item.id === 'variant')
  if (baseline === undefined || variant === undefined) return []
  return baseline.samples.flatMap(sample => {
    const other = variant.samples.find(item => item.elapsedSeconds === sample.elapsedSeconds)
    if (other === undefined) return []
    return sample.quantities.flatMap(quantity => {
      const comparison = other.quantities.find(item => item.id === quantity.id && item.unit === quantity.unit && item.quantity === quantity.quantity)
      return comparison === undefined ? [] : [{ elapsedSeconds: sample.elapsedSeconds, label: quantity.label, unit: quantity.unit, baseline: quantity.value, variant: comparison.value,
        difference: quantity.quality === 'good' && comparison.quality === 'good' ? comparison.value - quantity.value : null }]
    })
  })
}

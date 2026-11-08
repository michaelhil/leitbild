import type { EngineeringInputBasis } from '@leitbild/contracts'
import { checkViewEnvelope, engineeringViewState, type EngineeringViewState } from '../../../core/render-validators/view-fence.ts'

export interface EngineeringDatum {
  readonly name: string; readonly value: number; readonly quantity: string; readonly unit: string
  readonly simulationAt?: string; readonly quality: 'good' | 'unknown'; readonly origin: 'observation' | 'assumption'
}
export interface CalculationReceipt {
  readonly kind: 'engineering-calculation'; readonly title: string; readonly mode: 'reviewed-method' | 'exploratory-script'
  readonly createdAt: string; readonly inputs: ReadonlyArray<EngineeringDatum>; readonly sources: ReadonlyArray<EngineeringInputBasis>
  readonly observationRefs?: ReadonlyArray<{readonly name:string;readonly basisDigest:string;readonly quantityId:string}>
  readonly request: { readonly operation: 'calculate' | 'run'; readonly input: Record<string, unknown> }
  readonly outcome: unknown; readonly qualification: 'research-only'; readonly inputDigest: string; readonly programSource?: string
}
export interface SourceStatus { readonly allowed: boolean; readonly code?: string; readonly reason?: string }
export const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null

export const calculationLocator = (raw: unknown, workspaceId: string): EngineeringViewState => {
  const checked = checkViewEnvelope(raw, workspaceId)
  if (checked.kind !== 'view') throw new Error(`${checked.code}: ${checked.error}`)
  if (checked.envelope.moduleId !== 'agents' || checked.envelope.viewType !== 'engineering.result') throw new Error('This page requires an Agents engineering result')
  const state = engineeringViewState(checked.envelope.state)
  if (state === null) throw new Error('The engineering execution locator is invalid')
  return state
}

export const readCalculationReceipt = (value: unknown): CalculationReceipt => {
  const receipt = object(value)
  const request = object(receipt?.request)
  if (receipt?.kind !== 'engineering-calculation' || receipt.qualification !== 'research-only'
    || !['reviewed-method', 'exploratory-script'].includes(String(receipt.mode)) || typeof receipt.title !== 'string'
    || typeof receipt.createdAt !== 'string' || typeof receipt.inputDigest !== 'string'
    || !Array.isArray(receipt.inputs) || !Array.isArray(receipt.sources) || !Object.hasOwn(receipt, 'outcome')
    || request?.operation !== (receipt.mode === 'exploratory-script' ? 'run' : 'calculate') || object(request.input) === null) throw new Error('The retained calculation receipt is incomplete or has an unsupported shape')
  for (const raw of receipt.inputs) {
    const input = object(raw)
    if (input === null || typeof input.name !== 'string' || typeof input.value !== 'number' || !Number.isFinite(input.value)
      || typeof input.quantity !== 'string' || typeof input.unit !== 'string' || !['observation', 'assumption'].includes(String(input.origin))
      || !['good', 'unknown'].includes(String(input.quality))) throw new Error('The retained calculation contains an invalid input')
  }
  for (const raw of receipt.sources) {
    const source = object(raw)
    const frame = object(source?.frame)
    if (source === null || object(source.source) === null || frame === null || typeof frame.simulationAt !== 'string' || typeof frame.observedAt !== 'string') throw new Error('The retained calculation has an incomplete source time')
  }
  return receipt as unknown as CalculationReceipt
}

export const assumptionBindings = (receipt: CalculationReceipt): ReadonlyArray<{ readonly name: string; readonly value: number; readonly unit: string; readonly note: string }> => {
  const bindings = receipt.request.input.bindings
  if (!Array.isArray(bindings)) throw new Error('The retained request has no input bindings')
  return bindings.flatMap(raw => {
    const binding = object(raw)
    if (binding?.kind !== 'assumption') return []
    if (typeof binding.name !== 'string' || typeof binding.value !== 'number' || !Number.isFinite(binding.value) || typeof binding.unit !== 'string' || typeof binding.note !== 'string') throw new Error('The retained assumption cannot be edited')
    return [{ name: binding.name, value: binding.value, unit: binding.unit, note: binding.note }]
  })
}

export const snapshotRefreshSupported = (receipt: CalculationReceipt): boolean => {
  const frames = new Map<string, Set<string>>()
  for (const basis of receipt.sources) {
    const key = JSON.stringify([basis.source, basis.profile, basis.subjectId])
    const times = frames.get(key) ?? new Set<string>()
    times.add(JSON.stringify([basis.frame.epoch, basis.frame.sequence, basis.frame.simulationAt]))
    frames.set(key, times)
  }
  return [...frames.values()].every(times => times.size <= 1)
}

/** Editing changes only explicit assumption values. Observations, source
 * selectors, units, qualification and original evidence stay immutable. */
export const calculationRequest = (receipt: CalculationReceipt, edits: ReadonlyMap<string, string>, refresh: boolean) => {
  if (refresh && !snapshotRefreshSupported(receipt)) throw new Error('This result uses a historical window. Acquire a new dated sample window instead of snapshot refresh.')
  const assumptions = assumptionBindings(receipt)
  for (const name of edits.keys()) if (!assumptions.some(item => item.name === name)) throw new Error(`Cannot edit observation ${name}`)
  const bindings = (receipt.request.input.bindings as ReadonlyArray<unknown>).map(raw => {
    const binding = object(raw)!
    if (binding.kind !== 'assumption' || typeof binding.name !== 'string' || !edits.has(binding.name)) return binding
    const text = edits.get(binding.name)!.trim()
    const value = Number(text)
    if (text === '' || !Number.isFinite(value)) throw new Error(`${binding.name} requires a finite number`)
    return { ...binding, value }
  })
  return { operation: receipt.request.operation, input: { ...receipt.request.input, bindings }, ...(refresh ? { refresh: true } : {}) }
}

export const calculationApi = (workspaceId: string, request: typeof fetch = fetch) => {
  const path = (roomId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/agents/rooms/${encodeURIComponent(roomId)}/engineering`
  const read = async (response: Response): Promise<Record<string, unknown>> => {
    const body = object(await response.json())
    if (!response.ok) {
      const error = object(body?.error)
      throw new Error(typeof error?.message === 'string' ? error.message : typeof body?.error === 'string' ? body.error : `Engineering request failed (HTTP ${response.status})`)
    }
    if (body === null) throw new Error('The engineering response is unreadable')
    return body
  }
  return {
    open: async (locator: EngineeringViewState): Promise<{ receipt: CalculationReceipt; sourceStatus: ReadonlyArray<SourceStatus> }> => {
      const body = await read(await request(`${path(locator.roomId)}/${encodeURIComponent(locator.turnId)}/${encodeURIComponent(locator.toolCallId)}`, { cache: 'no-store' }))
      const receipt = readCalculationReceipt(body.receipt)
      if (!Array.isArray(body.sourceStatus) || body.sourceStatus.length !== receipt.sources.length
        || body.sourceStatus.some(status => typeof object(status)?.allowed !== 'boolean')) throw new Error('The source qualification response is incomplete')
      return { receipt, sourceStatus: body.sourceStatus as ReadonlyArray<SourceStatus> }
    },
    run: async (roomId: string, input: ReturnType<typeof calculationRequest>) => {
      const body = await read(await request(path(roomId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }))
      if (typeof body.turnId !== 'string' || typeof body.toolCallId !== 'string') throw new Error('The new execution has no retained locator')
      return { receipt: readCalculationReceipt(body.receipt), locator: { roomId, turnId: body.turnId, toolCallId: body.toolCallId } }
    },
  }
}

import { describe, expect, test } from 'bun:test'
import type { EmbeddedViewEnvelope, EngineeringContinuationReceipt } from '@leitbild/contracts'
import { alignedContinuationSamples, continuationActive, continuationClient, continuationJobId, continuationRequest } from '../src/ui/embed/engineering/continuation.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const jobId = '22222222-2222-4222-8222-222222222222'
const source = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' } as const
const envelope = { moduleId: 'world', subject: source, viewType: 'engineering.continuation', title: 'Cases', height: 650, state: JSON.stringify({ jobId }) } as EmbeddedViewEnvelope
const at = '2026-11-08T12:00:00.000Z'
const quantity = { id: 'temperature', label: 'Temperature', quantity: 'temperature', unit: 'degC', value: 100, quality: 'good' } as const
const sample = (elapsedSeconds: number, value: number) => ({ elapsedSeconds, simulationAt: at, modelElapsedMs: elapsedSeconds * 1000, quantities: [{ ...quantity, value }] })
const receipt: EngineeringContinuationReceipt = {
  jobId, source, status: 'partial', createdAt: at, updatedAt: at, expiresAt: at,
  request: { profile: 'plant-thermal', subjectId: 'plant', horizonSeconds: 60, sampleEverySeconds: 5, variant: { label: 'Variant', actions: [{ atSeconds: 0, path: 'cooler', value: 1 }] } },
  origin: { source, subjectId: 'plant', profile: 'plant-thermal', profileRevision: 'engineering-research-1', frame: { epoch: jobId, scenarioDigest: 'a'.repeat(64), restrictionRevision: 0, sequence: 0, simulationAt: at, observedAt: at }, quantities: [quantity], digest: 'b'.repeat(64) },
  cases: [
    { id: 'baseline', label: 'Baseline', status: 'partial', reachedSeconds: 10, modelElapsedMs: 10000, interventions: [], sampleCount: 3, samples: [sample(0, 100), sample(5, 99), sample(10, 98)] },
    { id: 'variant', label: 'Variant', status: 'failed', reachedSeconds: 5, modelElapsedMs: 5000, reason: 'Domain ended', interventions: [], sampleCount: 2, samples: [sample(0, 100), sample(5, 97)] },
  ], sampleOffset: 0, sampleLimit: 20, limits: { wallSeconds: 60, workerCount: 1, outputBytes: 1000 }, evidenceKind: 'exact-state-conditional-continuation', executionDigest: 'e'.repeat(64), observationGrid: 'new-grid-at-captured-origin', qualification: 'research-only',
}
const published = { ...receipt, view: { viewType: envelope.viewType, title: envelope.title, height: envelope.height, state: envelope.state } }

describe('operator continuation evidence', () => {
  test('partial cases align only common elapsed times, never compare mismatched endpoints', () => {
    expect(alignedContinuationSamples(receipt).map(item => [item.elapsedSeconds, item.difference])).toEqual([[0, 0], [5, -2]])
    expect(continuationActive(receipt)).toBe(false)
    expect(continuationActive({ ...receipt, status: 'cancellation-requested' })).toBe(true)
    const unknown = structuredClone(receipt)
    unknown.cases[1]!.samples[1]!.quantities[0]!.quality = 'unknown'
    expect(alignedContinuationSamples(unknown)[1]!.difference).toBeNull()
  })
  test('a deliberate replay pins origin while refresh removes any old replay selector', () => {
    expect(continuationRequest(receipt, false).replayJobId).toBe(jobId)
    expect(continuationRequest({ ...receipt, request: { ...receipt.request, replayJobId: jobId } }, true)).not.toHaveProperty('replayJobId')
  })
  test('opening inspects only; submissions are explicit and retain their supplied retry key', async () => {
    const calls: Array<{path:string;body:Record<string,unknown>}> = []
    const client = continuationClient(envelope, (async (path, init) => { calls.push({ path: String(path), body: JSON.parse(String(init!.body)) }); return Response.json({ result: published }) }) as typeof fetch)
    await client.inspect(continuationJobId(envelope))
    expect(calls.map(call => call.path.split('/').at(-2))).toEqual(['world.engineering.continuation.inspect'])
    await client.submit(receipt, false, 'same-key')
    await client.submit(receipt, false, 'same-key')
    expect(calls[1]!.body).toEqual(calls[2]!.body)
    expect(calls[1]!.body).toMatchObject({ resource: source, idempotencyKey: 'same-key', input: { replayJobId: jobId }, actor: { kind: 'human' } })
  })
  test('owner failures and cross-Run results are refused', async () => {
    const denied = continuationClient(envelope, (async () => Response.json({ error: { message: 'Origin expired' } }, { status: 409 })) as typeof fetch)
    await expect(denied.inspect(jobId)).rejects.toThrow('Origin expired')
    const forged = continuationClient(envelope, (async () => Response.json({ result: { ...published, source: { ...source, id: 'another-run' } } })) as typeof fetch)
    await expect(forged.inspect(jobId)).rejects.toThrow('different Run')
    expect(() => continuationJobId({ ...envelope, state: JSON.stringify({ jobId, url: 'https://untrusted.invalid' }) })).toThrow('locator is invalid')
  })
  test('a revoked-source cancellation acknowledges termination without protected evidence', async () => {
    const acknowledgement = { jobId, status: 'cancelled', evidenceAvailable: false }
    const client = continuationClient(envelope, (async () => Response.json({ result: acknowledgement })) as typeof fetch)
    expect(await client.cancel(jobId)).toEqual(acknowledgement)
    await expect(client.inspect(jobId)).rejects.toThrow()
    const mismatched = continuationClient(envelope, (async () => Response.json({ result: { ...acknowledgement, jobId: workspaceId } })) as typeof fetch)
    await expect(mismatched.cancel(jobId)).rejects.toThrow('different job')
    const unfinished = continuationClient(envelope, (async () => Response.json({ result: { ...acknowledgement, status: 'cancellation-requested' } })) as typeof fetch)
    await expect(unfinished.cancel(jobId)).rejects.toThrow()
    const leaking = continuationClient(envelope, (async () => Response.json({ result: { ...acknowledgement, source } })) as typeof fetch)
    await expect(leaking.cancel(jobId)).rejects.toThrow()
  })
})

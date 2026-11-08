import { describe, expect, test } from 'bun:test'
import { calculationApi, calculationLocation, calculationLocator, calculationRequest, readCalculationReceipt, type CalculationReceipt } from './model.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const locator = { roomId: 'room-1', turnId: 'turn-1', toolCallId: 'call_1_0' }
const envelope = { moduleId: 'agents', subject: { workspaceId, moduleId: 'agents', type: 'agents.room', id: locator.roomId }, viewType: 'engineering.result', state: JSON.stringify(locator), title: 'Calculation', height: 650 }
const receipt: CalculationReceipt = { kind: 'engineering-calculation', title: 'Example', mode: 'exploratory-script', qualification: 'research-only', createdAt: '2026-11-08T12:00:00Z', inputDigest: 'a'.repeat(64), inputs: [], sources: [], request: { operation: 'run', input: { title: 'Example', program: { source: 'input.heat.value * 2' }, bindings: [
  { kind: 'assumption', name: 'heat', value: 2, quantity: 'power', unit: 'MW', note: 'Assumed constant heat' },
  { kind: 'retained', name: 'observed', turnId: 'read', toolCallId: 'call_1_0', key: 'capture', quantityId: 'q' },
] } }, outcome: { status: 'completed', output: { value: 4 } } }

describe('retained calculation interaction', () => {
  test('new successful execution permalinks reopen exactly and preserve the original locator', () => {
    const next = { ...locator, turnId: 'new-turn' }
    const href = calculationLocation(envelope, workspaceId, next)
    const reloaded = JSON.parse(decodeURIComponent(href.split('#view=')[1]!))
    expect(calculationLocator(reloaded, workspaceId)).toEqual(next)
    expect(calculationLocator(envelope, workspaceId)).toEqual(locator)
    expect(calculationLocation(envelope, workspaceId, locator)).toContain(encodeURIComponent('turn-1'))
    expect(() => calculationLocation(envelope, workspaceId, { ...next, roomId: 'other-room' })).toThrow('Room')
    expect(() => calculationLocation(envelope, workspaceId, { ...next, turnId: '../private' })).toThrow('locator')
  })
  test('opening only reads exact owner evidence; a new execution requires an explicit run', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    const api = calculationApi(workspaceId, (async (path, init) => {
      calls.push({ path: String(path), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return Response.json(init?.method === 'POST' ? { receipt, turnId: 'new-turn', toolCallId: 'call_1_0' } : { receipt, sourceStatus: [] })
    }) as typeof fetch)
    expect((await api.open(locator)).receipt.title).toBe('Example')
    expect(calls).toEqual([{ path: `/api/workspaces/${workspaceId}/agents/rooms/room-1/engineering/turn-1/call_1_0`, method: 'GET', body: undefined }])
    const result = await api.run(locator.roomId, calculationRequest(receipt, new Map([['heat', '3']]), true))
    expect(result.locator.turnId).toBe('new-turn')
    expect(calls[1]).toMatchObject({ method: 'POST', body: { refresh: true, input: { bindings: [{ kind: 'assumption', value: 3 }, { kind: 'retained', quantityId: 'q' }] } } })
    expect((receipt.request.input.bindings as Array<{value?:number}>)[0]?.value).toBe(2)
  })
  test('edits cannot alter observations, invent provenance or submit nonfinite values', () => {
    expect(() => calculationRequest(receipt, new Map([['observed', '4']]), false)).toThrow('Cannot edit observation')
    for (const value of ['', 'Infinity', 'NaN', '1e999']) expect(() => calculationRequest(receipt, new Map([['heat', value]]), false)).toThrow('finite number')
    expect(calculationRequest(receipt, new Map(), false)).not.toHaveProperty('refresh')
  })
  test('wrong Workspace, Room and unexpected state cannot redirect a calculation view', () => {
    expect(calculationLocator(envelope, workspaceId)).toEqual(locator)
    expect(() => calculationLocator(envelope, '22222222-2222-4222-8222-222222222222')).toThrow('workspace')
    expect(() => calculationLocator({ ...envelope, state: JSON.stringify({ ...locator, roomId: 'another-room' }) }, workspaceId)).toThrow('Room')
    expect(() => calculationLocator({ ...envelope, state: JSON.stringify({ ...locator, url: '/private' }) }, workspaceId)).toThrow('locator')
  })
  test('missing output and failed scripts remain valid evidence; a missing wrapper is explicit', () => {
    expect(readCalculationReceipt({ ...receipt, outcome: { status: 'failed', error: { code: 'deadline', message: 'Timed out' } } }).outcome).toHaveProperty('status', 'failed')
    expect(() => readCalculationReceipt({ ...receipt, qualification: 'qualified' })).toThrow('unsupported shape')
    const { outcome: _, ...missing } = receipt
    expect(() => readCalculationReceipt(missing)).toThrow('incomplete')
  })
  test('owner errors and incomplete source qualification remain visible', async () => {
    const denied = calculationApi(workspaceId, (async () => Response.json({ error: 'Source scope changed', code: 'scope_changed' }, { status: 409 })) as typeof fetch)
    await expect(denied.open(locator)).rejects.toThrow('Source scope changed')
    const missing = calculationApi(workspaceId, (async () => Response.json({ receipt })) as typeof fetch)
    await expect(missing.open(locator)).rejects.toThrow('qualification response is incomplete')
  })
})

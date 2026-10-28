import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionStore } from './store.ts'
import type { ChatRequest } from '../types/llm.ts'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'leitbild-model-evidence-')); temporary.push(dir)
  const path = join(dir, 'executions.sqlite'), store = createExecutionStore(path)
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  return { dir, path, store }
}
const request = (): ChatRequest => ({ model: 'test', messages: [{ role: 'user', content: 'Inspect this exact state.' }], tools: [], systemBlocks: [{ text: 'Retained guidance.' }] })
const start = (ordinal: number) => ({ id: `model_${ordinal}`, ordinal, phase: 'initial' as const, startedAt: ordinal, status: 'running' as const, requestedModel: 'test' })

test('model evidence is unavailable for uncaptured turns and scoped to its exact Room', () => {
  const { store } = setup()
  try {
    expect(store.modelEvidence('room', 'turn')).toEqual({ modelCapture: 'unavailable', models: [], stages: [] })
    store.beginModelCapture('turn', 'room')
    store.recordModelStart('turn', start(1), request())
    expect(store.modelEvidence('room', 'turn').modelCapture).toBe('recorded')
    expect(store.getModelCall('another-room', 'turn', 'model_1')).toBeUndefined()
    expect(() => store.modelEvidence('another-room', 'turn')).toThrow('no longer exists')
  } finally { store.close() }
})

test('immutable request parts deduplicate prompts and schemas across every model pass', () => {
  const { path, store } = setup()
  try {
    store.beginModelCapture('turn', 'room')
    let fullCopies = 0
    for (let ordinal = 1; ordinal <= 12; ordinal++) {
      const value = request(), messages = [...value.messages, { role: 'user' as const, content: `Iteration ${ordinal}` }]
      const exact = { ...value, messages, systemBlocks: [{ text: 'Shared instructions '.repeat(3000) }] }
      fullCopies += Buffer.byteLength(JSON.stringify(exact))
      store.recordModelStart('turn', start(ordinal), exact)
      messages.push({ role: 'user', content: 'Mutation after the capture boundary' })
      expect(store.getModelCall('room', 'turn', `model_${ordinal}`)?.request.messages).toHaveLength(2)
    }
    const parts = join(`${path}.models`, 'turn', 'parts'), files = readdirSync(parts)
    const retainedBytes = files.reduce((sum, name) => sum + statSync(join(parts, name)).size, 0)
    expect(files).toHaveLength(16) // One settings, tool list, shared message and system block, plus twelve new messages.
    expect(retainedBytes).toBeLessThan(fullCopies / 10)
    expect(store.modelEvidence('room', 'turn').models).toHaveLength(12)
  } finally { store.close() }
})

test('ordinary details withhold protocol state, explicit sensitive details preserve exact bytes', () => {
  const { store } = setup()
  try {
    store.beginModelCapture('turn', 'room')
    const continuation = { provider: 'openrouter' as const, model: 'test', endpointHash: 'retained-route', reasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque-protocol' }] }
    store.recordModelStart('turn', start(1), { ...request(), messages: [{ role: 'assistant', content: '', continuation }] })
    store.recordModelComplete('turn', 'model_1', { content: 'Visible answer', continuation, durationMs: 3, metrics: { provider: 'test', model: 'test', promptTokens: 4 } })
    const ordinary = store.getModelCall('room', 'turn', 'model_1')!
    expect(ordinary.protocolWithheld).toBe(true)
    expect(ordinary.request.messages[0]).not.toHaveProperty('continuation')
    expect(ordinary.response).not.toHaveProperty('continuation')
    const sensitive = store.getModelCall('room', 'turn', 'model_1', true)!
    expect(sensitive.request.messages[0]?.continuation).toEqual(continuation)
    expect(sensitive.response?.continuation).toEqual(continuation)
    expect(sensitive.protocolWithheld).toBe(false)
  } finally { store.close() }
})

test('restart preserves incomplete model outcomes honestly and Room deletion removes every part', () => {
  const { path, store: initial } = setup()
  initial.beginModelCapture('turn', 'room')
  initial.recordModelStart('turn', start(1), request())
  initial.close()
  const restarted = createExecutionStore(path)
  try {
    expect(restarted.getTurn('room', 'turn')?.status).toBe('interrupted')
    expect(restarted.modelEvidence('room', 'turn').models[0]?.status).toBe('running')
    expect(restarted.getModelCall('room', 'turn', 'model_1')).not.toHaveProperty('response')
    restarted.deleteRoom('room')
    expect(existsSync(join(`${path}.models`, 'turn'))).toBe(false)
    expect(() => restarted.recordModelComplete('turn', 'model_1', { content: 'late', durationMs: 1, metrics: {} })).toThrow('no longer exists')
  } finally { restarted.close() }
})

test('message removal releases model evidence and content corruption never becomes an exact request', () => {
  const { path, store } = setup()
  try {
    store.beginModelCapture('turn', 'room')
    store.recordModelStart('turn', start(1), request())
    const manifest = JSON.parse(readFileSync(join(`${path}.models`, 'turn', 'manifest.json'), 'utf8'))
    const file = join(`${path}.models`, 'turn', 'parts', `${manifest.models[0].request.messages[0]}.json`)
    writeFileSync(file, '{"role":"user","content":"altered"}')
    expect(() => store.getModelCall('room', 'turn', 'model_1')).toThrow('content hash')
    store.linkMessage('turn', 'answer')
    store.deleteMessage('room', 'answer')
    expect(existsSync(join(`${path}.models`, 'turn'))).toBe(false)
    expect(store.getTurn('room', 'turn')).toBeUndefined()
  } finally { store.close() }
})

test('Room cleanup uses DB ownership and removes even an unreadable model manifest', () => {
  const { path, store } = setup()
  try {
    store.beginModelCapture('turn', 'room')
    store.recordModelStart('turn', start(1), request())
    writeFileSync(join(`${path}.models`, 'turn', 'manifest.json'), 'interrupted or corrupted metadata')
    expect(() => store.modelEvidence('room', 'turn')).toThrow()
    store.deleteRoom('room')
    expect(existsSync(join(`${path}.models`, 'turn'))).toBe(false)
    expect(store.getTurn('room', 'turn')).toBeUndefined()
  } finally { store.close() }
})

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { createExecutionStore, type ExecutionStore } from './store.ts'
import { createStorageBudget } from '@leitbild/module-runtime'

const paths: string[] = []
const stores: ExecutionStore[] = []
const path = () => { const dir = mkdtempSync(join(tmpdir(), 'leitbild-execution-test-')); paths.push(dir); return join(dir, 'executions.sqlite') }
const open = (file: string) => { const store = createExecutionStore(file); stores.push(store); return store }
const close = (store: ExecutionStore) => { store.close(); stores.splice(stores.indexOf(store), 1) }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of paths.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const identity = { id: 'turn-1', roomId: 'room-1', agentId: 'agent-1', startedAt: 1000 }
const attempt = { id: 'call-1', tool: 'workspace_call', arguments: { exact: ['opaque:identifier', 12.123456789] }, providerCallId: 'provider-local', startedAt: 1001 }

describe('durable execution evidence', () => {
  test('process kill preserves committed outcome and unfinished attempt without inventing a result', async () => {
    const file = path()
    const child = Bun.spawn({ cmd: [process.execPath, '-e', `
      import { createExecutionStore } from ${JSON.stringify(import.meta.resolve('./store.ts'))};
      const store = createExecutionStore(${JSON.stringify(file)});
      store.beginTurn(${JSON.stringify(identity)});
      store.recordAttempt(${JSON.stringify(identity.id)}, ${JSON.stringify(attempt)});
      store.recordOutcome(${JSON.stringify(identity.id)}, ${JSON.stringify(attempt.id)}, {success:true,data:{committed:42}});
      store.recordAttempt(${JSON.stringify(identity.id)}, ${JSON.stringify({ ...attempt, id: 'unfinished' })});
      console.log('committed');
      setInterval(() => {}, 1000);
    `], stdout: 'pipe', stderr: 'pipe' })
    try {
      const output = await child.stdout.getReader().read()
      expect(new TextDecoder().decode(output.value)).toContain('committed')
    } finally { child.kill('SIGKILL'); await child.exited }
    const store = open(file)
    expect(store.getCall(identity.roomId, identity.id, attempt.id)?.result).toEqual({ success: true, data: { committed: 42 } })
    expect(store.getCall(identity.roomId, identity.id, 'unfinished')?.result).toBeUndefined()
    expect(store.getTurn(identity.roomId, identity.id)?.status).toBe('interrupted')
  })

  test('attempt-only recovery is uncertain; no automatic retry or result is invented', () => {
    const file = path()
    let store = open(file)
    store.beginTurn(identity)
    store.recordAttempt(identity.id, attempt)
    close(store)
    store = open(file)
    expect(store.getTurn(identity.roomId, identity.id)).toMatchObject({ ...identity, status: 'interrupted' })
    expect(store.getCall(identity.roomId, identity.id, attempt.id)).toMatchObject({ arguments: attempt.arguments })
    expect(store.getCall(identity.roomId, identity.id, attempt.id)).not.toHaveProperty('result')
    expect(() => store.recordAttempt(identity.id, { ...attempt, id: 'retry' })).toThrow('finished execution turn')
  })

  test('exact outcome survives cancellation without a final message or model request', () => {
    const file = path()
    let store = open(file)
    store.beginTurn(identity)
    store.recordAttempt(identity.id, attempt)
    store.finishTurn(identity.id, 'interrupted', 'User cancelled')
    const result = { success: true, data: { title: 'Østfold', accepted: 'command-1', values: [false, null, 0, 12.123456789] } }
    store.recordOutcome(identity.id, attempt.id, result, 2000)
    expect(store.finishTurn(identity.id, 'completed')).toBe(false)
    close(store)
    store = open(file)
    expect(store.getTurn(identity.roomId, identity.id)).toMatchObject({ status: 'interrupted', reason: 'User cancelled' })
    expect(store.getCall(identity.roomId, identity.id, attempt.id)).toMatchObject({ arguments: attempt.arguments, result, completedAt: 2000 })
    expect(store.listCalls(identity.roomId, identity.id)[0]).not.toHaveProperty('result')
  })

  test('Room boundaries and deletion cannot be bypassed by a late outcome', () => {
    const store = open(path())
    store.beginTurn(identity)
    store.recordAttempt(identity.id, attempt)
    expect(store.getTurn('another-room', identity.id)).toBeUndefined()
    expect(store.getCall('another-room', identity.id, attempt.id)).toBeUndefined()
    expect(store.listCalls('another-room', identity.id)).toEqual([])
    store.deleteRoom(identity.roomId)
    expect(() => store.recordOutcome(identity.id, attempt.id, { success: true })).toThrow('no longer exists')
    expect(store.linkMessage(identity.id, 'late')).toBe(false)
    expect(store.listTurns(identity.roomId)).toEqual([])
  })

  test('message deletion removes its executions but not another turn', () => {
    const store = open(path())
    store.beginTurn(identity)
    store.recordAttempt(identity.id, attempt)
    store.linkMessage(identity.id, 'message-1')
    store.beginTurn({ ...identity, id: 'turn-2' })
    store.deleteMessage(identity.roomId, 'message-1')
    expect(store.getTurn(identity.roomId, identity.id)).toBeUndefined()
    expect(store.getTurn(identity.roomId, 'turn-2')).toBeDefined()
  })

  test('duplicate calls and outcomes fail rather than silently replacing exact evidence', () => {
    const store = open(path())
    store.beginTurn(identity)
    store.recordAttempt(identity.id, attempt)
    expect(() => store.recordAttempt(identity.id, attempt)).toThrow()
    store.recordOutcome(identity.id, attempt.id, { success: false, error: 'Network outcome unknown' })
    expect(() => store.recordOutcome(identity.id, attempt.id, { success: true })).toThrow('already recorded')
    expect(store.getCall(identity.roomId, identity.id, attempt.id)?.result).toEqual({ success: false, error: 'Network outcome unknown' })
  })

  test('deleting at quota releases physical space and permits a new attempt', async () => {
    const file = path()
    const store = open(file)
    const budget = createStorageBudget({ root: dirname(file), maxBytes: 1_000_000, maxWorkspaceBytes: 1_000_000, minFreeBytes: 0 })
    store.beginTurn(identity)
    store.recordAttempt(identity.id, attempt)
    // Known outcomes are retained even when they exceed an admission estimate.
    store.recordOutcome(identity.id, attempt.id, { success: true, data: 'x'.repeat(1_100_000) })
    expect(statSync(file).size).toBeGreaterThan(1_000_000)
    await expect(budget.withGrowth(dirname(file), 4096, async () => store.beginTurn({ ...identity, id: 'blocked' }))).rejects.toThrow('budget reached')
    store.deleteRoom(identity.roomId)
    expect(statSync(file).size).toBeLessThan(100_000)
    await budget.withGrowth(dirname(file), 4096, async () => {
      store.beginTurn({ ...identity, id: 'new' })
      store.recordAttempt('new', attempt)
    })
    expect(store.getCall(identity.roomId, 'new', attempt.id)?.arguments).toEqual(attempt.arguments)
  })

  test('pagination does not lose turns sharing the same millisecond', () => {
    const store = open(path())
    for (const id of ['turn-a', 'turn-b', 'turn-c']) store.beginTurn({ ...identity, id })
    const first = store.listTurns(identity.roomId, { limit: 2 })
    const next = store.listTurns(identity.roomId, { limit: 2, before: first[1]! })
    expect([...first, ...next].map(turn => turn.id)).toEqual(['turn-c', 'turn-b', 'turn-a'])
  })

  test('rejects an unknown on-disk schema without replacing existing content', () => {
    const file = path()
    const db = new Database(file)
    db.exec('CREATE TABLE user_evidence(value TEXT); INSERT INTO user_evidence VALUES (\'keep\');')
    db.close()
    expect(() => createExecutionStore(file)).toThrow('Unrecognized execution storage')
    const check = new Database(file)
    expect(check.query('SELECT value FROM user_evidence').get()).toEqual({ value: 'keep' })
    check.close()
  })

  test('representative writes scale with new outcomes, not the full Workspace', () => {
    const file = path()
    const store = open(file)
    const durations: number[] = []
    for (let index = 0; index < 40; index++) {
      const turn = { ...identity, id: `measured-${index}` }
      const before = performance.now()
      store.beginTurn(turn)
      store.recordAttempt(turn.id, attempt)
      store.recordOutcome(turn.id, attempt.id, { success: true, data: 'x'.repeat(index % 2 === 0 ? 1024 : 100_000) })
      store.finishTurn(turn.id, 'completed')
      durations.push(performance.now() - before)
    }
    durations.sort((a, b) => a - b)
    console.info(JSON.stringify({ executionStoreProbe: { transactionsPerTurn: 4, turns: 40, p50Ms: durations[20], p95Ms: durations[38], storageBytes: statSync(file).size } }))
    expect(store.listTurns(identity.roomId, { limit: 100 })).toHaveLength(40)
    // Deliberately no wall-clock assertion: this is measured evidence, not a
    // flaky CI promise about the disk or a relaxed durability setting.
  })
})

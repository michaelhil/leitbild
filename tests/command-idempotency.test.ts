import { describe, expect, test } from 'bun:test'
import type { Actor } from '../src/core/control-instances/actors.ts'
import {
  createCommandIdempotencyStore,
  issueCommandWithIdempotency,
} from '../src/core/api/command-idempotency.ts'
import type { ActorId, ClientId, CommandEnvelope, CommandId, CommandResult, ControlInstanceId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'

const actor: Actor = {
  id: 'actor:test' as ActorId,
  label: 'Test operator',
  role: 'operator',
}

const command = (config: {
  readonly id: string
  readonly idempotencyKey?: string
  readonly payload?: unknown
  readonly expectedRevision?: number
}): CommandEnvelope => ({
  id: config.id as CommandId,
  controlInstanceId: 'control-instance:test' as ControlInstanceId,
  actorId: actor.id,
  clientId: 'client:test' as ClientId,
  ...(config.idempotencyKey === undefined ? {} : { idempotencyKey: config.idempotencyKey }),
  kind: 'domain.command',
  targetObjectIds: ['object:1' as ObjectId],
  payload: config.payload ?? { value: 1 },
  issuedAt: '2026-05-25T00:00:00.000Z' as CommandEnvelope['issuedAt'],
  ...(config.expectedRevision === undefined ? {} : { expectedRevision: config.expectedRevision }),
})

const accepted = (commandId: CommandId): CommandResult => ({
  ok: true,
  commandId,
  acceptedAt: '2026-05-25T00:00:00.000Z' as IsoTimestamp,
})

const deferred = <T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} => {
  let resolveValue: ((value: T) => void) | null = null
  const promise = new Promise<T>((resolve): void => {
    resolveValue = resolve
  })
  return {
    promise,
    resolve: (value: T): void => {
      if (!resolveValue) throw new Error('deferred promise was not initialized')
      resolveValue(value)
    },
  }
}

describe('command idempotency', () => {
  test('replays the original result for duplicate keys', async () => {
    const store = createCommandIdempotencyStore()
    let executions = 0
    const first = await issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 3_600_000, maxEntries: 10 },
      actor,
      command: command({ id: 'command:first', idempotencyKey: 'idem-1' }),
      issue: async (_actor, issuedCommand) => {
        executions += 1
        return accepted(issuedCommand.id)
      },
      nowMs: 1_000,
    })
    const duplicate = await issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 3_600_000, maxEntries: 10 },
      actor,
      command: command({ id: 'command:duplicate', idempotencyKey: 'idem-1' }),
      issue: async (_actor, issuedCommand) => {
        executions += 1
        return accepted(issuedCommand.id)
      },
      nowMs: 2_000,
    })

    expect(executions).toBe(1)
    expect(first.ok).toBe(true)
    expect(duplicate.ok).toBe(true)
    expect(duplicate.ok ? duplicate.result.commandId : null).toBe('command:first' as CommandId)
    expect(duplicate.ok ? duplicate.replayed : false).toBe(true)
  })

  test('deduplicates concurrent duplicates with a single execution', async () => {
    const store = createCommandIdempotencyStore()
    const pending = deferred<CommandResult>()
    let executions = 0
    const issue = async (): Promise<CommandResult> => {
      executions += 1
      return await pending.promise
    }
    const first = issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 3_600_000, maxEntries: 10 },
      actor,
      command: command({ id: 'command:first', idempotencyKey: 'idem-2' }),
      issue,
      nowMs: 1_000,
    })
    const second = issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 3_600_000, maxEntries: 10 },
      actor,
      command: command({ id: 'command:second', idempotencyKey: 'idem-2' }),
      issue,
      nowMs: 1_001,
    })
    pending.resolve(accepted('command:first' as CommandId))
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(executions).toBe(1)
    expect(firstResult.ok ? firstResult.result.commandId : null).toBe('command:first' as CommandId)
    expect(secondResult.ok ? secondResult.result.commandId : null).toBe('command:first' as CommandId)
    expect(secondResult.ok ? secondResult.replayed : false).toBe(true)
  })

  test('returns 409 when the same key is reused with a different body', async () => {
    const store = createCommandIdempotencyStore()
    await issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 3_600_000, maxEntries: 10 },
      actor,
      command: command({ id: 'command:first', idempotencyKey: 'idem-3', payload: { value: 1 } }),
      issue: async (_actor, issuedCommand) => accepted(issuedCommand.id),
      nowMs: 1_000,
    })
    const conflict = await issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 3_600_000, maxEntries: 10 },
      actor,
      command: command({ id: 'command:second', idempotencyKey: 'idem-3', payload: { value: 2 } }),
      issue: async (_actor, issuedCommand) => accepted(issuedCommand.id),
      nowMs: 2_000,
    })

    expect(conflict).toEqual({
      ok: false,
      status: 409,
      code: 'idempotency_conflict',
      message: 'idempotency key was reused with a different command body',
    })
  })

  test('allows execution again after TTL expiry', async () => {
    const store = createCommandIdempotencyStore()
    let executions = 0
    const issue = async (_actor: Actor, issuedCommand: CommandEnvelope): Promise<CommandResult> => {
      executions += 1
      return accepted(issuedCommand.id)
    }
    await issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 100, maxEntries: 10 },
      actor,
      command: command({ id: 'command:first', idempotencyKey: 'idem-4' }),
      issue,
      nowMs: 1_000,
    })
    const afterTtl = await issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 100, maxEntries: 10 },
      actor,
      command: command({ id: 'command:second', idempotencyKey: 'idem-4' }),
      issue,
      nowMs: 1_100,
    })

    expect(executions).toBe(2)
    expect(afterTtl.ok ? afterTtl.result.commandId : null).toBe('command:second' as CommandId)
  })

  test('evicts oldest entries when the per-runtime cap is reached', async () => {
    const store = createCommandIdempotencyStore()
    let executions = 0
    const issue = async (_actor: Actor, issuedCommand: CommandEnvelope): Promise<CommandResult> => {
      executions += 1
      return accepted(issuedCommand.id)
    }
    await issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 3_600_000, maxEntries: 1 },
      actor,
      command: command({ id: 'command:first', idempotencyKey: 'idem-5' }),
      issue,
      nowMs: 1_000,
    })
    await issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 3_600_000, maxEntries: 1 },
      actor,
      command: command({ id: 'command:second', idempotencyKey: 'idem-6' }),
      issue,
      nowMs: 2_000,
    })
    const evictedReplay = await issueCommandWithIdempotency({
      store,
      idempotency: { ttlMs: 3_600_000, maxEntries: 1 },
      actor,
      command: command({ id: 'command:third', idempotencyKey: 'idem-5' }),
      issue,
      nowMs: 3_000,
    })

    expect(executions).toBe(3)
    expect(evictedReplay.ok ? evictedReplay.result.commandId : null).toBe('command:third' as CommandId)
    expect(store.entries.size).toBe(1)
  })
})

import { describe, expect, test } from 'bun:test'
import type { CapabilityInvocationResponse } from '../../../ui/types.ts'
import { createEinsatzClient, createIconCache, dispatchCommandIds, dispatchQueryIds, refusalOf } from './einsatz-client.ts'

const accepted = (commandId: string): CapabilityInvocationResponse =>
  ({ kind: 'command', replayed: false, result: { ok: true, commandId, acceptedAt: '2026-01-01T00:00:00.000Z' } }) as unknown as CapabilityInvocationResponse
const refused = (reason: string, code?: string): CapabilityInvocationResponse =>
  ({ kind: 'command', replayed: false, result: { ok: false, commandId: 'c', rejectedAt: '2026-01-01T00:00:00.000Z', reason, ...(code === undefined ? {} : { code }) } }) as unknown as CapabilityInvocationResponse

describe('Einsatz client', () => {
  test('commands go to the plan Capabilities with validated inputs and come back accepted with their commandId or refused with code and message', async () => {
    const sent: Array<[string, unknown]> = []
    const answers = [
      accepted('cmd-1'), refused('when_required: R1 is busy on J-2 until about 5 min', 'when_required'), refused('Run is stopped'),
      accepted('cmd-2'), refused('newer_order_exists: A newer order changed R1\'s plan since; undo that one, or give a new order', 'newer_order_exists'),
    ]
    const client = createEinsatzClient({
      query: async () => { throw new Error('no query expected') },
      invoke: async (capabilityId, input) => {
        sent.push([capabilityId, input])
        return answers.shift()!
      },
    })
    expect(await client.order({ units: ['r1'], stops: [{ taskId: 'j1' }] })).toEqual({ ok: true, commandId: 'cmd-1' })
    expect(await client.order({ units: ['r1'], stops: [{ taskId: 'j1' }] })).toEqual({ ok: false, code: 'when_required', text: 'R1 is busy on J-2 until about 5 min' })
    expect(await client.recall('r1')).toEqual({ ok: false, code: null, text: 'Run is stopped' })
    // Undo names the unit and the commandId its order answered with.
    expect(await client.undo('r1', 'cmd-1')).toEqual({ ok: true, commandId: 'cmd-2' })
    expect(await client.undo('r1', 'cmd-0')).toEqual({ ok: false, code: 'newer_order_exists', text: 'A newer order changed R1\'s plan since; undo that one, or give a new order' })
    expect(sent.map(([id]) => id)).toEqual([dispatchCommandIds.order, dispatchCommandIds.order, dispatchCommandIds.recall, dispatchCommandIds.undo, dispatchCommandIds.undo])
    expect(sent[3]).toEqual(['world.einsatz.unit.undo', { unitId: 'r1', commandId: 'cmd-1' }])
    // An input the Capability would refuse never leaves the browser.
    await expect(client.order({ units: [], stops: [{ taskId: 'j1' }] })).rejects.toThrow()
    await expect(client.undo('r1', '')).rejects.toThrow()
    await expect(client.reorder('r1', [{ id: 'step-1', state: 'queued' }], ['step-1', 'step-1'])).rejects.toThrow()
  })

  test('a refusal\'s code is the one the result sets, never read out of its text', () => {
    expect(refusalOf({ reason: 'drops_mismatch: R1 works for J-3', code: 'drops_mismatch' })).toEqual({ code: 'drops_mismatch', text: 'R1 works for J-3' })
    expect(refusalOf({ reason: 'drops_mismatch: R1 works for J-3' })).toEqual({ code: null, text: 'R1 works for J-3' })
  })

  test('answers are validated: a malformed situation or options answer rejects', async () => {
    const asked: string[] = []
    const client = createEinsatzClient({
      query: async capabilityId => {
        asked.push(capabilityId)
        return { counts: {} }
      },
      invoke: async () => accepted('x'),
    })
    await expect(client.situation()).rejects.toThrow()
    await expect(client.unitOptions('r1')).rejects.toThrow()
    await expect(client.recommend('j1')).rejects.toThrow()
    expect(asked).toEqual([dispatchQueryIds.situation, dispatchQueryIds.unitOptions, dispatchQueryIds.recommend])
  })

  test('a query answering as a command is an error', async () => {
    const client = createEinsatzClient({ query: async () => ({}), invoke: async () => ({ kind: 'query', result: {} }) })
    await expect(client.closeTask('j1')).rejects.toThrow('answered as a query')
  })

  test('icons are asked for once each; missing ones are reported', async () => {
    const loads: string[][] = []
    let changed = 0
    const icons = createIconCache({ load: async ids => { loads.push([...ids]); return new Map([['a', '<svg/>']]) }, changed: () => { changed += 1 } })
    icons.request(['a', 'b', 'a'])
    icons.request(['a', 'b'])
    await Bun.sleep(0)
    expect(loads).toEqual([['a', 'b']])
    expect([icons.svg('a'), icons.svg('b'), changed]).toEqual(['<svg/>', undefined, 1])
    expect(icons.missing()).toBe('No map artwork for icon: b')
  })
})

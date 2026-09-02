import { describe, expect, test } from 'bun:test'
import { validateWorldAssembly } from '../src/core/packs/assembly.ts'
import type { WorldPack } from '../src/core/packs/protocol.ts'
import type { PackRuntimeAdapter } from '../src/simulation/protocol.ts'
import { createTestPackRuntimeAdapters, testPacks } from './helpers.ts'

describe('World Pack assembly contract', () => {
  test('accepts the complete built-in Pack set', () => {
    const assembly = validateWorldAssembly({
      packs: testPacks,
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    expect(assembly.packs.map(pack => pack.descriptor.id)).toEqual(testPacks.map(pack => pack.descriptor.id))
  })

  test('rejects Packs without discovery descriptions', () => {
    const source = testPacks[0]
    const { description: _description, ...descriptor } = source.descriptor
    const pack = { ...source, descriptor } as unknown as WorldPack
    expect(() => validateWorldAssembly({ packs: [pack], runtimeAdapters: [] }))
      .toThrow('has no discovery description')
  })

  test('rejects capabilities outside their owning Pack namespace', () => {
    const adapters = createTestPackRuntimeAdapters()
    const source = adapters[0]!
    const capability = source.capabilities[0]!
    const adapter: PackRuntimeAdapter = {
      ...source,
      capabilities: [{ ...capability, id: 'world.foreign.invalid' }, ...source.capabilities.slice(1)],
    }
    expect(() => validateWorldAssembly({ packs: testPacks, runtimeAdapters: [adapter, ...adapters.slice(1)] }))
      .toThrow('exposes foreign Capability')
  })

  test('rejects Scenario types that the authoring catalog cannot construct', () => {
    const source = testPacks.find(pack => pack.descriptor.id === 'traffic')!
    const pack: WorldPack = {
      ...source,
      authoring: { itemTypes: source.authoring!.itemTypes.slice(1) },
    }
    expect(() => validateWorldAssembly({ packs: testPacks.map(candidate => candidate === source ? pack : candidate), runtimeAdapters: createTestPackRuntimeAdapters() }))
      .toThrow('Scenario item types and authoring item types differ')
  })
})

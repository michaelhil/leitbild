import { describe, expect, test } from 'bun:test'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { describeElectricGridPhysicalTargets } from '../src/packs/electric-grid/physical-targets.ts'

const gridObject = async () => (await compileScenarioDefinition({
  id: 'physical-grid-targets', title: 'Physical Grid targets',
  packs: [{ id: 'electric-grid', config: {}, items: [{
    type: 'grid', id: 'grid:physical-target-test', label: 'Physical target owner', location: [11.48, 59.08],
    model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: 'electric-grid.norway.summer-night-low' }, automation: { ref: 'electric-grid.frequency.nordic-2025' },
  }] }],
  world: { startsAt: '2026-10-25T00:00:00.000Z', environment: {} }, view: { map: { center: [11.48, 59.08], zoom: 16 } },
}, [electricGridPack], { routing: createDirectRoutingAdapter() })).initialObjects[0]!

describe('Grid-owned physical correspondence', () => {
  test('describes the structural graph and actual yard anchor without loading a simulator', async () => {
    const owner = await gridObject()
    const description = await describeElectricGridPhysicalTargets(owner)
    expect(description.objectId).toBe(owner.id)
    expect(description.modelRef).toBe('electric-grid.halden.four-unit')
    expect(description.modelDigest).toBe('3551eb6c70f93b5aa9bc98f1d64a3ce51d5187ce158bc54df4e394cddbaf5173')
    expect(description.subjects).toHaveLength(6405)
    const subjects = new Map(description.subjects.map(subject => [subject.id, subject]))
    expect(subjects.get('bus:curated-halden-pwr-switchyard@420')?.location).toEqual([11.48, 59.08])
    for (const destination of ['hasle', 'tegneby']) for (const circuit of [1, 2, 3]) expect(subjects.has(`branch:curated-halden-pwr-${destination}-${circuit}`)).toBe(true)
    for (const unit of [1, 2, 3, 4]) expect(subjects.has(`unit-${unit}-420kv`)).toBe(true)
  })

  test('operating conditions do not change structural identity, while a different graph does', async () => {
    const owner = await gridObject()
    const before = await describeElectricGridPhysicalTargets(owner)
    const changedPoint = { ...owner, packData: { ...owner.packData as Record<string, unknown>, operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak' } } }
    expect((await describeElectricGridPhysicalTargets(changedPoint)).modelDigest).toBe(before.modelDigest)
    const otherModel = { ...owner, packData: { ...owner.packData as Record<string, unknown>, model: { ref: 'electric-grid.norway.transmission' } } }
    const other = await describeElectricGridPhysicalTargets(otherModel)
    expect(other.modelDigest).not.toBe(before.modelDigest)
    expect(other.subjects.some(subject => subject.id === 'bus:curated-halden-pwr-switchyard@420')).toBe(false)
  })
})

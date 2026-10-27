import { expect, test } from 'bun:test'
import { physicalCollectionFloorGroups, physicalCollectionFloorChanges, physicalCollectionMixedSettings, physicalPlanLevelAfterModeChange } from '../src/ui/physical-layout/collection-floors.ts'
import type { PhysicalScenePresentation } from '../src/ui/map/physical-scene/types.ts'
const scene = (id: string, design: string | null = 'unit-design', levelId = 'all'): PhysicalScenePresentation => ({
  descriptor: { id, revision: 'r', targetObjectId: id, anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [10, 10, 8] }, locationValid: true, modelDigest: 'digest', subjectIds: [], ...(design === null ? {} : { geometryKey: design }), levels: [{ id: 'lower', label: 'Lower', elevation: 0, cutHeight: 2 }, { id: 'upper', label: 'Upper', elevation: 4, cutHeight: 6 }], scopes: [{ id: 'root', label: 'Authored unit', kind: 'unit', bounds: { min: [0, 0, 0], max: [10, 10, 8] }, levelIds: ['lower', 'upper'] }] },
  view: { mode: '3d', levelId, separation: 0, live: true, detail: 'auto', cutaway: true }, status: 'ready', occurrenceCount: 10, renderRevision: 0,
})
const label = (value: PhysicalScenePresentation) => `Placement ${value.descriptor.id}`
test('an exact repeated Design shares one floor control while another Design has its own complete profile', () => {
  const units = Array.from({length:4},(_,index)=>scene(`unit-${index}`)), base = scene('campus','site-design'), site = { ...base, descriptor:{...base.descriptor,levels:[{id:'ground',label:'Site datum',elevation:0,cutHeight:1}],scopes:[]}, view:{...base.view,levelId:'ground'} }
  const groups=physicalCollectionFloorGroups([...units,site],label)
  expect(groups).toHaveLength(2);expect(groups[0]!.scenes).toHaveLength(4);expect(groups[0]!.label).toBe('Authored unit');expect(groups[0]!.memberLabels).toEqual(units.map(label));expect(groups[1]!.levels.map(level=>level.id)).toEqual(['ground'])
  const changes=physicalCollectionFloorChanges(groups[0]!,'upper');expect(changes.map(change=>change.sceneId)).toEqual(units.map(unit=>unit.descriptor.id));expect(changes.every(change=>change.view.levelId==='upper')).toBe(true);expect(changes.some(change=>change.sceneId==='campus')).toBe(false)
})
test('equal labels or geometry extents cannot merge Designs, unidentified templates, or differing level profiles', () => {
  const a=scene('a'),differentDesign=scene('b','other'),base=scene('c'),privateA=scene('d',null),privateB=scene('e',null),changedCut={...base,descriptor:{...base.descriptor,levels:[{...a.descriptor.levels[0]!,cutHeight:3},a.descriptor.levels[1]!]}}
  expect(physicalCollectionFloorGroups([a,differentDesign,changedCut,privateA,privateB],label)).toHaveLength(5)
})
test('mixed selections are explicit; a group change preserves every member view setting and rejects invalid floors', () => {
  const a=scene('a'),base=scene('b','unit-design','lower'),b={...base,view:{...base.view,cutaway:false,live:false,separation:9}}
  const group=physicalCollectionFloorGroups([a,b],label)[0]!;expect(group.levelId).toBeNull();expect(physicalCollectionMixedSettings([a,b])).toEqual(['live','cutaway','separation'])
  const changes=physicalCollectionFloorChanges(group,'upper');expect(changes[1]!.view).toEqual({...b.view,levelId:'upper'});expect(b.view.levelId).toBe('lower')
  expect(()=>physicalCollectionFloorChanges(group,'invented')).toThrow('Unknown collection floor')
  const plan={...b,view:{...b.view,mode:'2d' as const}};expect(()=>physicalCollectionFloorChanges(physicalCollectionFloorGroups([a,plan],label)[0]!,'all')).toThrow('Unknown collection floor')
})
test('each source restores its own valid Plan floor and keeps an explicitly selected 3D floor', () => {
  const a=scene('a'),b=scene('b','other')
  expect(physicalPlanLevelAfterModeChange(a,'upper')).toBe('upper');expect(physicalPlanLevelAfterModeChange(b,'removed')).toBe('lower')
  const lower={...a,view:{...a.view,levelId:'lower'}};expect(physicalPlanLevelAfterModeChange(lower,'upper')).toBe('lower')
})
test('all placements and all distinct profiles remain accessible, without a count cap or truncated member population', () => {
  const repeated=Array.from({length:31},(_,index)=>scene(`u-${index}`)), others=Array.from({length:19},(_,index)=>scene(`other-${index}`,`design-${index}`))
  const groups=physicalCollectionFloorGroups([...repeated,...others],label);expect(groups).toHaveLength(20);expect(groups[0]!.memberLabels).toHaveLength(31);expect(groups.flatMap(group=>group.scenes)).toHaveLength(50)
})

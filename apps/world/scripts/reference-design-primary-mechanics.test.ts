import { expect, test } from 'bun:test'
import { checkColdPartition, coldReturnGeometry, compileCurrentPrimaryGraph, foldedGeometry, parsePrimaryBarrelGeometry,
  parsePrimaryMechanics, sectionMechanics, serializePrimaryConstraintSnapshot } from './reference-design-primary-mechanics'
import { currentPrimaryGraphFixture } from './reference-design-primary-mechanics.fixture'

test('cold channels and real header partition one inventory, never add a second old header', () => {
  checkColdPartition(20, 8, 4)
  expect(() => checkColdPartition(20, 8, 20)).toThrow()
  expect(() => checkColdPartition(20, 10, 4)).toThrow()
  expect(() => checkColdPartition(20, NaN, 4)).toThrow()
})

test('folded SG closes actual endpoint elevations and developed length', () => {
  const g = foldedGeometry(20, 2.5, 12, 3)
  expect(g.riseLength_m + g.crownLength_m + g.descentLength_m).toBeCloseTo(20, 12)
  expect(g.riseLength_m + g.radius_m).toBeCloseTo(9.5, 12)
  expect(g.descentLength_m + g.radius_m).toBeCloseTo(9, 12)
  // Independent midpoint integration of the selected straight/circular paths.
  let moment = 0
  const n = 10000
  for (let i = 0; i < n; i++) {
    const f = (i + .5) / n
    moment += (2.5 + f * g.riseLength_m) * g.riseLength_m / n
    moment += (3 + f * g.descentLength_m) * g.descentLength_m / n
    moment += (12 - g.radius_m + g.radius_m * Math.sin(Math.PI * f)) * g.crownLength_m / n
  }
  expect(Math.abs(moment / 20 - g.meanElevation_m)).toBeLessThan(1e-8)
  for (const length of [18, 18.5, 40, NaN]) expect(() => foldedGeometry(length, 2.5, 12, 3)).toThrow()
})

test('signed channel motion preserves nonnegative native kinetic energy and fixed inventory', () => {
  const f = sectionMechanics(8, .4, 700, 4000), r = sectionMechanics(8, .4, 700, -4000)
  expect(f.velocity_m_s).toBe(-r.velocity_m_s)
  expect(f.fluidKineticEnergy_J).toBe(r.fluidKineticEnergy_J)
  expect(f.fluidKineticEnergy_J).toBeCloseTo(.5 * 700 * 8 * (4000 / 280) ** 2, 8)
  expect(f.massFlowInertance_per_m).toBe(50)
  expect(sectionMechanics(8, .4, 700, 0).residenceTime_s).toBeNull()
  expect(sectionMechanics(8, .4, 700, 0).fluidKineticEnergy_J).toBe(0)
  expect(() => sectionMechanics(8, 0, 700, 1)).toThrow()
})

test('declared choices parse strictly and carry actual header height', () => {
  const doc = '```reference-primary-mechanics\n' + JSON.stringify({ design: 'LD-01', hotInsideDiameter_m: 1,
    pumpPassageInsideDiameter_m: .7, pumpPassageVolume_m3: 8, coldHeaderVolume_m3: 4,
    coldHeaderHeight_m: 1, coldReturnLength_m: .5, sgDevelopedLength_m: 20, downcomerBottom_m: -3, downcomerTop_m: 3 }) + '\n```'
  const parsed = parsePrimaryMechanics(doc)
  expect(parsed.coldHeaderHeight_m).toBe(1)
  expect(() => parsePrimaryMechanics(doc + '\n' + doc)).toThrow()
  expect(() => parsePrimaryMechanics(doc.replace('"coldHeaderHeight_m":1', '"coldHeaderHeight_m":0'))).toThrow()
})

test('barrel radii have one strict owner and finite return mouths fit the real annulus', () => {
  const barrelDocument = '```reference-primary-barrel-geometry\n{"innerRadius_m":1.9,"outerRadius_m":2}\n```'
  const barrel = parsePrimaryBarrelGeometry(barrelDocument)
  expect(() => parsePrimaryBarrelGeometry(barrelDocument + '\n' + barrelDocument)).toThrow()
  expect(() => parsePrimaryBarrelGeometry(barrelDocument.replace('1.9', '2.1'))).toThrow()
  expect(() => parsePrimaryBarrelGeometry(barrelDocument.replace('"outerRadius_m":2', '"outerRadius_m":2,"extra":0'))).toThrow()
  const selection = parsePrimaryMechanics('```reference-primary-mechanics\n' + JSON.stringify({ design: 'LD-01',
    hotInsideDiameter_m: 1, pumpPassageInsideDiameter_m: .7, pumpPassageVolume_m3: 8,
    coldHeaderVolume_m3: 4, coldHeaderHeight_m: 1, coldReturnLength_m: .5,
    sgDevelopedLength_m: 20, downcomerBottom_m: -3, downcomerTop_m: 3 }) + '\n```')
  const g = coldReturnGeometry(selection, barrel, 20)
  expect(g.area_m2).toBeCloseTo(2 * Math.PI * .7 ** 2 / 4, 14)
  expect(g.insideDiameter_m).toBeCloseTo(Math.SQRT2 * .7, 14)
  expect(g.wettedPerimeter_m).toBeCloseTo(Math.PI * g.insideDiameter_m, 14)
  expect(g.wettedPerimeter_m).not.toBeCloseTo(2 * Math.PI * .7, 6)
  expect(.5 * (g.annularOuterRadius_m ** 2 - g.annularInnerRadius_m ** 2) * g.mouthSectorAngle_rad)
    .toBeCloseTo(g.area_m2, 14)
  expect(g.mouthSectorAngle_rad).toBeLessThan(Math.PI)
  expect(g.mouthCentres_rad).toEqual([0, Math.PI])
  expect(g.meanElevation_m).toBe(3)
  expect(g.volumePerTrain_m3).toBeCloseTo(.3848451000647496, 14)
  expect(g.addedMainVolume_m3).toBe(2 * g.volumePerTrain_m3)
  expect(coldReturnGeometry({ ...selection, coldReturnLength_m: 1 }, barrel, 20).addedMainVolume_m3)
    .toBe(2 * g.addedMainVolume_m3)
  expect(() => coldReturnGeometry(selection, barrel, 0)).toThrow()
  expect(() => coldReturnGeometry(selection, barrel, 1)).toThrow()
  expect(() => coldReturnGeometry({ ...selection, coldHeaderHeight_m: .9 }, barrel, 20)).toThrow()
})

test('current physical graph has serial external core, four finite pumps and every open guide cohort', async () => {
  const fixture = await currentPrimaryGraphFixture(), graph = compileCurrentPrimaryGraph(fixture.input),
    byId = new Map(graph.nodes.map((n, i) => [n.id, i])),
    contacts = new Set(graph.edges.map(e => graph.nodes[e.from]!.id + '->' + graph.nodes[e.to]!.id))
  expect(graph.nodes).toHaveLength(76)
  expect(graph.edges).toHaveLength(82)
  // This tests the enumerated physical records, not a TS rank/cycle solver.
  expect(contacts.has('CORE.1->CORE.2')).toBe(true)
  expect(contacts.has('LOWER->CORE.2')).toBe(false)
  for (const loop of ['A', 'B']) for (const j of [1, 2]) {
    expect(contacts.has(`SG.${loop}.PRIMARY->P.${loop}${j}.PASSAGE`)).toBe(true)
    expect(contacts.has(`P.${loop}${j}.PASSAGE->COLD.${loop}`)).toBe(true)
  }
  for (const id of ['EMPTY', 'BODY', 'THIMBLE']) {
    expect(contacts.has('LOWER->GUIDE.' + id)).toBe(true)
    expect(contacts.has('GUIDE.' + id + '->UPPER')).toBe(true)
  }
  expect(contacts.has('HOT.A.J->SURGE')).toBe(true)
  expect(contacts.has('SURGE->PZR')).toBe(true)
  expect(graph.nodes.filter(n => n.id.startsWith('HOUSING.'))).toHaveLength(52)
  for (const h of fixture.input.housings) {
    expect(contacts.has('UPPER->' + h.id)).toBe(true)
    expect(graph.edges.filter(e => e.from === byId.get(h.id))).toHaveLength(0)
  }
  for (const loop of ['A', 'B']) {
    const sg = byId.get(`SG.${loop}.PRIMARY`)!, c = graph.carriers.find(c => c.supportIndex === sg)!
    expect(graph.edges[c.edgeIndex]!.to).toBe(sg) // NEVER one pump's half-flow.
  }
  expect(graph.physicalManifoldAdmitted).toBe(false)
  expect(graph.metricCoverageComplete).toBe(false)
  expect(graph.unassignedMomentumSupports).toContain(byId.get('HOT.A.J')!)
  expect(graph.unassignedMomentumSupports).toContain(byId.get('PZR')!)
  expect(fixture.identity.every(s => s.sha256.length === 64)).toBe(true)
})

test('current hardware displacement, guide end water and midpoint tee are counted once with their moments', async () => {
  const fixture = await currentPrimaryGraphFixture(), g = compileCurrentPrimaryGraph(fixture.input),
    sum = (ids: (id: string) => boolean) => g.nodes.filter(n => ids(n.id)).reduce((a, n) => a + n.volume_m3, 0)
  expect(sum(id => id.startsWith('GUIDE.'))).toBeCloseTo(fixture.expectedGuideVolume_m3, 11)
  expect(sum(id => ['LOWER', 'UPPER', 'CORE.1', 'CORE.2'].includes(id))).toBeCloseTo(fixture.expectedExteriorVolume_m3, 11)
  expect(sum(id => id.startsWith('HOUSING.'))).toBeCloseTo(fixture.expectedHousingVolume_m3, 11)
  expect(sum(id => id.startsWith('HOT.A.'))).toBeCloseTo(fixture.input.geometry['HOT.A'].volume_m3, 12)
  expect(g.totalVolume_m3).toBeCloseTo(fixture.expectedTotalVolume_m3, 10)
  expect(g.nodes.find(n => n.id === 'LOWER')!.volume_m3).toBeCloseTo(fixture.expectedLowerVolume_m3, 12)
  const moment = g.nodes.filter(n => ['LOWER', 'UPPER'].includes(n.id) || n.id.startsWith('HOUSING.'))
    .reduce((a, n) => a + n.volume_m3 * n.meanElevation_m, 0)
  expect(moment).toBeCloseTo(fixture.expectedFreeVolumeMoment_m4, 10)
  expect(g.nodes.find(n => n.id === 'UPPER')!.meanElevation_m).not.toBe(3)
  const once = new Set(g.carriers.map(c => c.supportIndex))
  expect(once.size).toBe(g.carriers.length)
  expect(g.carriers.length + g.unassignedMomentumSupports.length).toBe(g.nodes.length)
})

test('all physical contact heads share one datum and native stream keeps unassigned supports visible', async () => {
  const fixture = await currentPrimaryGraphFixture(), g = compileCurrentPrimaryGraph(fixture.input), d = structuredClone(fixture.input)
  for (const q of Object.values(d.geometry)) {
    q.meanElevation_m += 100
    if (q.inletElevation_m !== undefined) q.inletElevation_m += 100
    if (q.outletElevation_m !== undefined) q.outletElevation_m += 100
  }
  d.selection.downcomerBottom_m += 100; d.selection.downcomerTop_m += 100
  d.surge.sourceElevation_m += 100; d.surge.receiverElevation_m += 100; d.surge.volumeMeanElevation_m += 100
  d.hotATee.meanElevation_m += 100
  for (const q of d.guideCohorts.cohorts) { q.bottom_m += 100; q.top_m += 100; q.meanElevation_m += 100 }
  for (const q of d.housings) { q.meanElevation_m += 100; q.openingElevation_m += 100 }
  const shifted = compileCurrentPrimaryGraph(d)
  expect(shifted.totalVolume_m3).toBe(g.totalVolume_m3)
  expect(shifted.carriers).toEqual(g.carriers)
  g.edges.forEach((edge, i) => {
    expect(edge.fromElevation_m).toBe(edge.toElevation_m)
    expect(shifted.edges[i]!.fromElevation_m - edge.fromElevation_m).toBeCloseTo(100, 12)
    // Constant-density gravity is the difference of physical port datums;
    // native graph algebra, not this compiler, projects path/cycle forces.
    expect(shifted.nodes[edge.to]!.meanElevation_m - shifted.nodes[edge.from]!.meanElevation_m)
      .toBeCloseTo(g.nodes[edge.to]!.meanElevation_m - g.nodes[edge.from]!.meanElevation_m, 12)
  })
  const snapshot = { gaugeNode: 0, massRates: g.nodes.map(() => 0), cycleFlows: Array(g.edges.length - g.nodes.length + 1).fill(1),
    edgeMassFlowRates: g.edges.map(() => 0), nodePressure_Pa: g.nodes.map(() => 300000), faceDonorDensity_kg_m3: g.edges.map(() => 997) }
  const stream = serializePrimaryConstraintSnapshot(g, snapshot).trim().split(/\s+/)
  expect(stream.slice(0, 5)).toEqual(['76', '82', String(g.carriers.length), String(g.unassignedMomentumSupports.length), '0'])
  const count = 5 + 2 * g.edges.length + g.carriers.length * (3 + 2 * g.edges.length)
    + 2 * g.nodes.length + 2 * g.edges.length + snapshot.cycleFlows.length
  expect(stream).toHaveLength(count)
  expect(() => serializePrimaryConstraintSnapshot(g, { ...snapshot, cycleFlows: [1] })).toThrow()
  expect(() => serializePrimaryConstraintSnapshot(g, { ...snapshot, gaugeNode: 76 })).toThrow()
  expect(() => serializePrimaryConstraintSnapshot(g, { ...snapshot, faceDonorDensity_kg_m3: g.edges.map(() => 0) })).toThrow()
})

test('current compiler rejects invented/missing inventories and unsupported cohort scope', async () => {
  const { input } = await currentPrimaryGraphFixture()
  for (const change of [
    (d: typeof input) => { d.snapshotIdentity = '' },
    (d: typeof input) => { delete d.masses['GUIDE.EMPTY'] },
    (d: typeof input) => { d.masses.EXTRA = d.masses.DOWNCOMER! },
    (d: typeof input) => { d.masses.DOWNCOMER!.mass_kg *= 2 },
    (d: typeof input) => { d.masses.DOWNCOMER!.massRate_kg_s = NaN },
    (d: typeof input) => { d.guideCohorts.cohorts[0]!.count++ },
    (d: typeof input) => { d.guideCohorts.cohorts[1]!.singleArea_m2 *= 2 },
    (d: typeof input) => { d.guideCohorts.mode = 'heated' as typeof d.guideCohorts.mode },
    (d: typeof input) => { d.housings.pop() },
    (d: typeof input) => { d.hotATee.length_m = 1000 },
    (d: typeof input) => { d.geometry['COLD.A'].volume_m3 = 20 },
  ]) {
    const d = structuredClone(input); change(d)
    expect(() => compileCurrentPrimaryGraph(d)).toThrow()
  }
})

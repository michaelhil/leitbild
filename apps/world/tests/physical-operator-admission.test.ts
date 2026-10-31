import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { resolvePhysicalDesign, pwrManifoldUnitPhysicalDesignRef, pwrManifoldCampusPhysicalDesignRef, pwrOperatorUnitPhysicalDesignRef, pwrOperatorCampusPhysicalDesignRef } from '../src/packs/physical-layout/design.ts'
import { compilePhysicalScene } from '../src/packs/physical-layout/native/drafting/compile-scene.ts'
import { canonicalPhysicalJson } from '../src/packs/physical-layout/model.ts'
import captured from './fixtures/physical-layout/historical-targets-20261029.json'

test('operator-model admission preserves exact architecture, accepted routes, drafting and coherent campus dependencies', async () => {
  const [oldUnit, oldCampus, unit, campus] = await Promise.all([pwrManifoldUnitPhysicalDesignRef, pwrManifoldCampusPhysicalDesignRef, pwrOperatorUnitPhysicalDesignRef, pwrOperatorCampusPhysicalDesignRef].map(resolvePhysicalDesign))
  if (oldUnit!.profile !== 'drafting' || oldCampus!.profile !== 'drafting' || unit!.profile !== 'drafting' || campus!.profile !== 'drafting') throw Error('Expected exact drafting profiles')
  const model = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'admission:test' }))
  const historical = captured.entries.find(entry => entry.selection.model.parameters.loopCount === 4)!.description
  // R7 was admitted for controller authority over the same R6 graph geometry.
  // The RHR extension now has its own current admission; never rewrite R7 to
  // the changed graph or stamp its old digest onto current descriptions.
  expect(unit!.modelRequirement.modelRef).toBe(historical.modelRef)
  expect(unit!.modelRequirement.modelDigest).not.toBe(model.modelDigest)
  expect(unit!.coverageEvidence.dispositions.map(entry => entry.subjectId).sort()).toEqual([
    ...historical.subjects.map(subject => subject.id), ...historical.connections.map(connection => connection.id),
  ].sort())
  expect(unit!.modelRequirement).not.toEqual(oldUnit!.modelRequirement)
  for (const [before, after] of [[oldUnit!, unit!], [oldCampus!, campus!]] as const) {
    expect(after.design).not.toEqual(before.design)
    expect(after.sourceDigest).toBe(before.sourceDigest)
    expect(after.bindingDigest).toBe(before.bindingDigest)
    expect(after.compiler).toEqual(before.compiler)
    expect(after.source).toEqual(before.source)
    expect(after.bindings).toEqual(before.bindings)
    expect(after.physicalApplicability.geometryDigest).toBe(before.physicalApplicability.geometryDigest)
    expect(after.physicalApplicability.sourceDigest).toBe(before.physicalApplicability.sourceDigest)
    expect(after.presentation).toEqual(before.presentation)
    expect(after.coverageEvidence.dispositions).toEqual(before.coverageEvidence.dispositions)
  }
  expect(campus!.requirements.connections).toEqual(oldCampus!.requirements.connections)
  expect(campus!.requirements.relatedMembers).toHaveLength(4)
  for (const member of campus!.requirements.relatedMembers) {
    expect(member.modelDigest).toBe(unit!.modelRequirement.modelDigest)
    expect(member.physicalLayout?.physical).toEqual({ id: unit!.design.id, digest: unit!.physicalApplicability.digest })
  }
  const hash = (value: unknown) => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
  const compile = (data: typeof unit) => compilePhysicalScene('preservation', { ...data!, owner: { objectId: 'plant:same' }, placement: { anchor: [0, 0], bearing: 0 } })
  const before = compile(oldUnit), after = compile(unit)
  expect(hash(after.planDrawing)).toBe(hash(before.planDrawing))
  expect(after.objects.length).toBe(before.objects.length)
  expect(after.objects.map(object => object.id)).toEqual(before.objects.map(object => object.id))
}, 30_000)

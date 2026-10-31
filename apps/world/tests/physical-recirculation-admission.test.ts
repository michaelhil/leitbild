import { expect, test } from 'bun:test'
import retained from './fixtures/physical-layout/recirculation-targets-20261030.json'
import { pwrRhrUnitPhysicalDesignRef, pwrRhrCampusPhysicalDesignRef, pwrRecirculationUnitPhysicalDesignRef, pwrRecirculationCampusPhysicalDesignRef, resolvePhysicalDesign } from '../src/packs/physical-layout/design.ts'
import { physicalCoverageIssues } from '../src/packs/physical-layout/coverage.ts'
import { compilePhysicalScene } from '../src/packs/physical-layout/native/drafting/compile-scene.ts'

const drafting = async (ref: unknown) => { const design = await resolvePhysicalDesign(ref); if (design.profile !== 'drafting') throw Error('Expected exact drafting admission'); return design }

test('immutable recirculation admission covers its captured exact graph and preserves unrelated RHR and campus geometry', async () => {
  const [previous, current, previousCampus, campus] = await Promise.all([drafting(pwrRhrUnitPhysicalDesignRef), drafting(pwrRecirculationUnitPhysicalDesignRef), drafting(pwrRhrCampusPhysicalDesignRef), drafting(pwrRecirculationCampusPhysicalDesignRef)])
  expect(retained.sourceCommit).toBe('1a1dabb69ecab03bd274544d5217279d55a7a9ae')
  expect(current.modelRequirement).toEqual({ modelRef: retained.modelRef, modelDigest: retained.modelDigest })
  expect(current.modelRequirement).not.toEqual(previous.modelRequirement)
  expect(current.compiler).toEqual(previous.compiler)
  const subjects = [...retained.subjects.map(component => component.id), ...retained.connections.map(link => link.id)]
  expect(physicalCoverageIssues({ evidence: current.coverageEvidence, physicalIds: [...current.source.elements.map(element => element.id), ...current.source.routing!.connections.map(route => route.id)], ownerSubjectIds: subjects, bindings: current.bindings })).toEqual([])
  expect(current.coverageEvidence.dispositions.map(row => row.subjectId).sort()).toEqual(subjects.sort())
  expect(current.coverageEvidence.dispositions.some(row => row.disposition === 'unresolved')).toBe(false)
  const retired = new Set(previous.bindings.filter(binding => !subjects.includes(binding.elementId)).map(binding => binding.physicalElementId)), compile = (data: typeof current) => compilePhysicalScene('preservation', { ...data, owner: { objectId: 'plant:unchanged' }, placement: { anchor: [0, 0], bearing: 0 } })
  const before = compile(previous), scene = compile(current), objects = new Map(scene.objects.map(object => [object.id, object]))
  for (const object of before.objects) if (!retired.has(object.id)) expect(objects.get(object.id)).toEqual(object)
  expect(campus.source.elements).toEqual(previousCampus.source.elements); expect(campus.bindings).toEqual(previousCampus.bindings)
  expect(compile(campus).objects).toEqual(compile(previousCampus).objects)
  for (const member of campus.requirements.relatedMembers) {
    expect(member.modelDigest).toBe(retained.modelDigest)
    expect(member.physicalLayout?.physical).toEqual({ id: current.design.id, digest: current.physicalApplicability.digest })
  }
  for (const dependency of campus.source.sourceDependencies!) {
    expect(dependency.physicalSourceDigest).toBe(current.physicalApplicability.sourceDigest)
    expect(dependency.physicalShapeDigest).toBe(current.physicalApplicability.geometryDigest)
  }
}, 30_000)

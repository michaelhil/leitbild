import {test,expect} from 'bun:test'
import {createHash} from 'node:crypto'
import {resolvePhysicalDesign,pwrDraftingUnitPhysicalDesignRef,pwrDraftingCampusPhysicalDesignRef,pwrConnectedUnitPhysicalDesignRef,pwrConnectedCampusPhysicalDesignRef} from '../src/packs/physical-layout/design.ts'
import {createPwrConnectedUnitArtifacts,createPwrConnectedCampusArtifacts,pwrSupersededRoutePreviews} from '../src/packs/physical-layout/authoring/pwr-connected.ts'
import {compilePhysicalScene} from '../src/packs/physical-layout/native/drafting/compile-scene.ts'
import {physicalSourceFacts} from '../src/packs/physical-layout/native/drafting/source.ts'
import {physicalSceneShapeFacts} from '../src/packs/physical-layout/source-validation.ts'
import {physicalSourceDependencyFailure} from '../src/packs/physical-layout/source-dependencies.ts'
import {physicalCoverageIssues} from '../src/packs/physical-layout/coverage.ts'
import {canonicalPhysicalJson} from '../src/packs/physical-layout/model.ts'

const hash=(value:unknown)=>createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const removed=new Set(pwrSupersededRoutePreviews.map(entry=>entry.preview))
const [retained,connected,campus]=await Promise.all([resolvePhysicalDesign(pwrDraftingUnitPhysicalDesignRef),resolvePhysicalDesign(pwrConnectedUnitPhysicalDesignRef),resolvePhysicalDesign(pwrConnectedCampusPhysicalDesignRef)])
if(retained.profile!=='drafting'||connected.profile!=='drafting'||campus.profile!=='drafting')throw Error('Connected revision requires the retained drafting profile')
const compile=(data:typeof connected)=>compilePhysicalScene('comparison',{...data,owner:{objectId:'plant:test'},placement:{anchor:[0,0],bearing:0}})
const oldScene=compile(retained),newScene=compile(connected)

test('an exact new revision retires only explicitly superseded unbound preview paths and leaves old R4 resolvable',async()=>{
  expect(retained.design.revision).toBe('pwr-full-unit-20261027-r4')
  expect(connected.design.revision).toBe('pwr-full-unit-20261027-r5')
  expect(retained.compiler).toEqual(connected.compiler)
  expect(oldScene.objects.length-newScene.objects.length).toBe(removed.size)
  expect(newScene.objects).toEqual(oldScene.objects.filter(object=>!removed.has(object.id)))
  expect(newScene.planDrawing!.views.map(view=>view.primitives)).toEqual(oldScene.planDrawing!.views.map(view=>view.primitives.filter(primitive=>!primitive.occurrenceId||!removed.has(primitive.occurrenceId))))
  for(const id of removed){
    expect(retained.source.elements.find(element=>element.id===id)!.disposition).toBe('installed')
    expect(connected.source.elements.find(element=>element.id===id)!.disposition).toBe('removed')
    expect(connected.bindings.some(binding=>binding.physicalElementId===id)).toBe(false)
    expect(connected.coverageEvidence.contextElements.find(entry=>entry.physicalElementId===id)!.reason).toContain('accepted, exact-port graph connections')
  }
  for(const {routes} of pwrSupersededRoutePreviews)for(const id of routes){
    const route=connected.source.routing!.connections.find(connection=>connection.graphConnectionId===id)!
    expect(newScene.objects.some(object=>object.id===route.id)).toBe(true)
    expect(connected.bindings.some(binding=>binding.physicalElementId===route.id&&binding.elementId===id&&binding.relation==='represents')).toBe(true)
  }
  const previousCampus=await resolvePhysicalDesign(pwrDraftingCampusPhysicalDesignRef)
  expect(previousCampus.design.revision).toBe('pwr-campus-20261027-r4')
})

test('all accepted physical routes, graph correspondences, coverage and authored mechanical geometry remain unchanged',()=>{
  expect(connected.source.routing).toEqual(retained.source.routing)
  expect(connected.bindings).toEqual(retained.bindings)
  expect(connected.coverageEvidence.dispositions).toEqual(retained.coverageEvidence.dispositions)
  expect(physicalCoverageIssues({evidence:connected.coverageEvidence,physicalIds:[...connected.source.elements.map(element=>element.id),...connected.source.routing!.connections.map(connection=>connection.id)],ownerSubjectIds:connected.coverageEvidence.dispositions.map(entry=>entry.subjectId),bindings:connected.bindings})).toEqual([])
  const replacementIds=['main-steam-header-to-turbine-stop-valve','turbine-stop-valve-to-turbine','main-feedwater-pump-a-to-header']
  for(const id of replacementIds){
    const route=connected.source.routing!.connections.find(connection=>connection.graphConnectionId===id)!
    expect(route.solution!.length).toBeGreaterThan(1)
    expect(newScene.objects.some(object=>object.id===route.id)).toBe(true)
    expect(connected.bindings.some(binding=>binding.physicalElementId===route.id&&binding.elementId===id&&binding.relation==='represents')).toBe(true)
  }
})

test('campus geometry is retained but its dependencies require the newly authored unit source and shape',async()=>{
  const oldCampus=await resolvePhysicalDesign(pwrDraftingCampusPhysicalDesignRef)
  if(oldCampus.profile!=='drafting')throw Error('Retained campus needs drafting profile')
  expect(compile(campus).objects).toEqual(compile(oldCampus).objects)
  const actual=campus.source.sourceDependencies!.map(witness=>({role:witness.role,sourceId:connected.source.id,physicalSourceDigest:hash(physicalSourceFacts(connected.source)),physicalShapeDigest:hash(physicalSceneShapeFacts(newScene.objects))}))
  expect(physicalSourceDependencyFailure(campus.source.sourceDependencies!,actual)).toBeNull()
  expect(physicalSourceDependencyFailure(oldCampus.source.sourceDependencies!,actual)).toContain('re-author')
  expect(physicalSourceDependencyFailure(campus.source.sourceDependencies!,actual.map(member=>({...member,physicalShapeDigest:retained.physicalApplicability.geometryDigest})))).toContain('compiled shape')
})

test('connected authoring exactly regenerates its immutable admission facets',()=>{
  const unit=createPwrConnectedUnitArtifacts(),site=createPwrConnectedCampusArtifacts()
  expect(unit.source).toEqual(connected.source)
  expect(unit.bindings).toEqual(connected.bindings)
  expect(unit.coverage).toEqual(connected.coverageEvidence)
  expect(site.source).toEqual(campus.source)
  expect(site.bindings).toEqual(campus.bindings)
  expect(site.coverage).toEqual(campus.coverageEvidence)
})

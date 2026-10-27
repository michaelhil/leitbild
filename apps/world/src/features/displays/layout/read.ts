import { z } from 'zod'
import type { SimulationRunId } from '../../../core/model/index.ts'
import type { PackPhysicalSceneDescriptor } from '../../../core/packs/scene.ts'
import { declarationOf, declaredRefs, valueOf, visibleObject } from '../compose/declared.ts'
import { planLead, readLeads } from '../compose/defaults.ts'
import type { VignetteElement, VignetteSample, VignetteValue } from '../compose/model.ts'
import { sampleVignette, type ViewRun } from '../compose/view.ts'

export const layoutReadInputSchema = z.object({
  layoutObjectId: z.string().min(1).max(200),
  expectedRevision: z.string().min(1).max(200),
}).strict()

export interface LayoutSubjectReading {
  readonly elementId: string
  readonly label: string
  readonly values: ReadonlyArray<VignetteValue>
  readonly word: string | null
  readonly devices: ReadonlyArray<VignetteElement>
}
export interface LayoutReading {
  readonly scope: {
    readonly runId: SimulationRunId
    readonly layoutObjectId: string
    readonly revision: string
    readonly objectId: string
    readonly packId: string
    readonly modelDigest: string
    readonly epoch: string
    readonly sequence: number
  }
  readonly acquiredAt: string
  readonly sample: VignetteSample
  readonly subjects: ReadonlyArray<LayoutSubjectReading>
}

const refuse = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }

/** Resolve the retained layout as the caller; never compile geometry or start a simulator. */
export const layoutDescriptorOf = async (run: ViewRun, input: z.infer<typeof layoutReadInputSchema>): Promise<PackPhysicalSceneDescriptor> => {
  const object = visibleObject(run, input.layoutObjectId)
  if (object === undefined) return refuse('layout_unavailable', 'This layout is not available in the current Run view')
  const pack = run.packs.find(candidate => candidate.descriptor.id === object.packId)
  const descriptor = pack?.physicalScenes?.describe(object, run.objects.filter(candidate => !run.denied.has(candidate.id)))
  if (descriptor === null || descriptor === undefined) return refuse('layout_unavailable', 'This object supplies no physical layout')
  if (descriptor.revision !== input.expectedRevision) return refuse('layout_revision_mismatch', 'The layout read names a different retained revision')
  if (!descriptor.locationValid) return refuse('layout_location_mismatch', descriptor.reason ?? 'The layout no longer agrees with its owner location')
  const owner = visibleObject(run, descriptor.targetObjectId)
  if (owner === undefined) return refuse('layout_owner_unavailable', 'The layout owner is not available in the current Run view')
  const targets = await run.packs.find(candidate => candidate.descriptor.id === owner.packId)?.physicalTargets?.(owner)
  if (targets === undefined || targets.objectId !== owner.id || targets.modelDigest !== descriptor.modelDigest) return refuse('layout_model_mismatch', 'The retained layout does not match the current owner model')
  const related = descriptor.relatedTargets ?? []
  if (related.length > 64 || new Set(related.map(target => target.objectId)).size !== related.length) return refuse('layout_member_mismatch', 'The layout has an invalid related owner set')
  await Promise.all(related.map(async target => {
    const member = visibleObject(run, target.objectId)
    if (member === undefined || member.packId !== target.packId) return refuse('layout_member_unavailable', 'A related layout member is unavailable in the current Run view')
    const description = await run.packs.find(pack => pack.descriptor.id === member.packId)?.physicalTargets?.(member)
    if (description === undefined || description.objectId !== member.id || description.modelDigest !== target.modelDigest) return refuse('layout_member_mismatch', 'A related layout member no longer satisfies the retained model requirement')
  }))
  const requiredConnections = descriptor.requiredConnections ?? []
  if (requiredConnections.length > 64 || requiredConnections.some(required => run.connections.filter(connection => connection.system.objectId === required.system.objectId && connection.system.portId === required.system.portId
    && connection.network.objectId === required.network.objectId && connection.network.portId === required.network.portId).length !== 1)) return refuse('layout_connection_mismatch', 'The retained physical routing does not match this Run\'s canonical connections')
  const ids = new Set([...targets.subjects, ...(targets.connections ?? [])].map(subject => subject.id))
  if (descriptor.subjectIds.some(id => !ids.has(id))) return refuse('layout_subject_mismatch', 'The layout contains unsupported owner subjects')
  return descriptor
}

/** One bounded owner read supplies every subject; alerts use the same annunciation as process displays. */
export const readLayout = async (run: ViewRun, descriptor: PackPhysicalSceneDescriptor): Promise<Pick<LayoutReading, 'sample' | 'subjects'>> => {
  const port = run.port
  run = { ...run, port: { ...port, read: async request => {
    const result = await port.read(request)
    if (result.refused.length > 0) return refuse('layout_observation_refused', result.refused.map(entry => entry.refused.message).join('; '))
    if (result.unknown.length > 0) return refuse('layout_observation_unknown', 'The owner no longer supplies every requested layout reading')
    return result
  } } }
  const owner = visibleObject(run, descriptor.targetObjectId)!
  const declaration = await declarationOf(run, owner.id)
  if (declaration === null) return refuse('layout_not_observed', 'The layout owner supplies no readable observations')
  const elements = descriptor.subjectIds.map(id => declaration.elements.find(element => element.id === id)
    ?? refuse('layout_subject_not_observed', `The owner does not declare layout subject ${id}`))
  const plans = await Promise.all(elements.map(element => planLead(run, { objectId: owner.id, element: element.id }, 8)))
  const reading = await readLeads(run, plans)
  // A lead plan may describe its entire ordered pool, while its acquisition is
  // bounded to the requested eight rows. Do not advertise unacquired values as
  // bad-quality readings, or expand a whole-unit read into every owner signal.
  const selected = reading.led.map(lead => lead.refs.slice(0, 8))
  const declared = await declaredRefs(run, selected.flat())
  const acquired = new Set(reading.observations.map(observation => observation.ref))
  if (selected.flat().some(ref => !declared.has(ref) || !acquired.has(ref))) return refuse('layout_observation_missing', 'The owner did not supply every selected layout reading')
  const sample = await sampleVignette(run, { title: 'Physical layout', at: { at: new Date().toISOString(), clock: 'wall' }, views: [{ kind: 'alerts', objectIds: [owner.id], rows: 1 }] })
  return {
    sample: { ...sample, observations: reading.observations },
    subjects: elements.map((element, index) => ({
      elementId: element.id, label: element.label,
      values: selected[index]!.map(ref => valueOf(declared.get(ref)!)),
      // A layout does not invent a running state for a casing or a group.
      word: null,
      devices: declaration.elements.filter(candidate => candidate.parent === element.id).map(({ lead: _lead, stopped: _stopped, criteria: _criteria, table: _table, ...device }) => device),
    })),
  }
}

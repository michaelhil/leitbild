import { createHash } from 'node:crypto'
import type { OperationalObject } from '../../core/model/index.ts'
import type { PackPhysicalTargetDescription } from '../../core/packs/protocol.ts'
import { electricGridPackDataSchema, electricGridPackId } from './model.ts'

const descriptions = new Map<string, Omit<PackPhysicalTargetDescription, 'objectId'>>()

/** Exact structural graph only; no operating point, runtime, observation or state advancement. */
export const describeElectricGridPhysicalTargets = async (object: OperationalObject): Promise<PackPhysicalTargetDescription> => {
  if (object.packId !== electricGridPackId) throw new Error(`Not an Electric Grid owner: ${object.id}`)
  const { model: selection } = electricGridPackDataSchema.parse(object.packData)
  let description = descriptions.get(selection.ref)
  if (description === undefined) {
    // Keep model files/compiler out of World startup. Description is an explicit,
    // read-only catalog use and is also available while the simulator is closed.
    const { gridModelV2 } = await import('./definitions.ts')
    const model = gridModelV2(selection.ref)
    const subjects = [
      ...model.buses, ...model.branches, ...model.hvdcLinks, ...model.externalSystems,
      ...model.generators, ...model.loads, ...model.shunts, ...model.storage, ...model.connectionPoints,
    ].map(subject => Object.freeze({ id: subject.id, label: 'label' in subject ? subject.label : subject.id,
      ...('location' in subject ? { location: Object.freeze([...subject.location]) as readonly [number, number] } : {}) }))
    if (new Set(subjects.map(subject => subject.id)).size !== subjects.length) throw new Error(`Grid physical targets have duplicate identities: ${selection.ref}`)
    description = Object.freeze({ modelRef: model.id, modelDigest: createHash('sha256').update(JSON.stringify(model)).digest('hex'), subjects: Object.freeze(subjects) })
    descriptions.set(selection.ref, description)
  }
  return { objectId: object.id, ...description }
}

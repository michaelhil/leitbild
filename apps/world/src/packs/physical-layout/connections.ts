import type { ElectricalConnectionDefinition } from '../../core/model/index.ts'
import type { PackPhysicalSceneDescriptor } from '../../core/packs/scene.ts'
import type { RetainedPhysicalLayoutData } from './model.ts'

/** Roles resolve within this admitted layout; physical drawings never infer a bay from a label. */
export const physicalRequiredConnections = (data: RetainedPhysicalLayoutData): NonNullable<PackPhysicalSceneDescriptor['requiredConnections']> => {
  if (!('requirements' in data)) return []
  const members = new Map([[data.requirements.ownerRole, data.owner.objectId], ...data.relatedMembers.map(member => [member.role, member.objectId] as const)])
  const objectFor = (role: string): string => members.get(role) ?? (() => { throw new Error(`Unresolved physical connection role: ${role}`) })()
  return data.requirements.connections.map(connection => ({
    system: { objectId: objectFor(connection.system.role), portId: connection.system.portId },
    network: { objectId: objectFor(connection.network.role), portId: connection.network.portId },
  }))
}

export const validatePhysicalConnections = (data: RetainedPhysicalLayoutData, connections: ReadonlyArray<ElectricalConnectionDefinition> | undefined): void => {
  for (const required of physicalRequiredConnections(data)) {
    const matches = connections?.filter(connection => connection.system.objectId === required.system.objectId && connection.system.portId === required.system.portId
      && connection.network.objectId === required.network.objectId && connection.network.portId === required.network.portId)
    if (matches?.length !== 1) throw new Error(`Physical layout connection mismatch: ${required.system.objectId}:${required.system.portId} → ${required.network.objectId}:${required.network.portId}`)
  }
}

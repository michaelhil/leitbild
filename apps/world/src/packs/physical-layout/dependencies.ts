import type { OperationalObject } from '../../core/model/index.ts'
import { canonicalPhysicalJson, type RetainedPhysicalLayoutData } from './model.ts'
import {physicalSourceDependencyFailure,type PhysicalSourceDependency} from './source-dependencies.ts'

export interface PhysicalLayoutInstance { readonly object: OperationalObject; readonly data: RetainedPhysicalLayoutData }

/** Conservative geometry dependency: no label, first-match, latest revision or inferred orientation. */
export const physicalLayoutDependencyFailure = (data: RetainedPhysicalLayoutData, layouts: ReadonlyArray<PhysicalLayoutInstance>): string | null => {
  if (!('relatedMembers' in data)) return null
  const actual:PhysicalSourceDependency[]=[]
  for (const member of data.relatedMembers) {
    const expected = member.physicalLayout
    if (expected === undefined) continue
    const matches = layouts.filter(layout => layout.object.lifecycle === 'active' && layout.data.owner.objectId === member.objectId && layout.data.owner.packId === member.packId
      && layout.data.owner.modelRef === member.modelRef && layout.data.owner.modelDigest === member.modelDigest
      && ('design' in expected ? canonicalPhysicalJson(layout.data.design) === canonicalPhysicalJson(expected.design)
        : 'physicalApplicability' in layout.data && layout.data.design.id === expected.physical.id && layout.data.physicalApplicability.digest === expected.physical.digest)
      && layout.data.placement.bearing === expected.bearing && canonicalPhysicalJson(layout.data.placement.anchor) === canonicalPhysicalJson(member.anchor))
    if (matches.length !== 1) return `Physical layout dependency mismatch: ${member.role} requires exactly one matching physical configuration, bearing and anchor`
    const target=matches[0]!.data
    if('physicalApplicability'in target)actual.push({role:member.role,sourceId:target.source.id,physicalSourceDigest:target.physicalApplicability.sourceDigest,physicalShapeDigest:target.physicalApplicability.geometryDigest})
  }
  return 'northAxis'in data.source?physicalSourceDependencyFailure(data.source.sourceDependencies??[],actual):null
}

import type { OperationalObject } from '../../core/model/index.ts'
import { canonicalPhysicalJson, type RetainedPhysicalLayoutData } from './model.ts'

export interface PhysicalLayoutInstance { readonly object: OperationalObject; readonly data: RetainedPhysicalLayoutData }

/** Conservative geometry dependency: no label, first-match, latest revision or inferred orientation. */
export const physicalLayoutDependencyFailure = (data: RetainedPhysicalLayoutData, layouts: ReadonlyArray<PhysicalLayoutInstance>): string | null => {
  if (!('relatedMembers' in data)) return null
  for (const member of data.relatedMembers) {
    const expected = member.physicalLayout
    if (expected === undefined) continue
    const matches = layouts.filter(layout => layout.object.lifecycle === 'active' && layout.data.owner.objectId === member.objectId && layout.data.owner.packId === member.packId
      && layout.data.owner.modelRef === member.modelRef && layout.data.owner.modelDigest === member.modelDigest
      && canonicalPhysicalJson(layout.data.design) === canonicalPhysicalJson(expected.design)
      && layout.data.placement.bearing === expected.bearing && canonicalPhysicalJson(layout.data.placement.anchor) === canonicalPhysicalJson(member.anchor))
    if (matches.length !== 1) return `Physical layout dependency mismatch: ${member.role} requires exactly one matching Design, bearing and anchor`
  }
  return null
}

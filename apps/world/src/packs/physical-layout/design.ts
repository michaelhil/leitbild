import { createHash } from 'node:crypto'
import sourceData from './pwr-turbine-island.source.json'
import bindingsData from './pwr-turbine-island.bindings.json'
import { canonicalPhysicalJson, physicalCorrespondenceSchema, physicalDesignRefSchema } from './model.ts'
import { physicalSourceSchema } from './native/source.ts'
import { compilePhysicalObjects, physicalObjectsBounds } from './native/compile-scene.ts'

const hash = (value: unknown): string => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const source = physicalSourceSchema.parse(sourceData)
const bindings = physicalCorrespondenceSchema.array().parse(bindingsData)
const modelRequirement = { modelRef: 'process-plant.pwr.reference', modelDigest: '47b82339adddd913ef20d24294ae9c595b104d1c10148bcfb5943bc30aeaf3ea' }
const sourceDigest = hash(source), bindingDigest = hash(bindings)
export const currentPwrPhysicalDesignRef = Object.freeze({
  id: source.id, revision: 'pwr-turbine-island-20261024',
  digest: hash({ sourceDigest, bindingDigest, modelRequirement, compiler: 'physical-layout-native' }),
})

let bounds: ReturnType<typeof physicalObjectsBounds> | undefined
/** Exact retained catalog entry. There is no `latest` alias or mutable source lookup. */
export const resolvePhysicalDesign = (reference: unknown) => {
  const parsed = physicalDesignRefSchema.parse(reference)
  if (canonicalPhysicalJson(parsed) !== canonicalPhysicalJson(currentPwrPhysicalDesignRef)) throw new Error(`Unsupported or mismatched physical Design Revision: ${parsed.id}/${parsed.revision}`)
  bounds ??= physicalObjectsBounds(compilePhysicalObjects({ source, bindings }))
  return structuredClone({ design: currentPwrPhysicalDesignRef, sourceDigest, bindingDigest, source, bindings, modelRequirement, bounds })
}

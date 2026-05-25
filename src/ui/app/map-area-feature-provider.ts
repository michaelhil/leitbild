import type { ControlInstanceId, GeoJsonPolygon, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import type { LeitbildPack, PackMapAreaFeature } from '../../core/packs/protocol.ts'
import { queryControlInstancePack } from '../control-instance-client.ts'

export interface MapAreaFeatureProviderContext {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
  readonly currentTime?: IsoTimestamp
}

export interface MapAreaFeatureProviderConfig {
  readonly pack: () => LeitbildPack | null
  readonly objects: () => ReadonlyArray<OperationalObject>
  readonly controlInstanceId: () => ControlInstanceId | null
  readonly currentTime: () => IsoTimestamp | undefined
}

const mapFeaturesFromQueryResult = (result: unknown): ReadonlyArray<PackMapAreaFeature> => {
  if (typeof result !== 'object' || result === null || !('features' in result)) {
    throw new Error('pack map feature query returned no features field')
  }
  const features = (result as { readonly features?: unknown }).features
  if (!Array.isArray(features)) throw new Error('pack map feature query features field is not an array')
  return features as ReadonlyArray<PackMapAreaFeature>
}

export const createMapAreaFeatureProvider = (
  config: MapAreaFeatureProviderConfig,
): ((context: MapAreaFeatureProviderContext) => Promise<ReadonlyArray<PackMapAreaFeature>>) =>
  async (context: MapAreaFeatureProviderContext): Promise<ReadonlyArray<PackMapAreaFeature>> => {
    const currentTime = context.currentTime ?? config.currentTime()
    const presentationContext = {
      objects: config.objects(),
      map: { viewport: context.viewport, zoom: context.zoom },
    }
    const presentationContextWithTime = currentTime === undefined
      ? presentationContext
      : { ...presentationContext, currentTime }
    const pack = config.pack()
    if (!pack) return []
    const syncFeatures = pack.mapAreaFeatures?.(presentationContextWithTime) ?? []
    const controlInstanceId = config.controlInstanceId()
    if (!controlInstanceId) return syncFeatures
    const queryFeatures: PackMapAreaFeature[] = []
    for (const request of pack.mapAreaFeatureQueries?.(presentationContextWithTime) ?? []) {
      const body = await queryControlInstancePack(controlInstanceId, request)
      if (!body.response.ok) throw new Error(body.response.reason)
      queryFeatures.push(...mapFeaturesFromQueryResult(body.response.result))
    }
    return [...syncFeatures, ...queryFeatures]
  }

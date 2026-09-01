import type { SimulationRunId, GeoJsonPolygon, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { packMapAreaFeatureSchema, type PackMapAreaFeature, type PackQueryRequest } from '../../core/packs/protocol.ts'
import type { ActivePackViews } from '../../core/packs/active-views.ts'
import { querySimulationRunPack, type SimulationRunRequestOptions } from '../simulation-run-client.ts'
import type { PackQueryApiResponse } from '../types.ts'

export interface MapAreaFeatureLoaderContext {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
  readonly currentTime?: IsoTimestamp
  readonly signal?: AbortSignal
}

export interface MapAreaFeatureRuntimeConfig {
  readonly pack: () => ActivePackViews | null
  readonly objects: () => ReadonlyArray<OperationalObject>
  readonly simulationRunId: () => SimulationRunId | null
  readonly currentTime: () => IsoTimestamp | undefined
  readonly queryTimeoutMs?: number
  readonly queryPack?: (
    simulationRunId: SimulationRunId,
    request: PackQueryRequest,
    options?: SimulationRunRequestOptions,
  ) => Promise<PackQueryApiResponse>
}

const defaultMapAreaFeatureQueryTimeoutMs = 1_500

const mapFeaturesFromQueryResult = (result: unknown): ReadonlyArray<PackMapAreaFeature> => {
  if (typeof result !== 'object' || result === null || !('features' in result)) {
    throw new Error('pack map feature query returned no features field')
  }
  const features = (result as { readonly features?: unknown }).features
  if (!Array.isArray(features)) throw new Error('pack map feature query features field is not an array')
  return features.map((feature, index) => {
    const parsed = packMapAreaFeatureSchema.safeParse(feature)
    if (!parsed.success) throw new Error(`pack map feature query returned invalid feature ${index}: ${parsed.error.message}`)
    return parsed.data as PackMapAreaFeature
  })
}

const createAbortSignalWithTimeout = (
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly dispose: () => void } => {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error(`pack map feature query timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const abortFromParent = (): void => {
    controller.abort(parent?.reason)
  }
  parent?.addEventListener('abort', abortFromParent, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

export const createMapAreaFeatureLoader = (
  config: MapAreaFeatureRuntimeConfig,
): ((context: MapAreaFeatureLoaderContext) => Promise<ReadonlyArray<PackMapAreaFeature>>) =>
  async (context: MapAreaFeatureLoaderContext): Promise<ReadonlyArray<PackMapAreaFeature>> => {
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
    const syncFeatures = pack.presentation.mapAreaFeatures?.(presentationContextWithTime) ?? []
    const simulationRunId = config.simulationRunId()
    if (!simulationRunId) return syncFeatures
    const requests = pack.presentation.mapAreaFeatureQueries?.(presentationContextWithTime) ?? []
    if (requests.length === 0) return syncFeatures
    const query = config.queryPack ?? querySimulationRunPack
    const timeout = createAbortSignalWithTimeout(
      context.signal,
      config.queryTimeoutMs ?? defaultMapAreaFeatureQueryTimeoutMs,
    )
    try {
      const responses = await Promise.all(requests.map(async request => {
        const body = await query(simulationRunId, request, { signal: timeout.signal })
        if (!body.response.ok) throw new Error(body.response.reason)
        return mapFeaturesFromQueryResult(body.response.result)
      }))
      return [...syncFeatures, ...responses.flat()]
    } finally {
      timeout.dispose()
    }
  }

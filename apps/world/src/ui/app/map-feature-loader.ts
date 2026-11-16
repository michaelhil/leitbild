import type { SimulationRunId, GeoJsonPolygon, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { packMapFeatureSchema, type PackMapFeature, type PackMapFeatureQuery, type PackObjectPresentationContext } from '../../core/packs/protocol.ts'
import type { ActivePackViews } from '../../core/packs/active-views.ts'
import { querySimulationRunCapability, type SimulationRunRequestOptions } from '../simulation-run-client.ts'

export interface MapFeatureLoaderContext {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
  readonly currentTime?: IsoTimestamp
  readonly signal?: AbortSignal
}

export interface MapFeatureRuntimeConfig {
  readonly pack: () => ActivePackViews | null
  readonly objects: () => ReadonlyArray<OperationalObject>
  readonly simulationRunId: () => SimulationRunId | null
  readonly currentTime: () => IsoTimestamp | undefined
  /**
   * The roles the screen shows Packs in a role Run (the role dialog's See
   * boxes), or null in open mode. A Pack's map features receive it as its
   * object presentation does, so what a screen does not see stays off the
   * map in every layer a Pack draws.
   */
  readonly seenRoleIds: () => ReadonlyArray<string> | null
  /**
   * The object the map selects, or null. Only the map feature hooks of a
   * Pack that declares `mapFeaturesFollowSelection` receive it.
   */
  readonly selectedObjectId: () => string | null
  /**
   * The revision of the Run data Packs read besides its objects: the World
   * view's per-Pack data revisions in this perspective. A load that changes
   * nothing but the selection keeps the last map-area query results only
   * while it holds.
   */
  readonly dataRevision: () => string
  readonly queryTimeoutMs?: number
  readonly onWarnings?: (messages: ReadonlyArray<string>) => void
  readonly queryCapability?: (
    simulationRunId: SimulationRunId,
    request: PackMapFeatureQuery,
    options?: SimulationRunRequestOptions,
  ) => Promise<unknown>
}

const defaultMapFeatureQueryTimeoutMs = 1_500

const mapFeaturesFromQueryResult = (result: unknown): ReadonlyArray<PackMapFeature> => {
  if (typeof result !== 'object' || result === null || !('features' in result)) {
    throw new Error('pack map feature query returned no features field')
  }
  const features = (result as { readonly features?: unknown }).features
  if (!Array.isArray(features)) throw new Error('pack map feature query features field is not an array')
  return features.map((feature, index) => {
    const parsed = packMapFeatureSchema.safeParse(feature)
    if (!parsed.success) throw new Error(`pack map feature query returned invalid feature ${index}: ${parsed.error.message}`)
    return parsed.data as PackMapFeature
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
  if (parent?.aborted) abortFromParent()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

/**
 * What a load asked the Run for: its map-area requests, over which objects,
 * data revision and selection, and what came back.
 */
interface QueriedLoad {
  readonly key: string
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedObjectId: string | null
  readonly results: ReadonlyMap<string, MapQueryResult>
}

interface MapQueryResult {
  readonly features: ReadonlyArray<PackMapFeature>
  readonly warning?: string
}

/**
 * Loads the active Packs' synchronous features and typed Run queries.
 * A selection change redraws synchronous features and keeps the results of
 * unchanged queries over the same objects, data revision and roles.
 */
export const createMapFeatureLoader = (
  config: MapFeatureRuntimeConfig,
): ((context: MapFeatureLoaderContext) => Promise<ReadonlyArray<PackMapFeature>>) => {
  let lastQueried: QueriedLoad | null = null
  return async (context: MapFeatureLoaderContext): Promise<ReadonlyArray<PackMapFeature>> => {
    const currentTime = context.currentTime ?? config.currentTime()
    const seenRoleIds = config.seenRoleIds()
    const selectedObjectId = config.selectedObjectId()
    const objects = config.objects()
    const presentation: PackObjectPresentationContext = {
      objects,
      map: { viewport: context.viewport, zoom: context.zoom },
      ...(currentTime === undefined ? {} : { currentTime }),
      ...(seenRoleIds === null ? {} : { seenRoleIds }),
      ...(selectedObjectId === null ? {} : { selectedObjectId }),
    }
    const pack = config.pack()
    if (!pack) { lastQueried = null; config.onWarnings?.([]); return [] }
    const syncFeatures = pack.presentation.mapFeatures?.(presentation) ?? []
    const simulationRunId = config.simulationRunId()
    if (!simulationRunId) { lastQueried = null; config.onWarnings?.([]); return syncFeatures }
    const requests = pack.presentation.mapFeatureQueries?.(presentation) ?? []
    if (requests.length === 0) { lastQueried = null; config.onWarnings?.([]); return syncFeatures }
    const key = JSON.stringify([simulationRunId, config.dataRevision(), seenRoleIds])
    const previous = lastQueried
    const reused = previous?.key === key && previous.objects === objects && previous.selectedObjectId !== selectedObjectId ? previous.results : undefined
    const query = config.queryCapability ?? (async (id, request, options) =>
      await querySimulationRunCapability(id, request.capabilityId, request.input, options))
    const timeout = createAbortSignalWithTimeout(
      context.signal,
      config.queryTimeoutMs ?? defaultMapFeatureQueryTimeoutMs,
    )
    try {
      const responses = await Promise.all(requests.map(async (request): Promise<readonly [string, MapQueryResult]> => {
        const requestKey = JSON.stringify(request)
        const known = reused?.get(requestKey)
        if (known !== undefined) return [requestKey, known]
        try {
          const result = await query(simulationRunId, request, { signal: timeout.signal })
          const truncated = typeof result === 'object' && result !== null && 'truncated' in result && result.truncated === true
          return [requestKey, {
            features: mapFeaturesFromQueryResult(result),
            ...(truncated ? { warning: request.capabilityId + ': map coverage limited; zoom in for more detail.' } : {}),
          }]
        } catch (error) {
          if (context.signal?.aborted) throw error
          if (!config.onWarnings) throw error
          return [requestKey, { features: [], warning: request.capabilityId + ': ' + String(error) }]
        }
      }))
      if (context.signal?.aborted) throw context.signal.reason
      lastQueried = { key, objects, selectedObjectId, results: new Map(responses) }
      config.onWarnings?.(responses.flatMap(([, result]) => result.warning === undefined ? [] : [result.warning]))
      return [...syncFeatures, ...responses.flatMap(([, result]) => result.features)]
    } finally {
      timeout.dispose()
    }
  }
}

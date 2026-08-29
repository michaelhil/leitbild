import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon, InteractionHandler, IsoTimestamp, ObjectId, OperationalObject, SurfaceMapLayer } from '../model/index.ts'
import type { RoutingAdapter } from '../../routing/protocol.ts'
import type { DatasetConfig, DatasetId } from '../../reference-data/types.ts'
import { packDescriptorSchema, type PackDescriptor } from '@leitbild/contracts'

/** Builder a pack declares to contribute a reference dataset. The CLI reads `id`
 * for filtering and listing; `build` runs only when the pipeline actually
 * builds the dataset (so env reads happen at the right moment). */
export interface PackReferenceDatasetBuilder {
  readonly id: DatasetId
  readonly build: (env: Record<string, string | undefined>) => DatasetConfig
}

/** Rail-side layer-group toggle contributed by a pack (ADR 0023). */
export interface PackMapLayerGroup {
  /** Stable id used in storage keys and command payloads. */
  readonly id: string
  /** Operator-facing label rendered in the rail. */
  readonly label: string
  /** Initial visibility. The rail and persistent storage may override. */
  readonly defaultVisible: boolean
  /** MapLibre layer-id glob. `*` matches one ':'-separated segment. */
  readonly layerIdPattern: string
}

export interface PackObjectCategory {
  readonly id: string
  readonly label: string
  readonly emptyLabel: string
  readonly matches: (object: OperationalObject) => boolean
}

export interface PackObjectPresentation {
  readonly categoryId: string
  readonly icon: string
  readonly color: string
  readonly summary: string
  readonly fields: ReadonlyArray<PackObjectField>
  readonly status?: PackObjectStatusPresentation
  readonly muted?: boolean
  readonly mapIconVisible?: boolean
  readonly mapIconSizePx?: number
  readonly noteworthyUpdates?: boolean
}

export interface PackObjectField {
  readonly key: string
  readonly label: string
  readonly value: string
}

export type PackObjectStatusTone = 'ready' | 'working' | 'error' | 'idle'

export interface PackObjectStatusIndicator {
  readonly shape: 'dot' | 'arrow'
  readonly direction?: 'left' | 'right' | 'up' | 'down'
  readonly pulse?: boolean
  readonly innerTone?: PackObjectStatusTone
}

export interface PackObjectStatusPresentation {
  readonly tone: PackObjectStatusTone
  readonly label: string
  readonly indicator: PackObjectStatusIndicator
}

export interface PackCreateObjectType {
  readonly id: string
  readonly label: string
  readonly categoryId: string
  readonly icon: string
  readonly color: string
  readonly placementKind?: 'point' | 'route' | 'polygon'
  readonly parameters?: ReadonlyArray<PackCreateObjectParameter>
}

export type PackCreateObjectParameter =
  | {
      readonly key: string
      readonly label: string
      readonly kind: 'text'
      readonly defaultValue: string
    }
  | {
      readonly key: string
      readonly label: string
      readonly kind: 'number'
      readonly defaultValue: number
      readonly min?: number
      readonly max?: number
      readonly step?: number
    }
  | {
      readonly key: string
      readonly label: string
      readonly kind: 'select'
      readonly defaultValue: string
      readonly options: ReadonlyArray<{
        readonly value: string
        readonly label: string
      }>
    }

export interface PackCommandRequest {
  readonly kind: string
  readonly targetObjectIds: ReadonlyArray<ObjectId>
  readonly payload: unknown
}

export type PackCreationGeometry =
  | {
      readonly kind: 'point'
      readonly point: GeoJsonPoint
    }
  | {
      readonly kind: 'route'
      readonly from: GeoJsonPoint
      readonly to: GeoJsonPoint
    }
  | {
      readonly kind: 'polygon'
      readonly polygon: GeoJsonPolygon
    }

export type PackObjectPresentationTier = 'summary' | 'map' | 'detail'

export interface PackObjectPresentationContext {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly objectsForPack?: (packId: string) => ReadonlyArray<OperationalObject>
  readonly currentTime?: IsoTimestamp
  readonly map?: PackMapRenderContext
  readonly tier?: PackObjectPresentationTier
}

export interface PackMapRenderContext {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
}

export interface PackMapAreaFeature {
  readonly id: string
  readonly categoryId: string
  readonly geometry: GeoJsonPolygon
  readonly anchorPoint?: GeoJsonPoint
  readonly animation?: PackMapAreaFeatureAnimation
  readonly symbol?: PackMapAreaFeatureSymbol
  readonly color: string
  readonly summary: string
  readonly opacity?: number
  readonly lineColor?: string
  readonly lineOpacity?: number
  readonly lineWidth?: number
  readonly sortKey?: number
}

export interface PackMapAreaFeatureAnimation {
  readonly fromGeometry: GeoJsonPolygon
  readonly toGeometry: GeoJsonPolygon
  readonly fromAnchorPoint?: GeoJsonPoint
  readonly toAnchorPoint?: GeoJsonPoint
  readonly fromTime: IsoTimestamp
  readonly toTime: IsoTimestamp
}

export interface PackMapAreaFeatureSymbol {
  readonly icon: string
  readonly tone?: PackObjectStatusTone
  readonly opacity?: number
  readonly size?: number
}

export interface PackQueryRequest {
  readonly packId: string
  readonly kind: string
  readonly payload: unknown
}

export type PackQueryResponse =
  | {
      readonly ok: true
      readonly packId: string
      readonly kind: string
      readonly result: unknown
      readonly generatedAt: IsoTimestamp
    }
  | {
      readonly ok: false
      readonly packId: string
      readonly kind: string
      readonly reason: string
      readonly generatedAt: IsoTimestamp
    }

export interface PackObjectCreationContext {
  readonly objects: ReadonlyArray<OperationalObject>
}

export interface PackTargetContext {
  readonly objects: ReadonlyArray<OperationalObject>
}

export interface PackRuntime {
  readonly id: string
  readonly version: string
  readonly label: string
  readonly kind: 'local' | 'remote' | 'replay'
}

export interface PackWikiRef {
  readonly name: string
  readonly url: string
}

export interface PackScenarioObjectSpec {
  readonly pack: string
  readonly type: string
  readonly id: string
  readonly label: string
  readonly [key: string]: unknown
}

export interface PackScenarioOperationSpec {
  readonly pack: string
  readonly type: string
  readonly [key: string]: unknown
}

export interface PackScenarioExpansionContext {
  readonly at: IsoTimestamp
  readonly objects: ReadonlyArray<OperationalObject>
  readonly objectById: (id: ObjectId) => OperationalObject | undefined
  readonly routing: RoutingAdapter
  readonly runtimeConfigs: Record<string, unknown>
}

export interface PackScenarioOperationContext extends PackScenarioExpansionContext {
  readonly object: OperationalObject
}

export interface PackScenarioSupport {
  readonly expandObject: (
    spec: PackScenarioObjectSpec,
    context: PackScenarioExpansionContext,
  ) => OperationalObject | Promise<OperationalObject>
  readonly expandObjects?: (
    spec: PackScenarioObjectSpec,
    context: PackScenarioExpansionContext,
  ) => ReadonlyArray<OperationalObject> | Promise<ReadonlyArray<OperationalObject>>
  readonly applyOperation: (
    operation: PackScenarioOperationSpec,
    context: PackScenarioOperationContext,
  ) => OperationalObject | Promise<OperationalObject>
}

export interface PackRuntimeContribution {
  readonly runtimes: ReadonlyArray<PackRuntime>
  readonly defaultRuntimeId: string
}

export interface PackKnowledgeContribution {
  readonly wikiRefs: ReadonlyArray<PackWikiRef>
}

export interface PackReferenceDataContribution {
  readonly builders: ReadonlyArray<PackReferenceDatasetBuilder>
  readonly datasetIds: ReadonlyArray<DatasetId>
}

export interface PackPresentationContribution {
  readonly categories: ReadonlyArray<PackObjectCategory>
  readonly presentObject: (
    object: OperationalObject,
    context: PackObjectPresentationContext,
  ) => PackObjectPresentation
  readonly contextualFields?: (
    object: OperationalObject,
    context: PackObjectPresentationContext,
  ) => ReadonlyArray<PackObjectField>
  readonly mapAreaFeatures?: (
    context: PackObjectPresentationContext,
  ) => ReadonlyArray<PackMapAreaFeature>
  readonly mapAreaFeatureLayers?: ReadonlyArray<SurfaceMapLayer>
  /**
   * Object pack ids whose object revisions can invalidate map-area features.
   * Defaults to the contributing pack id when omitted. Use ['*'] only for
   * genuinely cross-pack area features that depend on every object revision.
   */
  readonly mapAreaFeatureSourcePackIds?: ReadonlyArray<string>
  readonly mapAreaFeatureQueries?: (
    context: PackObjectPresentationContext,
  ) => ReadonlyArray<PackQueryRequest>
  readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
}

export interface PackCommandContribution {
  readonly createObjectTypes: ReadonlyArray<PackCreateObjectType>
  readonly defaultObjectLabel: (
    typeId: string,
    context: PackObjectCreationContext,
  ) => string
  readonly buildCreateObjectCommand: (
    typeId: string,
    label: string,
    geometry: PackCreationGeometry,
    parameters?: unknown,
  ) => PackCommandRequest
  readonly isController: (object: OperationalObject) => boolean
  readonly isTarget: (
    controller: OperationalObject,
    candidate: OperationalObject,
    context: PackTargetContext,
  ) => boolean
  readonly buildSetTargetCommand: (
    controller: OperationalObject,
    target: OperationalObject,
    context: PackTargetContext,
  ) => PackCommandRequest
  readonly buildCancelTargetCommand: (
    controller: OperationalObject,
    context: PackTargetContext,
  ) => PackCommandRequest
}

export interface PackInteractionContribution {
  readonly handlers: ReadonlyArray<InteractionHandler>
}

export interface WorldPack {
  readonly descriptor: PackDescriptor
  readonly runtime?: PackRuntimeContribution
  readonly knowledge?: PackKnowledgeContribution
  readonly referenceData?: PackReferenceDataContribution
  readonly scenario?: PackScenarioSupport
  readonly presentation: PackPresentationContribution
  readonly commands: PackCommandContribution
  readonly interactions?: PackInteractionContribution
}

export const createWorldPackDescriptor = (config: {
  readonly id: string
  readonly version: string
  readonly name: string
  readonly description?: string
  readonly contributions: ReadonlyArray<string>
}): PackDescriptor => packDescriptorSchema.parse({
  schemaVersion: '1.0.0',
  id: config.id,
  moduleId: 'world',
  version: config.version,
  name: config.name,
  ...(config.description === undefined ? {} : { description: config.description }),
  platformVersionRange: '^1.0.0',
  dependencies: [],
  contributions: config.contributions.map(kind => ({ kind })),
})

import { packDescriptorSchema,type PackDescriptor } from '@leitbild/contracts'
import type { Component } from 'svelte'
import { z } from 'zod'
import type { DatasetConfig,DatasetId } from '../../reference-data/types.ts'
import type { RoutingAdapter } from '../../routing/protocol.ts'
import type { GeoJsonPoint,GeoJsonPolygon,InteractionHandler,IsoTimestamp,MapLayerId,ObjectId,OperationalObject,RecordingProfileDescriptor } from '../model/index.ts'
import { geoJsonPointSchema,geoJsonPolygonSchema,isoTimestampSchema } from '../model/index.ts'

export type WorldPackDescriptor = PackDescriptor & { readonly description: string }

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
  readonly mapLineVisible?: boolean
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
  readonly layerId?: string
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

export const packMapAreaFeatureSchema = z
  .object({
    layerId: z.string().min(1).optional(),
    id: z.string().min(1),
    categoryId: z.string().min(1),
    geometry: geoJsonPolygonSchema,
    anchorPoint: geoJsonPointSchema.optional(),
    animation: z.object({
    fromGeometry: geoJsonPolygonSchema,
    toGeometry: geoJsonPolygonSchema,
    fromAnchorPoint: geoJsonPointSchema.optional(),
    toAnchorPoint: geoJsonPointSchema.optional(),
    fromTime: isoTimestampSchema,
    toTime: isoTimestampSchema,
  }).strict().optional(),
    symbol: z.object({
    icon: z.string().min(1),
    tone: z.enum(['ready', 'working', 'error', 'idle']).optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    size: z.number().finite().positive().optional(),
  }).strict().optional(),
    color: z.string().min(1),
    summary: z.string(),
    opacity: z.number().finite().min(0).max(1).optional(),
    lineColor: z.string().min(1).optional(),
    lineOpacity: z.number().finite().min(0).max(1).optional(),
    lineWidth: z.number().finite().nonnegative().optional(),
    sortKey: z.number().finite().optional(),
  })
  .strict()

export interface PackMapAreaFeatureQuery {
  readonly capabilityId: string
  readonly input: unknown
}

export interface PackObjectCreationContext {
  readonly objects: ReadonlyArray<OperationalObject>
}

export interface PackTargetContext {
  readonly objects: ReadonlyArray<OperationalObject>
}

export type PackRuntimeClock = 'simulation' | 'live' | 'none'

export interface PackRuntime {
  readonly id: string
  readonly version: string
  readonly label: string
  readonly kind: 'local' | 'remote' | 'replay'
  readonly clock: PackRuntimeClock
}

export interface PackWikiRef {
  readonly name: string
  readonly url: string
}

export interface PackScenarioItemSpec {
  readonly pack: string
  readonly type: string
  readonly id: string
  readonly label: string
  readonly [key: string]: unknown
}

export interface PackScenarioItemContribution {
  readonly objects: ReadonlyArray<OperationalObject>
}

export type PackScenarioAuthoringControl =
  | { readonly kind: 'text' }
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly step?: number }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'select'; readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly compatibleWith?: { readonly path: ReadonlyArray<string | number>; readonly values: ReadonlyArray<string> } }>; readonly extendFromConfig?: { readonly path: ReadonlyArray<string | number>; readonly valueKey: string; readonly labelKey: string } }
  | { readonly kind: 'reference'; readonly itemTypes: ReadonlyArray<string> }
  | { readonly kind: 'string-list' }

export interface PackScenarioAuthoringField {
  readonly path: ReadonlyArray<string | number>
  readonly label: string
  readonly control: PackScenarioAuthoringControl
}

/** One-level repeated records, not a recursive form language. */
export interface PackScenarioAuthoringCollection {
  readonly path: ReadonlyArray<string | number>
  readonly label: string
  readonly defaultItem: Readonly<Record<string, unknown>>
  readonly fields: ReadonlyArray<PackScenarioAuthoringField>
  readonly maxItems: number
  /** Sparse, ordered keyframes inherit missing values from preceding records. */
  readonly keyframes?: { readonly timePath: ReadonlyArray<string | number>; readonly increment: number }
}
export interface PackScenarioAuthoringItemType {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly idPrefix: string
  readonly defaultItem: Readonly<Record<string, unknown>>
  readonly placement?: {
    readonly kind: 'point'
    readonly path: ReadonlyArray<string | number>
    readonly orReference?: ReadonlyArray<string | number>
  }
  readonly fields: ReadonlyArray<PackScenarioAuthoringField>
  readonly collections?: ReadonlyArray<PackScenarioAuthoringCollection>
}

export interface PackScenarioAuthoringContribution {
  readonly configFields?: ReadonlyArray<PackScenarioAuthoringField>
  readonly itemTypes: ReadonlyArray<PackScenarioAuthoringItemType>
}


export interface PackScenarioExpansionContext {
  readonly at: IsoTimestamp
  readonly objects: ReadonlyArray<OperationalObject>
  readonly objectById: (id: ObjectId) => OperationalObject | undefined
  readonly routing: RoutingAdapter
  readonly packConfigs: Record<string, unknown>
}


export interface PackScenarioSupport {
  /** Startup dependencies on other authored objects, independent of item order. */
  readonly referencedObjects?: (spec: PackScenarioItemSpec) => ReadonlyArray<string>
  /** Static authored footprint. No runtime connection or physical advancement. */
  readonly previewGeometry?: (object: OperationalObject) => import('../model/geo.ts').GeoJsonGeometry | undefined
  readonly validateInitialObjects?: (
    objects: ReadonlyArray<OperationalObject>,
    config: unknown,
    at: IsoTimestamp,
  ) => void
  readonly itemSchemas: Readonly<Record<string, z.ZodType>>
  readonly expandItem: (
    spec: PackScenarioItemSpec,
    context: PackScenarioExpansionContext,
  ) => PackScenarioItemContribution | Promise<PackScenarioItemContribution>
}

export interface PackRuntimeContribution {
  readonly runtimes: ReadonlyArray<PackRuntime>
  readonly defaultRuntimeId: string
}

export interface PackRecordingContribution {
  readonly profiles: ReadonlyArray<RecordingProfileDescriptor>
  /** Initial series only; dynamic assets/optional observations may change this count. */
  readonly estimateSeries?: (objects: ReadonlyArray<OperationalObject>, profileId: string) => number
}

export interface PackKnowledgeContribution {
  readonly wikiRefs: ReadonlyArray<PackWikiRef>
}

export interface PackReferenceDataContribution {
  readonly builders: ReadonlyArray<PackReferenceDatasetBuilder>
  readonly datasetIds: ReadonlyArray<DatasetId>
}

export interface PackContextualFieldQuery extends PackMapAreaFeatureQuery {
  readonly toFields: (result: unknown) => ReadonlyArray<PackObjectField>
}
export interface PackPresentationContribution {
  readonly contextualFieldQueries?: (object: OperationalObject) => ReadonlyArray<PackContextualFieldQuery>
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
  readonly mapAreaFeatureLayers?: ReadonlyArray<MapLayerId>
  /**
   * Object pack ids whose object revisions can invalidate map-area features.
   * Defaults to the contributing pack id when omitted. Use ['*'] only for
   * genuinely cross-pack area features that depend on every object revision.
   */
  readonly mapAreaFeatureSourcePackIds?: ReadonlyArray<string>
  readonly mapAreaFeatureQueries?: (
    context: PackObjectPresentationContext,
  ) => ReadonlyArray<PackMapAreaFeatureQuery>
  readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
}

export interface PackCreationContribution {
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
}

export interface PackTargetingContribution {
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

/** Browser-only panel contributed by a Pack. The host owns placement and lifecycle;
 * the Pack owns the lazily loaded panel implementation. */
export interface PackSurfacePanelContribution {
  readonly id: string
  readonly label: string
  readonly defaultOpen: boolean
  readonly load: () => Promise<{ readonly default: Component }>
}

export interface PackUiContribution {
  readonly surfacePanels: ReadonlyArray<PackSurfacePanelContribution>
}

/** The browser-safe projection of a World Pack. It contains only contributions
 * used by the generic World UI and may be loaded without runtime, compilation,
 * persistence, or build-time dependencies. */
export interface WorldPackView {
  readonly descriptor: WorldPackDescriptor
  readonly runtime?: PackRuntimeContribution
  readonly referenceData?: Pick<PackReferenceDataContribution, 'datasetIds'>
  readonly presentation: PackPresentationContribution
  readonly creation?: PackCreationContribution
  readonly targeting?: PackTargetingContribution
  readonly ui?: PackUiContribution
}

/** Complete server-side Pack definition. World Pack views are projections of
 * this contract, never partial World Packs with fabricated schemas. */
export interface WorldPack extends WorldPackView {
  readonly scenarioConfigSchema: z.ZodType
  readonly authoring?: PackScenarioAuthoringContribution
  readonly recording?: PackRecordingContribution
  readonly knowledge?: PackKnowledgeContribution
  readonly referenceData?: PackReferenceDataContribution
  readonly scenario?: PackScenarioSupport
  readonly interactions?: PackInteractionContribution
}

export const emptyPackScenarioConfigSchema = z.object({}).strict()

export const createWorldPackDescriptor = (config: {
  readonly id: string
  readonly version: string
  readonly name: string
  readonly description: string
  readonly contributions: ReadonlyArray<string>
}): WorldPackDescriptor => packDescriptorSchema.parse({
  schemaVersion: '1.0.0',
  id: config.id,
  moduleId: 'world',
  version: config.version,
  name: config.name,
  description: config.description,
  platformVersionRange: '^1.0.0',
  dependencies: [],
  contributions: config.contributions.map(kind => ({ kind })),
}) as WorldPackDescriptor

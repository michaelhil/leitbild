import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon, InteractionHandler, IsoTimestamp, ObjectId, OperationalObject } from '../model/index.ts'
import type { RoutingAdapter } from '../../routing/protocol.ts'

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

export interface PackObjectPresentationContext {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly currentTime?: IsoTimestamp
  readonly map?: PackMapRenderContext
}

export interface PackMapRenderContext {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
}

export interface PackMapAreaFeature {
  readonly id: string
  readonly categoryId: string
  readonly geometry: GeoJsonPolygon
  readonly animation?: PackMapAreaFeatureAnimation
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
  readonly fromTime: IsoTimestamp
  readonly toTime: IsoTimestamp
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

export interface PackSimulationProvider {
  readonly id: string
  readonly label: string
  readonly kind: 'local' | 'remote' | 'replay'
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
  readonly providerConfigs: Record<string, unknown>
}

export interface PackScenarioOperationContext extends PackScenarioExpansionContext {
  readonly object: OperationalObject
}

export interface PackScenarioSupport {
  readonly expandObject: (
    spec: PackScenarioObjectSpec,
    context: PackScenarioExpansionContext,
  ) => OperationalObject | Promise<OperationalObject>
  readonly applyOperation: (
    operation: PackScenarioOperationSpec,
    context: PackScenarioOperationContext,
  ) => OperationalObject | Promise<OperationalObject>
}

export interface LeitbildPack {
  readonly id: string
  readonly name: string
  readonly domain: string
  readonly simulationProviders?: ReadonlyArray<PackSimulationProvider>
  readonly defaultSimulationProviderId?: string
  readonly scenario?: PackScenarioSupport
  readonly categories: ReadonlyArray<PackObjectCategory>
  readonly createObjectTypes: ReadonlyArray<PackCreateObjectType>
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
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
  readonly mapAreaFeatureQueries?: (
    context: PackObjectPresentationContext,
  ) => ReadonlyArray<PackQueryRequest>
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

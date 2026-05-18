import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon, InteractionHandler, IsoTimestamp, ObjectId, OperationalObject } from '../model/index.ts'

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
}

export interface PackScenarioOperationContext extends PackScenarioExpansionContext {
  readonly object: OperationalObject
}

export interface PackScenarioSupport {
  readonly expandObject: (
    spec: PackScenarioObjectSpec,
    context: PackScenarioExpansionContext,
  ) => OperationalObject
  readonly applyOperation: (
    operation: PackScenarioOperationSpec,
    context: PackScenarioOperationContext,
  ) => OperationalObject
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

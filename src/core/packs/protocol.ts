import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon, InteractionHandler, ObjectId, OperationalObject } from '../model/index.ts'

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
  readonly detailLines: ReadonlyArray<string>
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

export interface LeitbildPack {
  readonly id: string
  readonly name: string
  readonly domain: string
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

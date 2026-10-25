import type { GeoJsonPoint, GeoJsonPolygon } from '../core/model/index.ts'
import type { PackCreateObjectType, PackCreationGeometry } from '../core/packs/protocol.ts'
import { isIconName } from './icons.ts'
import type { CreateDraft, CreateParameterValue } from './types.ts'
import { placementInstruction } from './placement-instruction.ts'

export interface PlacementState {
  readonly mode: PackCreateObjectType | null
  readonly draft: CreateDraft | null
  readonly points: ReadonlyArray<GeoJsonPoint>
  readonly begin: (type: PackCreateObjectType) => void
  readonly placePoint: (point: GeoJsonPoint) => void
  readonly finishPolygon: () => void
  readonly cancel: () => void
  readonly clearDraft: () => void
  readonly placementText: () => string
}

export const createPlacementState = (config: {
  readonly packId: string
  readonly defaultName: (type: PackCreateObjectType) => string
}): PlacementState => {
  let mode = $state<PackCreateObjectType | null>(null)
  let draft = $state<CreateDraft | null>(null)
  let points = $state<GeoJsonPoint[]>([])

  const defaultParameterValues = (type: PackCreateObjectType): Record<string, CreateParameterValue> =>
    Object.fromEntries((type.parameters ?? []).map(parameter => [parameter.key, parameter.defaultValue]))

  const closePolygon = (polygonPoints: ReadonlyArray<GeoJsonPoint>): GeoJsonPolygon => {
    if (polygonPoints.length < 3) throw new Error('polygon placement requires at least three points')
    const coordinates = polygonPoints.map(point => point.coordinates)
    const first = coordinates[0]
    if (!first) throw new Error('polygon placement requires at least one point')
    const last = coordinates[coordinates.length - 1]
    const closed = last && last[0] === first[0] && last[1] === first[1]
      ? coordinates
      : [...coordinates, first]
    return { type: 'Polygon', coordinates: [closed] }
  }

  const createDraftFor = (type: PackCreateObjectType, geometry: PackCreationGeometry): void => {
    draft = {
      objectType: type,
      geometry,
      label: config.defaultName(type),
      parameters: defaultParameterValues(type),
    }
    mode = null
    points = []
  }

  const begin = (type: PackCreateObjectType): void => {
    if (!isIconName(type.icon)) throw new Error(`pack ${config.packId} requested unknown create cursor icon: ${type.icon}`)
    mode = type
    draft = null
    points = []
  }

  const placePoint = (point: GeoJsonPoint): void => {
    if (!mode) return
    const placementKind = mode.placementKind ?? 'point'
    if (placementKind === 'point') {
      createDraftFor(mode, { kind: 'point', point })
      return
    }
    if (placementKind === 'route') {
      const nextPoints = [...points, point]
      points = nextPoints
      if (nextPoints.length < 2) {
        return
      }
      const from = nextPoints[0]
      const to = nextPoints[1]
      if (!from || !to) throw new Error('route placement requires start and end points')
      createDraftFor(mode, { kind: 'route', from, to })
      return
    }
    points = [...points, point]
  }

  const finishPolygon = (): void => {
    if (!mode || (mode.placementKind ?? 'point') !== 'polygon') return
    if (points.length < 3) {
      return
    }
    createDraftFor(mode, { kind: 'polygon', polygon: closePolygon(points) })
  }

  const cancel = (): void => {
    mode = null
    draft = null
    points = []
  }

  const placementText = (): string => {
    return placementInstruction(mode, points.length)
  }

  return {
    get mode() {
      return mode
    },
    get draft() {
      return draft
    },
    get points() {
      return points
    },
    begin,
    placePoint,
    finishPolygon,
    cancel,
    clearDraft: () => {
      draft = null
    },
    placementText,
  }
}

import type { GeoJsonPoint, GeoJsonPolygon } from '../core/model/index.ts'
import type { PackCreateObjectType, PackCreationGeometry } from '../core/packs/protocol.ts'
import type { TrafficSeverity } from '../packs/traffic/model.ts'
import { isIconName } from './icons.ts'
import type { CreateDraft } from './types.ts'

export interface PlacementState {
  readonly mode: PackCreateObjectType | null
  readonly draft: CreateDraft | null
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
  readonly setCommandStatus: (status: string) => void
}): PlacementState => {
  let mode = $state<PackCreateObjectType | null>(null)
  let draft = $state<CreateDraft | null>(null)
  let points = $state<GeoJsonPoint[]>([])

  const defaultTrafficSeverity = (): TrafficSeverity => 'high'

  const defaultTrafficDraftFields = (
    type: PackCreateObjectType,
  ): Pick<CreateDraft, 'trafficSeverity' | 'trafficSpeedFactor' | 'trafficReason'> =>
    type.id === 'traffic_road_segment' || type.id === 'traffic_area'
      ? {
          trafficSeverity: defaultTrafficSeverity(),
          trafficSpeedFactor: 0.55,
          trafficReason: 'Operator-created traffic condition',
        }
      : {}

  const closePolygon = (polygonPoints: ReadonlyArray<GeoJsonPoint>): GeoJsonPolygon => {
    if (polygonPoints.length < 3) throw new Error('traffic area requires at least three points')
    const coordinates = polygonPoints.map(point => point.coordinates)
    const first = coordinates[0]
    if (!first) throw new Error('traffic area requires at least one point')
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
      ...defaultTrafficDraftFields(type),
    }
    mode = null
    points = []
  }

  const begin = (type: PackCreateObjectType): void => {
    if (!isIconName(type.icon)) throw new Error(`pack ${config.packId} requested unknown create cursor icon: ${type.icon}`)
    mode = type
    draft = null
    points = []
    const placementKind = type.placementKind ?? 'point'
    config.setCommandStatus(placementKind === 'route'
      ? `Click start point for new ${type.label.toLowerCase()}`
      : placementKind === 'polygon'
        ? `Click polygon vertices for new ${type.label.toLowerCase()}; press Enter to finish`
        : `Click map to place new ${type.label.toLowerCase()}`)
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
        config.setCommandStatus(`Click end point for new ${mode.label.toLowerCase()}`)
        return
      }
      const from = nextPoints[0]
      const to = nextPoints[1]
      if (!from || !to) throw new Error('route traffic requires start and end points')
      createDraftFor(mode, { kind: 'route', from, to })
      return
    }
    points = [...points, point]
    config.setCommandStatus(points.length < 3
      ? `Click ${3 - points.length} more point${3 - points.length === 1 ? '' : 's'} for new ${mode.label.toLowerCase()}`
      : `Press Enter to finish ${mode.label.toLowerCase()} polygon`)
  }

  const finishPolygon = (): void => {
    if (!mode || (mode.placementKind ?? 'point') !== 'polygon') return
    if (points.length < 3) {
      config.setCommandStatus(`Traffic area needs ${3 - points.length} more point${3 - points.length === 2 ? 's' : ''}`)
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
    if (!mode) return ''
    const placementKind = mode.placementKind ?? 'point'
    if (placementKind === 'route') return `Click start and end points for new ${mode.label.toLowerCase()}`
    if (placementKind === 'polygon') return 'Click area vertices; press Enter to finish'
    return `Click map to place new ${mode.label.toLowerCase()}`
  }

  return {
    get mode() {
      return mode
    },
    get draft() {
      return draft
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

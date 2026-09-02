import type { Layer, PickingInfo } from '@deck.gl/core'
import { IconLayer, PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import { darkStroke, rgba, white } from './colors.ts'
import {
  leitbildSymbolAtlasUrl,
  leitbildSymbolIconMapping,
} from './symbol-kit.ts'
import type {
  ColorRgba,
  OperationalAreaFeature,
  OperationalPathFeature,
  OperationalPointFeature,
  OperationalRenderSnapshot,
  OperationalSymbolFeature,
  Position3,
} from './types.ts'

export interface OperationalDeckLayerConfig {
  readonly snapshot: OperationalRenderSnapshot
  readonly visibleFamilies: ReadonlySet<string>
  readonly onObjectSelected: (object: OperationalPointFeature) => void
  readonly onObjectSeen: (object: OperationalPointFeature) => void
  readonly onObjectHover: (object: OperationalPointFeature | null) => void
  readonly layerData?: OperationalDeckLayerData
}

export interface OperationalDeckLayerData {
  readonly visiblePaths: ReadonlyArray<OperationalPathFeature>
  readonly visibleAreas: ReadonlyArray<OperationalAreaFeature>
  readonly newInfoPoints: ReadonlyArray<OperationalPointFeature>
  readonly placementPoints: ReadonlyArray<{ readonly id: string; readonly position: Position3 }>
}

export interface OperationalDeckLayerDataCache {
  readonly dataFor: (
    snapshot: OperationalRenderSnapshot,
    visibleFamilies: ReadonlySet<string>,
  ) => OperationalDeckLayerData
  readonly reset: () => void
}

export interface OperationalDeckLayerFactory {
  readonly createLayers: (config: OperationalDeckLayerConfig) => ReadonlyArray<Layer>
  readonly reset: () => void
}

const atlasUrl = leitbildSymbolAtlasUrl()
const iconMapping = leitbildSymbolIconMapping()

const visible = (
  visibleFamilies: ReadonlySet<string>,
  family: string,
): boolean =>
  visibleFamilies.has(family)

export const visibleFamiliesKey = (
  visibleFamilies: ReadonlySet<string>,
): string =>
  [...visibleFamilies].sort().join('|')

const pointFill = (point: OperationalPointFeature): ColorRgba => {
  if (point.muted) return [point.color[0], point.color[1], point.color[2], 132]
  return point.color
}

const haloFill = (point: OperationalPointFeature): ColorRgba => {
  if (point.selected) return rgba(29, 102, 210, 62)
  if (point.highlighted) return rgba(193, 122, 19, 58)
  if (point.statusTone === 'error') return rgba(199, 53, 43, 52)
  return rgba(255, 255, 255, 0)
}

const haloStroke = (point: OperationalPointFeature): ColorRgba => {
  if (point.selected) return rgba(29, 102, 210, 245)
  if (point.highlighted) return rgba(193, 122, 19, 230)
  if (point.statusTone === 'error') return rgba(199, 53, 43, 220)
  return rgba(255, 255, 255, 0)
}

const asPointPicking = (info: PickingInfo<OperationalPointFeature>): OperationalPointFeature | null =>
  info.object ?? null

const placementPointObjects = (
  points: ReadonlyArray<Position3>,
): ReadonlyArray<{ readonly id: string; readonly position: Position3 }> =>
  points.map((position, index) => ({ id: `placement:${index}`, position }))

const deckPath = (
  path: OperationalPathFeature,
): number[] =>
  path.path as unknown as number[]

const pathCasingWidth = (
  path: OperationalPathFeature,
): number =>
  path.kind === 'weather-line' ? 0 : path.widthPx + 4

const pathFamilyIsVisible = (
  path: OperationalPathFeature,
  visibleFamilies: ReadonlySet<string>,
): boolean => {
  if (path.kind === 'route') return visible(visibleFamilies, 'routes')
  return visible(visibleFamilies, 'weather')
}

const areaFamilyIsVisible = (
  area: OperationalAreaFeature,
  visibleFamilies: ReadonlySet<string>,
): boolean => {
  if (area.kind === 'weather-base' || area.kind === 'weather-cell' || area.kind === 'weather-influence') {
    return visible(visibleFamilies, 'weather')
  }
  return true
}

const emptyPaths: ReadonlyArray<OperationalPathFeature> = []
const emptyAreas: ReadonlyArray<OperationalAreaFeature> = []
const emptyPoints: ReadonlyArray<OperationalPointFeature> = []
const emptyPlacementPoints: ReadonlyArray<{ readonly id: string; readonly position: Position3 }> = []

export const createOperationalDeckLayerDataCache = (): OperationalDeckLayerDataCache => {
  let pathsRevision = -1
  let pathsVisibleKey = ''
  let visiblePaths: ReadonlyArray<OperationalPathFeature> = emptyPaths
  let areasRevision = -1
  let areasVisibleKey = ''
  let visibleAreas: ReadonlyArray<OperationalAreaFeature> = emptyAreas
  let pointsRevision = -1
  let newInfoPoints: ReadonlyArray<OperationalPointFeature> = emptyPoints
  let placementRevision = -1
  let placementPoints: ReadonlyArray<{ readonly id: string; readonly position: Position3 }> = emptyPlacementPoints

  const reset = (): void => {
    pathsRevision = -1
    pathsVisibleKey = ''
    visiblePaths = emptyPaths
    areasRevision = -1
    areasVisibleKey = ''
    visibleAreas = emptyAreas
    pointsRevision = -1
    newInfoPoints = emptyPoints
    placementRevision = -1
    placementPoints = emptyPlacementPoints
  }

  return {
    dataFor: (snapshot, visibleFamilies) => {
      const nextVisibleKey = visibleFamiliesKey(visibleFamilies)
      if (pathsRevision !== snapshot.revisions.paths || pathsVisibleKey !== nextVisibleKey) {
        pathsRevision = snapshot.revisions.paths
        pathsVisibleKey = nextVisibleKey
        visiblePaths = snapshot.paths.filter(path => pathFamilyIsVisible(path, visibleFamilies))
      }
      if (areasRevision !== snapshot.revisions.areas || areasVisibleKey !== nextVisibleKey) {
        areasRevision = snapshot.revisions.areas
        areasVisibleKey = nextVisibleKey
        visibleAreas = snapshot.areas.filter(area => areaFamilyIsVisible(area, visibleFamilies))
      }
      if (pointsRevision !== snapshot.revisions.points) {
        pointsRevision = snapshot.revisions.points
        newInfoPoints = snapshot.points.filter(point => point.hasNewInfo)
      }
      if (placementRevision !== snapshot.revisions.placement) {
        placementRevision = snapshot.revisions.placement
        placementPoints = snapshot.placementPoints.length === 0
          ? emptyPlacementPoints
          : placementPointObjects(snapshot.placementPoints)
      }
      return { visiblePaths, visibleAreas, newInfoPoints, placementPoints }
    },
    reset,
  }
}

export const createOperationalDeckLayerFactory = (): OperationalDeckLayerFactory => {
  const dataCache = createOperationalDeckLayerDataCache()
  return {
    createLayers: config => createOperationalDeckLayers({
      ...config,
      layerData: dataCache.dataFor(config.snapshot, config.visibleFamilies),
    }),
    reset: dataCache.reset,
  }
}

export const createOperationalDeckLayers = (
  config: OperationalDeckLayerConfig,
): ReadonlyArray<Layer> => {
  const snapshot = config.snapshot
  const visibleFamilies = config.visibleFamilies
  const layerData = config.layerData ?? createOperationalDeckLayerDataCache().dataFor(snapshot, visibleFamilies)
  const visiblePaths = layerData.visiblePaths
  const visibleAreas = layerData.visibleAreas
  return [
    new PolygonLayer<OperationalAreaFeature>({
      id: 'leitbild-operational-areas',
      data: visibleAreas,
      pickable: false,
      visible: visibleAreas.length > 0,
      getPolygon: area => area.polygon.coordinates[0] ?? [],
      getFillColor: area => area.color,
      getLineColor: area => area.lineColor,
      getLineWidth: area => area.lineWidthPx,
      lineWidthUnits: 'pixels',
      filled: true,
      stroked: true,
      updateTriggers: {
        getPolygon: snapshot.revisions.areas,
        getFillColor: snapshot.revisions.areas,
        getLineColor: snapshot.revisions.areas,
        getLineWidth: snapshot.revisions.areas,
      },
    }),
    new PathLayer<OperationalPathFeature>({
      id: 'leitbild-operational-path-casing',
      data: visiblePaths,
      pickable: false,
      visible: visiblePaths.length > 0,
      getPath: deckPath,
      getColor: path => path.casingColor,
      getWidth: pathCasingWidth,
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
      updateTriggers: {
        getPath: snapshot.revisions.paths,
        getColor: snapshot.revisions.paths,
        getWidth: snapshot.revisions.paths,
      },
    }),
    new PathLayer<OperationalPathFeature>({
      id: 'leitbild-operational-paths',
      data: visiblePaths,
      pickable: true,
      visible: visiblePaths.length > 0,
      getPath: deckPath,
      getColor: path => path.color,
      getWidth: path => path.widthPx,
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
      updateTriggers: {
        getPath: snapshot.revisions.paths,
        getColor: snapshot.revisions.paths,
        getWidth: snapshot.revisions.paths,
      },
    }),
    new ScatterplotLayer<OperationalPointFeature>({
      id: 'leitbild-object-halos',
      data: snapshot.points,
      pickable: false,
      visible: visible(visibleFamilies, 'objects'),
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: point => point.position,
      getRadius: point => point.selected || point.highlighted || point.statusTone === 'error' ? 18 : 0,
      getFillColor: haloFill,
      getLineColor: haloStroke,
      getLineWidth: point => point.selected || point.highlighted ? 2.5 : point.statusTone === 'error' ? 2 : 0,
      updateTriggers: {
        getPosition: snapshot.revisions.points,
        getRadius: snapshot.revisions.points,
        getFillColor: snapshot.revisions.points,
        getLineColor: snapshot.revisions.points,
        getLineWidth: snapshot.revisions.points,
      },
    }),
    new ScatterplotLayer<OperationalPointFeature>({
      id: 'leitbild-object-status-disks',
      data: snapshot.points,
      pickable: false,
      visible: visible(visibleFamilies, 'objects'),
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: point => point.position,
      getRadius: point => point.sizePx * 0.74,
      getFillColor: pointFill,
      getLineColor: darkStroke(185),
      getLineWidth: 1,
      updateTriggers: {
        getPosition: snapshot.revisions.points,
        getRadius: snapshot.revisions.points,
        getFillColor: snapshot.revisions.points,
      },
    }),
    new IconLayer<OperationalPointFeature>({
      id: 'leitbild-object-symbols',
      data: snapshot.points,
      pickable: true,
      visible: visible(visibleFamilies, 'objects'),
      iconAtlas: atlasUrl,
      iconMapping,
      sizeUnits: 'pixels',
      getIcon: point => point.symbolId,
      getPosition: point => point.position,
      getColor: point => point.muted ? white(150) : white(245),
      getSize: point => point.sizePx,
      getAngle: point => point.rotationDeg,
      onClick: info => {
        const point = asPointPicking(info)
        if (!point) return
        config.onObjectSeen(point)
        config.onObjectSelected(point)
      },
      onHover: info => {
        config.onObjectHover(asPointPicking(info))
      },
      updateTriggers: {
        getIcon: snapshot.revisions.points,
        getPosition: snapshot.revisions.points,
        getColor: snapshot.revisions.points,
        getSize: snapshot.revisions.points,
        getAngle: snapshot.revisions.points,
      },
    }),
    new ScatterplotLayer<OperationalPointFeature>({
      id: 'leitbild-object-new-info',
      data: layerData.newInfoPoints,
      pickable: false,
      visible: visible(visibleFamilies, 'objects'),
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: point => [point.position[0], point.position[1], point.position[2] + 1],
      getRadius: 5,
      getFillColor: rgba(199, 53, 43, 245),
      getLineColor: white(245),
      getLineWidth: 1.5,
      updateTriggers: {
        getPosition: snapshot.revisions.points,
      },
    }),
    new IconLayer<OperationalSymbolFeature>({
      id: 'leitbild-area-symbols',
      data: snapshot.areaSymbols,
      pickable: false,
      visible: visible(visibleFamilies, 'weather'),
      iconAtlas: atlasUrl,
      iconMapping,
      sizeUnits: 'pixels',
      getIcon: symbol => symbol.symbolId,
      getPosition: symbol => symbol.position,
      getColor: symbol => symbol.color,
      getSize: symbol => symbol.sizePx,
      updateTriggers: {
        getIcon: snapshot.revisions.areaSymbols,
        getPosition: snapshot.revisions.areaSymbols,
        getColor: snapshot.revisions.areaSymbols,
        getSize: snapshot.revisions.areaSymbols,
      },
    }),
    new ScatterplotLayer<{ readonly id: string; readonly position: Position3 }>({
      id: 'leitbild-placement-preview',
      data: layerData.placementPoints,
      pickable: false,
      visible: snapshot.placementPoints.length > 0,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: point => point.position,
      getRadius: 7,
      getFillColor: rgba(29, 102, 210, 235),
      getLineColor: white(245),
      getLineWidth: 3,
      updateTriggers: {
        getPosition: snapshot.revisions.placement,
      },
    }),
  ]
}

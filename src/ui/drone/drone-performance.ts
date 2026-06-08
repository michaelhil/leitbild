export interface DroneScenePerformanceSnapshot {
  readonly fps: number
  readonly frameMs: number
  readonly frameP95Ms: number
  readonly frameCpuMs: number
  readonly renderMs: number
  readonly jankPercent: number
  readonly drawCalls: number
  readonly triangles: number
  readonly geometries: number
  readonly textures: number
  readonly pixelRatio: number
  readonly quality: 'high' | 'balanced' | 'rescue'
  readonly worldLoadMs: number
  readonly worldBuildMs: number
  readonly worldSource: 'worker' | 'main'
  readonly activeScenes: number
  readonly worldFeatures: {
    readonly sceneryStage: 'fallback' | 'near' | 'full'
    readonly tiles: number
    readonly polygons: number
    readonly lines: number
    readonly points: number
    readonly buildings: number
    readonly roads: number
    readonly water: number
    readonly vegetation: number
    readonly roadLabels: number
    readonly lineFragmentsMerged: number
    readonly terrain: 'available' | 'unavailable' | 'unknown'
    readonly terrainSurface: 'dem' | 'flat'
  }
}

export interface DroneFramePerformanceTracker {
  readonly beginFrame: (nowMs: number) => void
  readonly endFrame: (nowMs: number, renderMs: number) => {
    readonly shouldReport: boolean
    readonly renderMs: number
  }
  readonly updateWorld: (config: {
    readonly sceneryStage: DroneScenePerformanceSnapshot['worldFeatures']['sceneryStage']
    readonly loadMs: number
    readonly buildMs: number
    readonly source: DroneScenePerformanceSnapshot['worldSource']
    readonly tiles: number
    readonly polygons: number
    readonly lines: number
    readonly points: number
    readonly buildings: number
    readonly roads: number
    readonly water: number
    readonly vegetation: number
    readonly roadLabels: number
    readonly lineFragmentsMerged: number
    readonly terrain: DroneScenePerformanceSnapshot['worldFeatures']['terrain']
    readonly terrainSurface: DroneScenePerformanceSnapshot['worldFeatures']['terrainSurface']
  }) => void
  readonly snapshot: (renderInfo: {
    readonly drawCalls: number
    readonly triangles: number
    readonly geometries: number
    readonly textures: number
    readonly pixelRatio: number
    readonly quality: DroneScenePerformanceSnapshot['quality']
    readonly activeScenes: number
  }) => DroneScenePerformanceSnapshot
}

const sampleSize = 150
const reportIntervalMs = 500
const jankThresholdMs = 34

const percentile = (
  values: ReadonlyArray<number>,
  ratio: number,
): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))
  return sorted[index] ?? 0
}

const average = (
  values: ReadonlyArray<number>,
): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

export const createDroneFramePerformanceTracker = (): DroneFramePerformanceTracker => {
  const frameIntervals: number[] = []
  const frameCpuDurations: number[] = []
  const renderDurations: number[] = []
  let frameStartedAtMs = 0
  let previousFrameStartedAtMs = 0
  let lastReportAtMs = 0
  let worldLoadMs = 0
  let worldBuildMs = 0
  let worldSource: DroneScenePerformanceSnapshot['worldSource'] = 'main'
  let tiles = 0
  let polygons = 0
  let lines = 0
  let points = 0
  let buildings = 0
  let roads = 0
  let water = 0
  let vegetation = 0
  let roadLabels = 0
  let lineFragmentsMerged = 0
  let terrain: DroneScenePerformanceSnapshot['worldFeatures']['terrain'] = 'unknown'
  let terrainSurface: DroneScenePerformanceSnapshot['worldFeatures']['terrainSurface'] = 'flat'
  let sceneryStage: DroneScenePerformanceSnapshot['worldFeatures']['sceneryStage'] = 'fallback'

  const pushSample = (samples: number[], value: number): void => {
    samples.push(value)
    if (samples.length > sampleSize) samples.shift()
  }

  return {
    beginFrame: (nowMs: number): void => {
      if (previousFrameStartedAtMs > 0) pushSample(frameIntervals, nowMs - previousFrameStartedAtMs)
      previousFrameStartedAtMs = nowMs
      frameStartedAtMs = nowMs
    },
    endFrame: (nowMs: number, renderMs: number): { readonly shouldReport: boolean; readonly renderMs: number } => {
      const frameCpuMs = Math.max(0, nowMs - frameStartedAtMs)
      pushSample(frameCpuDurations, frameCpuMs)
      pushSample(renderDurations, renderMs)
      const shouldReport = nowMs - lastReportAtMs >= reportIntervalMs
      if (shouldReport) lastReportAtMs = nowMs
      return { shouldReport, renderMs }
    },
    updateWorld: (config): void => {
      sceneryStage = config.sceneryStage
      worldLoadMs = config.loadMs
      worldBuildMs = config.buildMs
      worldSource = config.source
      tiles = config.tiles
      polygons = config.polygons
      lines = config.lines
      points = config.points
      buildings = config.buildings
      roads = config.roads
      water = config.water
      vegetation = config.vegetation
      roadLabels = config.roadLabels
      lineFragmentsMerged = config.lineFragmentsMerged
      terrain = config.terrain
      terrainSurface = config.terrainSurface
    },
    snapshot: (renderInfo): DroneScenePerformanceSnapshot => {
      const avgFrameMs = average(frameIntervals)
      const jankFrames = frameIntervals.filter(value => value >= jankThresholdMs).length
      return {
        fps: avgFrameMs <= 0 ? 0 : 1000 / avgFrameMs,
        frameMs: avgFrameMs,
        frameP95Ms: percentile(frameIntervals, 0.95),
        frameCpuMs: average(frameCpuDurations),
        renderMs: average(renderDurations),
        jankPercent: frameIntervals.length === 0 ? 0 : jankFrames / frameIntervals.length * 100,
        drawCalls: renderInfo.drawCalls,
        triangles: renderInfo.triangles,
        geometries: renderInfo.geometries,
        textures: renderInfo.textures,
        pixelRatio: renderInfo.pixelRatio,
        quality: renderInfo.quality,
        worldLoadMs,
        worldBuildMs,
        worldSource,
        activeScenes: renderInfo.activeScenes,
        worldFeatures: {
          sceneryStage,
          tiles,
          polygons,
          lines,
          points,
          buildings,
          roads,
          water,
          vegetation,
          roadLabels,
          lineFragmentsMerged,
          terrain,
          terrainSurface,
        },
      }
    },
  }
}

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
  readonly activeScenes: number
  readonly worldFeatures: {
    readonly tiles: number
    readonly polygons: number
    readonly lines: number
    readonly points: number
  }
}

export interface DroneFramePerformanceTracker {
  readonly beginFrame: (nowMs: number) => void
  readonly endFrame: (nowMs: number, renderMs: number) => {
    readonly shouldReport: boolean
    readonly renderMs: number
  }
  readonly updateWorld: (config: {
    readonly loadMs: number
    readonly buildMs: number
    readonly tiles: number
    readonly polygons: number
    readonly lines: number
    readonly points: number
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
  let tiles = 0
  let polygons = 0
  let lines = 0
  let points = 0

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
      worldLoadMs = config.loadMs
      worldBuildMs = config.buildMs
      tiles = config.tiles
      polygons = config.polygons
      lines = config.lines
      points = config.points
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
        activeScenes: renderInfo.activeScenes,
        worldFeatures: { tiles, polygons, lines, points },
      }
    },
  }
}

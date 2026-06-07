export interface DroneScenePerformanceSnapshot {
  readonly fps: number
  readonly frameMs: number
  readonly frameP95Ms: number
  readonly jankPercent: number
  readonly drawCalls: number
  readonly triangles: number
  readonly geometries: number
  readonly textures: number
  readonly pixelRatio: number
  readonly quality: 'high' | 'balanced' | 'rescue'
  readonly worldLoadMs: number
  readonly worldBuildMs: number
  readonly worldFeatures: {
    readonly polygons: number
    readonly lines: number
    readonly points: number
  }
}

export interface DroneFramePerformanceTracker {
  readonly beginFrame: (nowMs: number) => void
  readonly endFrame: (nowMs: number) => {
    readonly shouldReport: boolean
    readonly frameMs: number
  }
  readonly updateWorld: (config: {
    readonly loadMs: number
    readonly buildMs: number
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
  const frameDurations: number[] = []
  let frameStartedAtMs = 0
  let lastReportAtMs = 0
  let worldLoadMs = 0
  let worldBuildMs = 0
  let polygons = 0
  let lines = 0
  let points = 0

  const pushFrame = (durationMs: number): void => {
    frameDurations.push(durationMs)
    if (frameDurations.length > sampleSize) frameDurations.shift()
  }

  return {
    beginFrame: (nowMs: number): void => {
      frameStartedAtMs = nowMs
    },
    endFrame: (nowMs: number): { readonly shouldReport: boolean; readonly frameMs: number } => {
      const frameMs = Math.max(0, nowMs - frameStartedAtMs)
      pushFrame(frameMs)
      const shouldReport = nowMs - lastReportAtMs >= reportIntervalMs
      if (shouldReport) lastReportAtMs = nowMs
      return { shouldReport, frameMs }
    },
    updateWorld: (config): void => {
      worldLoadMs = config.loadMs
      worldBuildMs = config.buildMs
      polygons = config.polygons
      lines = config.lines
      points = config.points
    },
    snapshot: (renderInfo): DroneScenePerformanceSnapshot => {
      const avgFrameMs = average(frameDurations)
      const jankFrames = frameDurations.filter(value => value >= jankThresholdMs).length
      return {
        fps: avgFrameMs <= 0 ? 0 : 1000 / avgFrameMs,
        frameMs: avgFrameMs,
        frameP95Ms: percentile(frameDurations, 0.95),
        jankPercent: frameDurations.length === 0 ? 0 : jankFrames / frameDurations.length * 100,
        drawCalls: renderInfo.drawCalls,
        triangles: renderInfo.triangles,
        geometries: renderInfo.geometries,
        textures: renderInfo.textures,
        pixelRatio: renderInfo.pixelRatio,
        quality: renderInfo.quality,
        worldLoadMs,
        worldBuildMs,
        worldFeatures: { polygons, lines, points },
      }
    },
  }
}

import type { SimulationRunId } from '../../core/model/index.ts'

export interface ProcessDisplayWidgetPosition {
  readonly x: number
  readonly y: number
}

export interface ProcessDisplayWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type ProcessDisplayLayout = Readonly<Record<string, ProcessDisplayWidgetPosition>>

interface StorageLike {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

const layoutStoragePrefix = 'leitbild.processDisplayLayout.v1'
const windowStoragePrefix = 'leitbild.processDisplayWindow.v1'

const browserStorage = (): StorageLike | null =>
  typeof localStorage === 'undefined' ? null : localStorage

const storageKeyFor = (config: {
  readonly simulationRunId: SimulationRunId
  readonly plantId: string
  readonly displayId: string
}): string =>
  `${layoutStoragePrefix}:${config.simulationRunId}:${config.plantId}:${config.displayId}`

const windowStorageKeyFor = (config: {
  readonly simulationRunId: SimulationRunId
  readonly plantId: string
  readonly displayId: string
}): string =>
  `${windowStoragePrefix}:${config.simulationRunId}:${config.plantId}:${config.displayId}`

const isFiniteCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const parseLayout = (value: unknown): ProcessDisplayLayout => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('process display layout must be an object')
  const entries: Array<[string, ProcessDisplayWidgetPosition]> = []
  for (const [widgetId, position] of Object.entries(value)) {
    if (widgetId.length === 0 || typeof position !== 'object' || position === null || Array.isArray(position)) {
      throw new Error('process display layout contains an invalid widget entry')
    }
    const record = position as Record<string, unknown>
    if (!isFiniteCoordinate(record.x) || !isFiniteCoordinate(record.y)) {
      throw new Error(`process display layout contains invalid coordinates for ${widgetId}`)
    }
    entries.push([widgetId, { x: record.x, y: record.y }])
  }
  return Object.fromEntries(entries)
}

const parseWindowBounds = (value: unknown): ProcessDisplayWindowBounds => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('process display window bounds must be an object')
  }
  const record = value as Record<string, unknown>
  if (
    !isFiniteCoordinate(record.x)
    || !isFiniteCoordinate(record.y)
    || !isFiniteCoordinate(record.width)
    || !isFiniteCoordinate(record.height)
  ) {
    throw new Error('process display window bounds contains invalid coordinates')
  }
  return {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
  }
}

export const readProcessDisplayLayout = (
  config: {
    readonly simulationRunId: SimulationRunId
    readonly plantId: string
    readonly displayId: string
  },
  storage: StorageLike | null = browserStorage(),
): ProcessDisplayLayout => {
  if (!storage) return {}
  const raw = storage.getItem(storageKeyFor(config))
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`process display layout storage is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return parseLayout(parsed)
}

export const storeProcessDisplayLayout = (
  config: {
    readonly simulationRunId: SimulationRunId
    readonly plantId: string
    readonly displayId: string
    readonly layout: ProcessDisplayLayout
  },
  storage: StorageLike | null = browserStorage(),
): void => {
  if (!storage) return
  storage.setItem(storageKeyFor(config), JSON.stringify(config.layout))
}

export const readProcessDisplayWindowBounds = (
  config: {
    readonly simulationRunId: SimulationRunId
    readonly plantId: string
    readonly displayId: string
  },
  storage: StorageLike | null = browserStorage(),
): ProcessDisplayWindowBounds | null => {
  if (!storage) return null
  const raw = storage.getItem(windowStorageKeyFor(config))
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`process display window storage is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return parseWindowBounds(parsed)
}

export const storeProcessDisplayWindowBounds = (
  config: {
    readonly simulationRunId: SimulationRunId
    readonly plantId: string
    readonly displayId: string
    readonly bounds: ProcessDisplayWindowBounds
  },
  storage: StorageLike | null = browserStorage(),
): void => {
  if (!storage) return
  storage.setItem(windowStorageKeyFor(config), JSON.stringify(config.bounds))
}

import type { ControlInstanceId } from '../../core/model/index.ts'

export interface ProcessSurfaceWidgetPosition {
  readonly x: number
  readonly y: number
}

export interface ProcessSurfaceWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type ProcessSurfaceLayout = Readonly<Record<string, ProcessSurfaceWidgetPosition>>

interface StorageLike {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

const layoutStoragePrefix = 'leitbild.processSurfaceLayout.v1'
const windowStoragePrefix = 'leitbild.processSurfaceWindow.v1'

const browserStorage = (): StorageLike | null =>
  typeof localStorage === 'undefined' ? null : localStorage

const storageKeyFor = (config: {
  readonly controlInstanceId: ControlInstanceId
  readonly systemId: string
  readonly surfaceId: string
}): string =>
  `${layoutStoragePrefix}:${config.controlInstanceId}:${config.systemId}:${config.surfaceId}`

const windowStorageKeyFor = (config: {
  readonly controlInstanceId: ControlInstanceId
  readonly systemId: string
  readonly surfaceId: string
}): string =>
  `${windowStoragePrefix}:${config.controlInstanceId}:${config.systemId}:${config.surfaceId}`

const isFiniteCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const parseLayout = (value: unknown): ProcessSurfaceLayout => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('process surface layout must be an object')
  const entries: Array<[string, ProcessSurfaceWidgetPosition]> = []
  for (const [widgetId, position] of Object.entries(value)) {
    if (widgetId.length === 0 || typeof position !== 'object' || position === null || Array.isArray(position)) {
      throw new Error('process surface layout contains an invalid widget entry')
    }
    const record = position as Record<string, unknown>
    if (!isFiniteCoordinate(record.x) || !isFiniteCoordinate(record.y)) {
      throw new Error(`process surface layout contains invalid coordinates for ${widgetId}`)
    }
    entries.push([widgetId, { x: record.x, y: record.y }])
  }
  return Object.fromEntries(entries)
}

const parseWindowBounds = (value: unknown): ProcessSurfaceWindowBounds => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('process surface window bounds must be an object')
  }
  const record = value as Record<string, unknown>
  if (
    !isFiniteCoordinate(record.x)
    || !isFiniteCoordinate(record.y)
    || !isFiniteCoordinate(record.width)
    || !isFiniteCoordinate(record.height)
  ) {
    throw new Error('process surface window bounds contains invalid coordinates')
  }
  return {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
  }
}

export const readProcessSurfaceLayout = (
  config: {
    readonly controlInstanceId: ControlInstanceId
    readonly systemId: string
    readonly surfaceId: string
  },
  storage: StorageLike | null = browserStorage(),
): ProcessSurfaceLayout => {
  if (!storage) return {}
  const raw = storage.getItem(storageKeyFor(config))
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`process surface layout storage is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return parseLayout(parsed)
}

export const storeProcessSurfaceLayout = (
  config: {
    readonly controlInstanceId: ControlInstanceId
    readonly systemId: string
    readonly surfaceId: string
    readonly layout: ProcessSurfaceLayout
  },
  storage: StorageLike | null = browserStorage(),
): void => {
  if (!storage) return
  storage.setItem(storageKeyFor(config), JSON.stringify(config.layout))
}

export const readProcessSurfaceWindowBounds = (
  config: {
    readonly controlInstanceId: ControlInstanceId
    readonly systemId: string
    readonly surfaceId: string
  },
  storage: StorageLike | null = browserStorage(),
): ProcessSurfaceWindowBounds | null => {
  if (!storage) return null
  const raw = storage.getItem(windowStorageKeyFor(config))
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`process surface window storage is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return parseWindowBounds(parsed)
}

export const storeProcessSurfaceWindowBounds = (
  config: {
    readonly controlInstanceId: ControlInstanceId
    readonly systemId: string
    readonly surfaceId: string
    readonly bounds: ProcessSurfaceWindowBounds
  },
  storage: StorageLike | null = browserStorage(),
): void => {
  if (!storage) return
  storage.setItem(windowStorageKeyFor(config), JSON.stringify(config.bounds))
}

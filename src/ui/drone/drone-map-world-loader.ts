import {
  loadCachedDroneMapWorld,
  loadDroneWorldTerrainStatus,
  type DroneMapWorldSnapshot,
  type DroneWorldCenter,
  type DroneWorldTerrainStatus,
} from './drone-map-world.ts'

export type DroneMapWorldLoadSource = 'worker' | 'main'

export interface DroneMapWorldLoadResult {
  readonly snapshot: DroneMapWorldSnapshot
  readonly source: DroneMapWorldLoadSource
  readonly terrain: DroneWorldTerrainStatus
  readonly fallbackReason?: string
}

interface DroneMapWorldWorkerRequest {
  readonly id: string
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly zoom: number
}

type DroneMapWorldWorkerResponse =
  | {
      readonly id: string
      readonly ok: true
      readonly snapshot: DroneMapWorldSnapshot
    }
  | {
      readonly id: string
      readonly ok: false
      readonly message: string
    }

interface PendingWorkerRequest {
  readonly resolve: (snapshot: DroneMapWorldSnapshot) => void
  readonly reject: (err: Error) => void
}

const pendingWorkerRequests = new Map<string, PendingWorkerRequest>()

let nextWorkerRequestId = 1
let droneMapWorldWorker: Worker | null = null
let workerDisabledReason = ''

const workerSupported = (): boolean =>
  typeof window !== 'undefined' && typeof Worker !== 'undefined'

const rejectPendingWorkerRequests = (
  err: Error,
): void => {
  for (const pending of pendingWorkerRequests.values()) pending.reject(err)
  pendingWorkerRequests.clear()
}

const disableWorker = (
  reason: string,
): void => {
  workerDisabledReason = reason
  if (droneMapWorldWorker) {
    droneMapWorldWorker.terminate()
    droneMapWorldWorker = null
  }
  rejectPendingWorkerRequests(new Error(reason))
}

const getDroneMapWorldWorker = (): Worker | null => {
  if (!workerSupported() || workerDisabledReason !== '') return null
  if (droneMapWorldWorker) return droneMapWorldWorker
  const worker = new Worker(new URL('./drone-map-world-worker.ts', import.meta.url), {
    name: 'leitbild-drone-map-world',
    type: 'module',
  })
  worker.addEventListener('message', (event: MessageEvent<DroneMapWorldWorkerResponse>) => {
    const response = event.data
    const pending = pendingWorkerRequests.get(response.id)
    if (!pending) return
    pendingWorkerRequests.delete(response.id)
    if (response.ok) {
      pending.resolve(response.snapshot)
      return
    }
    pending.reject(new Error(response.message))
  })
  worker.addEventListener('error', (event: ErrorEvent) => {
    disableWorker(event.message || 'drone map world worker failed')
  })
  worker.addEventListener('messageerror', () => {
    disableWorker('drone map world worker returned an unreadable message')
  })
  droneMapWorldWorker = worker
  return worker
}

const loadWithWorker = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly zoom: number
}): Promise<DroneMapWorldSnapshot> => {
  const worker = getDroneMapWorldWorker()
  if (!worker) {
    throw new Error(workerDisabledReason || 'drone map world worker is unavailable')
  }
  const id = `drone-world:${nextWorkerRequestId}`
  nextWorkerRequestId += 1
  const request: DroneMapWorldWorkerRequest = {
    id,
    center: config.center,
    radiusM: config.radiusM,
    zoom: config.zoom,
  }
  return await new Promise<DroneMapWorldSnapshot>((resolve, reject) => {
    pendingWorkerRequests.set(id, { resolve, reject })
    worker.postMessage(request)
  })
}

export const loadDroneMapWorldForScene = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM?: number
  readonly zoom?: number
}): Promise<DroneMapWorldLoadResult> => {
  const radiusM = config.radiusM ?? 4_250
  const zoom = config.zoom ?? 14
  try {
    const snapshot = await loadWithWorker({ center: config.center, radiusM, zoom })
    const terrain = await loadDroneWorldTerrainStatus()
    return { snapshot, source: 'worker', terrain }
  } catch (err) {
    const fallbackReason = err instanceof Error ? err.message : String(err)
    const snapshot = await loadCachedDroneMapWorld({ center: config.center, radiusM, zoom })
    const terrain = await loadDroneWorldTerrainStatus()
    return { snapshot, source: 'main', terrain, fallbackReason }
  }
}

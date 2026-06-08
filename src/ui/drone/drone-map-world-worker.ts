import { loadDroneMapWorld, type DroneMapWorldSnapshot, type DroneWorldCenter } from './drone-map-world.ts'

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

const isRequest = (
  value: unknown,
): value is DroneMapWorldWorkerRequest => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const center = candidate.center
  return typeof candidate.id === 'string'
    && typeof candidate.radiusM === 'number'
    && Number.isFinite(candidate.radiusM)
    && typeof candidate.zoom === 'number'
    && Number.isFinite(candidate.zoom)
    && !!center
    && typeof center === 'object'
    && typeof (center as Record<string, unknown>).lon === 'number'
    && typeof (center as Record<string, unknown>).lat === 'number'
}

const postWorkerResponse = (
  response: DroneMapWorldWorkerResponse,
): void => {
  globalThis.postMessage(response)
}

globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
  void (async (): Promise<void> => {
    const request = event.data
    if (!isRequest(request)) {
      postWorkerResponse({ id: 'unknown', ok: false, message: 'invalid drone map world worker request' })
      return
    }
    try {
      const snapshot = await loadDroneMapWorld({
        center: request.center,
        radiusM: request.radiusM,
        zoom: request.zoom,
      })
      postWorkerResponse({ id: request.id, ok: true, snapshot })
    } catch (err) {
      postWorkerResponse({
        id: request.id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })()
})

import {
  defaultSamsinnAllowedParentOrigins,
  defaultSamsinnScreenshotMaxDataUrlBytes,
  type SamsinnScreenshotConfig,
} from '../core/api/client-config.ts'

export {
  defaultSamsinnAllowedParentOrigins,
  defaultSamsinnScreenshotMaxDataUrlBytes,
  type SamsinnScreenshotConfig,
} from '../core/api/client-config.ts'

export const samsinnScreenshotRequestType = 'samsinn.screenshot.request'
export const samsinnScreenshotResponseType = 'samsinn.screenshot.response'
export const samsinnScreenshotProtocolVersion = '1.0'

export interface SamsinnScreenshotRequest {
  readonly type: typeof samsinnScreenshotRequestType
  readonly requestId: string
}

export type SamsinnScreenshotResponse =
  | {
      readonly type: typeof samsinnScreenshotResponseType
      readonly requestId: string
      readonly protocolVersion: typeof samsinnScreenshotProtocolVersion
      readonly dataUrl: string
      readonly width: number
      readonly height: number
    }
  | {
      readonly type: typeof samsinnScreenshotResponseType
      readonly requestId: string
      readonly protocolVersion: typeof samsinnScreenshotProtocolVersion
      readonly error: string
      readonly message: string
    }

export interface SamsinnScreenshotCapture {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
}

export interface SamsinnScreenshotCaptureOptions {
  readonly maxDataUrlBytes: number
}

interface ParsedAllowedOrigin {
  readonly protocol: string
  readonly hostname: string
  readonly port: string
  readonly wildcardSubdomains: boolean
}

export const dataUrlByteLength = (dataUrl: string): number =>
  new TextEncoder().encode(dataUrl).byteLength

export const fetchSamsinnScreenshotConfig = async (): Promise<SamsinnScreenshotConfig> => {
  const response = await fetch('/api/client-config', { cache: 'no-store' })
  if (!response.ok) throw new Error(`client config fetch failed: ${response.status}`)
  const body = await response.json() as { readonly samsinnScreenshot?: Partial<SamsinnScreenshotConfig> }
  return {
    enabled: body.samsinnScreenshot?.enabled === true,
    allowedParentOrigins: typeof body.samsinnScreenshot?.allowedParentOrigins === 'string'
      ? body.samsinnScreenshot.allowedParentOrigins
      : defaultSamsinnAllowedParentOrigins,
    maxDataUrlBytes: typeof body.samsinnScreenshot?.maxDataUrlBytes === 'number'
      ? body.samsinnScreenshot.maxDataUrlBytes
      : defaultSamsinnScreenshotMaxDataUrlBytes,
  }
}

const parseAllowedOrigin = (raw: string): ParsedAllowedOrigin | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const wildcardPrefix = 'https://*.'
    if (trimmed.startsWith(wildcardPrefix)) {
      const url = new URL(`https://${trimmed.slice(wildcardPrefix.length)}`)
      return {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        wildcardSubdomains: true,
      }
    }
    const url = new URL(trimmed)
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      wildcardSubdomains: false,
    }
  } catch {
    return null
  }
}

export const isOriginAllowed = (origin: string, allowedOrigins: string): boolean => {
  let parsedOrigin: URL
  try {
    parsedOrigin = new URL(origin)
  } catch {
    return false
  }

  return allowedOrigins
    .split(',')
    .map(parseAllowedOrigin)
    .some((allowed): boolean => {
      if (!allowed) return false
      if (allowed.protocol !== parsedOrigin.protocol) return false
      if (allowed.port !== parsedOrigin.port) return false
      if (allowed.wildcardSubdomains) {
        return parsedOrigin.hostname.endsWith(`.${allowed.hostname}`)
      }
      return parsedOrigin.hostname === allowed.hostname
    })
}

export const validateSamsinnScreenshotRequest = (data: unknown): SamsinnScreenshotRequest | null => {
  if (!data || typeof data !== 'object') return null
  const candidate = data as { readonly type?: unknown; readonly requestId?: unknown }
  if (candidate.type !== samsinnScreenshotRequestType) return null
  if (typeof candidate.requestId !== 'string' || candidate.requestId.trim() === '') return null
  return {
    type: samsinnScreenshotRequestType,
    requestId: candidate.requestId,
  }
}

export const successSamsinnScreenshotResponse = (
  requestId: string,
  capture: SamsinnScreenshotCapture,
): SamsinnScreenshotResponse => ({
  type: samsinnScreenshotResponseType,
  requestId,
  protocolVersion: samsinnScreenshotProtocolVersion,
  dataUrl: capture.dataUrl,
  width: capture.width,
  height: capture.height,
})

export const errorSamsinnScreenshotResponse = (
  requestId: string,
  error: string,
  message: string,
): SamsinnScreenshotResponse => ({
  type: samsinnScreenshotResponseType,
  requestId,
  protocolVersion: samsinnScreenshotProtocolVersion,
  error,
  message,
})

export const captureMapCanvasScreenshot = (
  canvas: HTMLCanvasElement,
  options: SamsinnScreenshotCaptureOptions,
): SamsinnScreenshotCapture => {
  const width = canvas.width
  const height = canvas.height
  if (width <= 0 || height <= 0) throw new Error('map canvas has no drawable area')

  const sampleCanvas = document.createElement('canvas')
  sampleCanvas.width = width
  sampleCanvas.height = height
  const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true })
  if (!sampleContext) throw new Error('could not create screenshot sample context')
  sampleContext.drawImage(canvas, 0, 0)

  const samplePoints = [
    [Math.floor(width / 2), Math.floor(height / 2)],
    [Math.floor(width / 4), Math.floor(height / 4)],
    [Math.floor(width * 3 / 4), Math.floor(height / 4)],
    [Math.floor(width / 4), Math.floor(height * 3 / 4)],
    [Math.floor(width * 3 / 4), Math.floor(height * 3 / 4)],
  ] as const
  const nonBlank = samplePoints.some(([x, y]) => {
    const [red, green, blue, alpha] = sampleContext.getImageData(x, y, 1, 1).data
    return alpha !== 0 && (red !== 0 || green !== 0 || blue !== 0)
  })
  if (!nonBlank) throw new Error('map canvas rendered blank pixels')

  const encodeFromSample = (mimeType: 'image/png' | 'image/jpeg', quality?: number): string =>
    sampleCanvas.toDataURL(mimeType, quality)

  const png = encodeFromSample('image/png')
  if (dataUrlByteLength(png) <= options.maxDataUrlBytes) {
    return { dataUrl: png, width, height }
  }

  let scale = Math.sqrt(options.maxDataUrlBytes / dataUrlByteLength(png))
  while (scale > 0.2) {
    const downscaledWidth = Math.max(1, Math.floor(width * scale))
    const downscaledHeight = Math.max(1, Math.floor(height * scale))
    const downscaled = document.createElement('canvas')
    downscaled.width = downscaledWidth
    downscaled.height = downscaledHeight
    const context = downscaled.getContext('2d')
    if (!context) throw new Error('could not create screenshot resize context')
    context.drawImage(sampleCanvas, 0, 0, downscaledWidth, downscaledHeight)
    const downscaledPng = downscaled.toDataURL('image/png')
    if (dataUrlByteLength(downscaledPng) <= options.maxDataUrlBytes) {
      return { dataUrl: downscaledPng, width: downscaledWidth, height: downscaledHeight }
    }
    const jpeg = downscaled.toDataURL('image/jpeg', 0.85)
    if (dataUrlByteLength(jpeg) <= options.maxDataUrlBytes) {
      return { dataUrl: jpeg, width: downscaledWidth, height: downscaledHeight }
    }
    scale *= 0.8
  }

  throw new Error('screenshot exceeds configured data URL byte cap')
}

export const handleSamsinnScreenshotRequest = async (config: {
  readonly request: SamsinnScreenshotRequest
  readonly enabled: boolean
  readonly maxDataUrlBytes: number
  readonly capture: (options: SamsinnScreenshotCaptureOptions) => Promise<SamsinnScreenshotCapture>
}): Promise<SamsinnScreenshotResponse> => {
  if (!config.enabled) {
    return errorSamsinnScreenshotResponse(config.request.requestId, 'disabled', 'screenshot capture is disabled')
  }
  try {
    const capture = await config.capture({ maxDataUrlBytes: config.maxDataUrlBytes })
    if (dataUrlByteLength(capture.dataUrl) > config.maxDataUrlBytes) {
      return errorSamsinnScreenshotResponse(config.request.requestId, 'oversized', 'screenshot exceeds configured data URL byte cap')
    }
    return successSamsinnScreenshotResponse(config.request.requestId, capture)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('exceeds configured data URL byte cap')) {
      return errorSamsinnScreenshotResponse(config.request.requestId, 'oversized', message)
    }
    return errorSamsinnScreenshotResponse(config.request.requestId, 'capture_failed', message)
  }
}

export const installSamsinnScreenshotResponder = (config: {
  readonly enabled: boolean
  readonly allowedParentOrigins: string
  readonly maxDataUrlBytes: number
  readonly capture: (options: SamsinnScreenshotCaptureOptions) => Promise<SamsinnScreenshotCapture>
  readonly currentWindow?: Window
}): (() => void) => {
  const currentWindow = config.currentWindow ?? window
  const handleMessage = (event: MessageEvent): void => {
    const request = validateSamsinnScreenshotRequest(event.data)
    if (!request) return
    if (event.source !== currentWindow.parent) return
    const target = event.source
    if (!target) return
    if (!isOriginAllowed(event.origin, config.allowedParentOrigins)) {
      target.postMessage(
        errorSamsinnScreenshotResponse(request.requestId, 'origin_mismatch', 'parent origin is not allowed'),
        event.origin,
      )
      return
    }
    const sendResponse = async (): Promise<void> => {
      const response = await handleSamsinnScreenshotRequest({
        request,
        enabled: config.enabled,
        maxDataUrlBytes: config.maxDataUrlBytes,
        capture: config.capture,
      })
      target.postMessage(response, event.origin)
    }
    void sendResponse()
  }
  currentWindow.addEventListener('message', handleMessage)
  return () => {
    currentWindow.removeEventListener('message', handleMessage)
  }
}

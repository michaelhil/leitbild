import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createMapCapabilityManifest } from './capabilities.ts'
import { createLeitbildMapStyle } from './style.ts'

export interface MapArtifactConfig {
  readonly rootDir: string
}

const pmtilesContentType = 'application/vnd.pmtiles'

export const createMapArtifactConfigFromEnv = (): MapArtifactConfig => ({
  rootDir: resolve(process.env.LEITBILD_MAP_ROOT ?? '/opt/leitbild/maps'),
})

export const currentPmtilesPath = (config: MapArtifactConfig): string =>
  resolve(config.rootDir, 'current', 'norway.pmtiles')

export const mapCapabilitiesResponse = (): Response =>
  Response.json(createMapCapabilityManifest())

export const mapStyleResponse = (): Response =>
  Response.json(createLeitbildMapStyle())

const parseRange = (rangeHeader: string | null, size: number): { readonly start: number; readonly end: number } | null => {
  if (!rangeHeader) return null
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    const suffixLength = Number(rawEnd)
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null
    const start = Math.max(0, size - suffixLength)
    return { start, end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

export const currentPmtilesResponse = async (req: Request, config: MapArtifactConfig): Promise<Response> => {
  const filePath = currentPmtilesPath(config)
  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return Response.json({
      ok: false,
      error: 'vector map artifact unavailable',
      expectedPath: filePath,
    }, { status: 503 })
  }

  const info = await stat(filePath)
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': pmtilesContentType,
    'Cache-Control': 'public, max-age=3600',
  })
  const range = parseRange(req.headers.get('range'), info.size)
  if (!range) {
    headers.set('Content-Length', String(info.size))
    return new Response(file, { headers })
  }

  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
  headers.set('Content-Length', String(range.end - range.start + 1))
  return new Response(file.slice(range.start, range.end + 1), { status: 206, headers })
}

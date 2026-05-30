import { lstat, readlink, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { createBaseTileset, findReferenceTilesets, loadMapCapabilityManifest, referenceRootFromEnv } from './capabilities.ts'
import { createLeitbildMapStyle, type MapTheme } from './style.ts'

export interface MapArtifactConfig {
  readonly rootDir: string
}

export interface ReferenceDatasetArtifactConfig {
  readonly referenceRoot: string
}

export interface MapArtifactFileStatus {
  readonly available: boolean
  readonly path: string
  readonly sizeBytes?: number
  readonly modifiedAt?: string
  readonly error?: string
}

export interface MapArtifactStatus {
  readonly status: 'ready' | 'unavailable'
  readonly rootDir: string
  readonly activeBuildId: string | null
  readonly activeBuildError?: string
  readonly capabilities: {
    readonly schemaVersion: number
    readonly tilesetId: string
    readonly styleUrl: string
    readonly tileUrl: string
  }
  readonly currentPmtiles: MapArtifactFileStatus
  readonly glyphProbe: MapArtifactFileStatus & {
    readonly fontStack: string
    readonly range: string
  }
}

const pmtilesContentType = 'application/vnd.pmtiles'
const glyphContentType = 'application/x-protobuf'
const glyphProbeFontStack = 'Noto Sans Regular'
const glyphProbeRange = '0-255'
const mapFontPathPrefix = '/map/fonts/'
const mapDatasetPathPrefix = '/map/datasets/'
const datasetIdPattern = /^[a-z0-9][a-z0-9-]*$/
const pmtilesFilePattern = /^[a-z0-9][a-z0-9-]*\.pmtiles$/

export const createMapArtifactConfigFromEnv = (): MapArtifactConfig => ({
  rootDir: resolve(process.env.LEITBILD_MAP_ROOT ?? '/opt/leitbild/maps'),
})

export const currentPmtilesPath = (config: MapArtifactConfig): string =>
  resolve(config.rootDir, 'current', 'norway.pmtiles')

const glyphProbePath = (config: MapArtifactConfig): string =>
  resolve(config.rootDir, 'fonts', glyphProbeFontStack, `${glyphProbeRange}.pbf`)

const isWithin = (rootPath: string, candidatePath: string): boolean => {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

export const mapCapabilitiesResponse = async (): Promise<Response> => {
  const manifest = await loadMapCapabilityManifest({ referenceRoot: referenceRootFromEnv() })
  return Response.json(manifest)
}

export const mapStyleResponse = (theme: string | null = null): Response => {
  if (theme !== null && theme !== 'light' && theme !== 'dark') {
    return Response.json({ ok: false, error: 'invalid map theme' }, { status: 400 })
  }
  return Response.json(createLeitbildMapStyle((theme ?? 'light') as MapTheme))
}

const fileStatus = async (path: string): Promise<MapArtifactFileStatus> => {
  try {
    const info = await stat(path)
    return {
      available: info.isFile() && info.size > 0,
      path,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
  } catch (error) {
    return {
      available: false,
      path,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const activeBuild = async (config: MapArtifactConfig): Promise<{
  readonly id: string | null
  readonly error?: string
}> => {
  const currentPath = resolve(config.rootDir, 'current')
  try {
    const info = await lstat(currentPath)
    if (!info.isSymbolicLink()) return { id: null }
    const target = await readlink(currentPath)
    return { id: basename(resolve(config.rootDir, target)) }
  } catch (error) {
    return {
      id: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const createMapArtifactStatus = async (config: MapArtifactConfig): Promise<MapArtifactStatus> => {
  const base = createBaseTileset()
  const currentPmtiles = await fileStatus(currentPmtilesPath(config))
  const glyphProbe = await fileStatus(glyphProbePath(config))
  const active = await activeBuild(config)
  return {
    status: currentPmtiles.available && glyphProbe.available ? 'ready' : 'unavailable',
    rootDir: config.rootDir,
    activeBuildId: active.id,
    ...(active.error ? { activeBuildError: active.error } : {}),
    capabilities: {
      schemaVersion: 2,
      tilesetId: base.id,
      styleUrl: base.artifact.styleUrl,
      tileUrl: base.artifact.currentTileUrl,
    },
    currentPmtiles,
    glyphProbe: {
      ...glyphProbe,
      fontStack: glyphProbeFontStack,
      range: glyphProbeRange,
    },
  }
}

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

const pmtilesFileResponse = async (
  req: Request,
  filePath: string,
  missing: { readonly error: string; readonly status: number },
): Promise<Response> => {
  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return Response.json({
      ok: false,
      error: missing.error,
      expectedPath: filePath,
    }, { status: missing.status })
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

export const currentPmtilesResponse = async (req: Request, config: MapArtifactConfig): Promise<Response> =>
  pmtilesFileResponse(req, currentPmtilesPath(config), {
    error: 'vector map artifact unavailable',
    status: 503,
  })

export const referenceDatasetPmtilesResponse = async (
  req: Request,
  url: URL,
  config: ReferenceDatasetArtifactConfig = { referenceRoot: referenceRootFromEnv() },
): Promise<Response | null> => {
  if (!url.pathname.startsWith(mapDatasetPathPrefix)) return null

  const encodedPath = url.pathname.slice(mapDatasetPathPrefix.length)
  const parts = encodedPath.split('/').map(part => decodeURIComponent(part))
  if (parts.length !== 3 || parts[1] !== 'current') {
    return Response.json({ ok: false, error: 'invalid reference dataset path' }, { status: 400 })
  }

  const [datasetId, , fileName] = parts
  if (!datasetId || !fileName || !datasetIdPattern.test(datasetId) || !pmtilesFilePattern.test(fileName)) {
    return Response.json({ ok: false, error: 'invalid reference dataset path' }, { status: 400 })
  }

  const manifest = await loadMapCapabilityManifest({ referenceRoot: config.referenceRoot })
  const tileset = findReferenceTilesets(manifest).find(candidate => candidate.datasetId === datasetId)
  if (!tileset || tileset.artifact.pmtilesPath !== fileName) {
    return Response.json({ ok: false, error: 'reference dataset not found' }, { status: 404 })
  }

  const referenceRootRealPath = await realpath(config.referenceRoot)
  const currentDir = resolve(config.referenceRoot, 'releases', datasetId, 'current')
  const currentDirRealPath = await realpath(currentDir)
  if (!isWithin(referenceRootRealPath, currentDirRealPath)) {
    return Response.json({ ok: false, error: 'invalid reference dataset release path' }, { status: 503 })
  }

  const filePath = resolve(currentDirRealPath, fileName)
  if (!isWithin(currentDirRealPath, filePath)) {
    return Response.json({ ok: false, error: 'invalid reference dataset path' }, { status: 400 })
  }

  return pmtilesFileResponse(req, filePath, {
    error: 'reference dataset artifact unavailable',
    status: 503,
  })
}

export const mapGlyphResponse = async (url: URL, config: MapArtifactConfig): Promise<Response | null> => {
  if (!url.pathname.startsWith(mapFontPathPrefix)) return null

  const encodedPath = url.pathname.slice(mapFontPathPrefix.length)
  const separatorIndex = encodedPath.lastIndexOf('/')
  if (separatorIndex <= 0 || separatorIndex === encodedPath.length - 1) {
    return Response.json({ ok: false, error: 'invalid map glyph path' }, { status: 400 })
  }

  const fontStack = decodeURIComponent(encodedPath.slice(0, separatorIndex))
  const rangeFile = decodeURIComponent(encodedPath.slice(separatorIndex + 1))
  if (!/^\d+-\d+\.pbf$/.test(rangeFile)) {
    return Response.json({ ok: false, error: 'invalid map glyph range' }, { status: 400 })
  }

  const fontsRoot = resolve(config.rootDir, 'fonts')
  const filePath = resolve(fontsRoot, fontStack, rangeFile)
  if (!isWithin(fontsRoot, filePath)) {
    return Response.json({ ok: false, error: 'invalid map glyph path' }, { status: 400 })
  }

  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return Response.json({
      ok: false,
      error: 'map glyph unavailable',
      expectedPath: filePath,
    }, { status: 404 })
  }

  return new Response(file, {
    headers: {
      'Content-Type': glyphContentType,
      'Cache-Control': 'public, max-age=86400',
    },
  })
}

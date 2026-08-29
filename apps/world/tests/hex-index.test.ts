import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { geoPointFromLonLat, type GeoJsonPolygon } from '../src/core/model/index.ts'
import {
  hexCellAtPoint,
  hexCellBoundary,
  hexCellCenter,
  hexCellResolution,
  hexCellsForPolygon,
  hexNeighborCells,
  hexParentCell,
  hexResolution,
} from '../src/core/spatial/index.ts'

const osloViewport: GeoJsonPolygon = {
  type: 'Polygon',
  coordinates: [[
    geoPointFromLonLat(10.62, 59.88).coordinates,
    geoPointFromLonLat(10.88, 59.88).coordinates,
    geoPointFromLonLat(10.88, 59.98).coordinates,
    geoPointFromLonLat(10.62, 59.98).coordinates,
    geoPointFromLonLat(10.62, 59.88).coordinates,
  ]],
}

describe('H3 hex index wrapper', () => {
  test('returns stable global cells for known points', () => {
    const oslo = hexCellAtPoint(geoPointFromLonLat(10.7522, 59.9139), hexResolution(8))
    const halden = hexCellAtPoint(geoPointFromLonLat(11.3870, 59.1248), hexResolution(8))

    expect(String(oslo)).toBe('8809993867fffff')
    expect(String(halden)).toBe('88099b0041fffff')
    expect(Number(hexCellResolution(oslo))).toBe(8)
  })

  test('covers viewport polygons at explicit resolution', () => {
    const cells = hexCellsForPolygon(osloViewport, hexResolution(8))

    expect(cells.length).toBeGreaterThan(250)
    expect(cells.length).toBeLessThan(400)
    expect(new Set(cells).size).toBe(cells.length)
  })

  test('returns GeoJSON boundaries and parent/neighbor relationships', () => {
    const cell = hexCellAtPoint(geoPointFromLonLat(10.7522, 59.9139), hexResolution(8))
    const boundary = hexCellBoundary(cell)
    const center = hexCellCenter(cell)

    expect(boundary.type).toBe('Polygon')
    expect(boundary.coordinates[0]?.length).toBeGreaterThanOrEqual(7)
    expect(center.coordinates[0]).toBeGreaterThan(10.7)
    expect(Number(hexCellResolution(hexParentCell(cell, hexResolution(7))))).toBe(7)
    expect(hexNeighborCells(cell, 1).length).toBe(7)
  })

  test('keeps the h3-js dependency behind the core spatial wrapper', () => {
    const root = process.cwd()
    const sourceFiles = (directory: string): string[] =>
      readdirSync(directory).flatMap(entry => {
        const path = join(directory, entry)
        if (path.includes('/src/ui/dist/')) return []
        const stats = statSync(path)
        if (stats.isDirectory()) return sourceFiles(path)
        return path.endsWith('.ts') || path.endsWith('.svelte') ? [path] : []
      })
    const offenders = sourceFiles(join(root, 'src'))
      .filter(path => readFileSync(path, 'utf8').includes('h3-js'))
      .map(path => relative(root, path))

    expect(offenders).toEqual(['src/core/spatial/hex-index.ts'])
  })
})

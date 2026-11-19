import type { MapCover } from '../../../ui/surface-panel-contract.ts'
import { noMapCover } from '../../../ui/surface-panel-interaction.ts'

/**
 * Where the Dispatch panel lies over the map, and what it hands the World
 * surface to draw on the map.
 *
 * - From 1024 px the panel is docked to the surface's right edge: up to
 *   360 px wide from 1280 px, up to 320 px below that, and never so wide
 *   that less than `minMapWidthPx` of map stays clear beside it.
 * - Below 1024 px (tablet portrait, phones) it is a bottom sheet. It starts
 *   folded to an edge tab ("Calls 3 · 7 free", with the receipt line); a
 *   click on an Einsatz object, or on the tab, opens the sheet. Open, it
 *   takes a fixed share of the height. Selecting a unit gives the map more
 *   room, while the unit card can still scroll inside the smaller sheet.
 *
 * The panel reports how far it reaches over the map (`MapCover`) from its
 * observed size, so the map camera centres and fits in the part left clear,
 * and a row click pans the map only when the object lies out of that part.
 */

// ——— Layout ———

/** The surface width from which the panel docks beside the map; below it, it is a bottom sheet. */
export const dockedFromPx = 1024
/** The surface width from which the docked panel takes its full width. */
export const wideFromPx = 1280
export const widePanelPx = 360
export const narrowPanelPx = 320
export const minPanelWidthPx = 300
export const minMapWidthPx = 400
/** The gap between the panel and the surface's edges. */
export const panelEdgeGapPx = 12
/**
 * The docked panel's clearance from the surface's top and bottom edges: room
 * for the role bar above it and the World status line below it, both drawn
 * over the map.
 */
export const panelTopClearancePx = 52
export const panelBottomClearancePx = 52
/** The share of the surface's height the open bottom sheet takes. */
export const sheetShare = 0.6
const selectedUnitSheetShare = 0.45
const selectedUnitSheetMaxHeightPx = 300
export type PanelLayout =
  | { readonly mode: 'docked'; readonly widthPx: number; readonly mapWidthPx: number }
  | { readonly mode: 'sheet'; readonly heightPx: number }

/** The panel's layout on a surface of this size. */
export const panelLayoutFor = (surfaceWidthPx: number, surfaceHeightPx: number, unitSelected = false): PanelLayout => {
  if (!Number.isFinite(surfaceWidthPx) || surfaceWidthPx < 0) throw new Error(`The World surface is no width: ${surfaceWidthPx}`)
  if (!Number.isFinite(surfaceHeightPx) || surfaceHeightPx < 0) throw new Error(`The World surface is no height: ${surfaceHeightPx}`)
  if (surfaceWidthPx < dockedFromPx) {
    const heightPx = unitSelected
      ? Math.min(selectedUnitSheetMaxHeightPx, Math.floor(surfaceHeightPx * selectedUnitSheetShare))
      : Math.floor(surfaceHeightPx * sheetShare)
    return { mode: 'sheet', heightPx }
  }
  const preferred = surfaceWidthPx >= wideFromPx ? widePanelPx : narrowPanelPx
  const widthPx = Math.max(minPanelWidthPx, Math.min(preferred, surfaceWidthPx - panelEdgeGapPx - minMapWidthPx))
  return { mode: 'docked', widthPx, mapWidthPx: surfaceWidthPx - panelEdgeGapPx - widthPx }
}

/** Whether the bottom sheet shows open: the operator opened it, or something is selected. Folded, only the edge tab shows. */
export const sheetOpen = (openedByOperator: boolean, somethingSelected: boolean): boolean => openedByOperator || somethingSelected

/** How far the panel, observed at this size, reaches over the map: the docked panel from the right edge, the open sheet from the bottom, the folded tab nothing. */
export const dispatchMapCover = (layout: PanelLayout, observed: { readonly width: number; readonly height: number }, open: boolean): MapCover => {
  if (layout.mode === 'docked') return { ...noMapCover, right: observed.width > 0 ? Math.ceil(observed.width) + panelEdgeGapPx : 0 }
  return open && observed.height > 0 ? { ...noMapCover, bottom: Math.ceil(observed.height) } : noMapCover
}

// ——— Row clicks pan only when the object is out of view ———

/** How far from the clear part's edges an object must lie to be seen whole: its icon and label. */
export const revealMarginPx = 32

export interface ScreenSize {
  readonly width: number
  readonly height: number
}

/** The camera a point is placed by, as the map reports it. */
export interface CameraView {
  readonly center: readonly [number, number]
  readonly zoom: number
  readonly bearing: number
}

const worldPx = (zoom: number): number => 512 * 2 ** zoom
const worldPoint = (point: readonly [number, number], zoom: number): { readonly x: number; readonly y: number } => {
  const size = worldPx(zoom)
  const latitude = Math.max(-85.0511, Math.min(85.0511, point[1]))
  const mercator = Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360))
  return { x: (point[0] + 180) / 360 * size, y: (1 - mercator / Math.PI) / 2 * size }
}

/** A point's place on a map of this size whose camera is padded by `padding`, in px from its top left (Web Mercator, MapLibre's 512 px tile). */
export const screenPointOf = (camera: CameraView, size: ScreenSize, padding: MapCover, point: readonly [number, number]): { readonly x: number; readonly y: number } => {
  const world = worldPx(camera.zoom)
  const centre = worldPoint(camera.center, camera.zoom)
  const at = worldPoint(point, camera.zoom)
  const dx = ((at.x - centre.x) % world + world * 1.5) % world - world / 2
  const dy = at.y - centre.y
  const angle = -camera.bearing * Math.PI / 180
  return {
    x: padding.left + (size.width - padding.left - padding.right) / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: padding.top + (size.height - padding.top - padding.bottom) / 2 + dx * Math.sin(angle) + dy * Math.cos(angle),
  }
}

/** Whether the map shows a point whole in the part the panel and the bars leave clear. A row click on an object not shown so pans to it; it never zooms. */
export const shownClearOfPanel = (camera: CameraView, size: ScreenSize, cover: MapCover, point: readonly [number, number]): boolean => {
  if (size.width <= 0 || size.height <= 0) throw new Error(`The map has no size: ${size.width} × ${size.height}`)
  const at = screenPointOf(camera, size, cover, point)
  return at.x >= cover.left + revealMarginPx
    && at.x <= size.width - cover.right - revealMarginPx
    && at.y >= Math.max(cover.top, panelTopClearancePx) + revealMarginPx
    && at.y <= size.height - Math.max(cover.bottom, panelBottomClearancePx) - revealMarginPx
}

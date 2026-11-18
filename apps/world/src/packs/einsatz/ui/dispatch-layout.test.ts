import { describe, expect, test } from 'bun:test'
import { noMapCover } from '../../../ui/surface-panel-interaction.ts'
import {
  dispatchMapCover,
  minMapWidthPx,
  narrowPanelPx,
  panelEdgeGapPx,
  panelLayoutFor,
  screenPointOf,
  sheetOpen,
  shownClearOfPanel,
  widePanelPx,
} from './dispatch-layout.ts'

describe('Dispatch panel layout', () => {
  test('docks narrowly on desktop and opens a sheet below 1024 px', () => {
    expect(panelLayoutFor(1366, 900)).toEqual({ mode: 'docked', widthPx: widePanelPx, mapWidthPx: 1366 - panelEdgeGapPx - widePanelPx })
    expect(panelLayoutFor(1280, 900)).toMatchObject({ mode: 'docked', widthPx: 360 })
    expect(panelLayoutFor(1024, 768)).toMatchObject({ mode: 'docked', widthPx: 320 })
    expect(panelLayoutFor(1279, 768)).toMatchObject({ mode: 'docked', widthPx: narrowPanelPx })
    expect(panelLayoutFor(768, 1024)).toEqual({ mode: 'sheet', heightPx: 614 })
    expect(panelLayoutFor(375, 812).mode).toBe('sheet')
    expect(() => panelLayoutFor(-1, 10)).toThrow('no width')
  })

  test('a selected unit leaves more map visible above the sheet', () => {
    expect(panelLayoutFor(768, 1024, true)).toEqual({ mode: 'sheet', heightPx: 300 })
    expect(panelLayoutFor(844, 390, true)).toEqual({ mode: 'sheet', heightPx: 175 })
    expect(panelLayoutFor(1024, 768, true)).toEqual(panelLayoutFor(1024, 768))
  })

  test('the docked panel leaves at least 400 px of map whenever the surface allows', () => {
    for (const width of [1024, 1100, 1280, 1300, 1920]) {
      const layout = panelLayoutFor(width, 800)
      if (layout.mode !== 'docked') throw new Error('docked expected')
      expect(layout.mapWidthPx).toBeGreaterThanOrEqual(minMapWidthPx)
    }
  })

  test('the sheet opens with a selection or a tap on its tab', () => {
    expect([sheetOpen(false, false), sheetOpen(true, false), sheetOpen(false, true)]).toEqual([false, true, true])
  })

  test('the map cover: the docked panel from the right, the open sheet from the bottom, the folded tab none', () => {
    expect(dispatchMapCover(panelLayoutFor(1366, 900), { width: 360, height: 700 }, true)).toEqual({ ...noMapCover, right: 360 + panelEdgeGapPx })
    expect(dispatchMapCover(panelLayoutFor(768, 1024), { width: 768, height: 400.4 }, true)).toEqual({ ...noMapCover, bottom: 401 })
    expect(dispatchMapCover(panelLayoutFor(768, 1024), { width: 200, height: 44 }, false)).toEqual(noMapCover)
  })

  test('a row click pans only when the object lies under the panel, the bars or off the map', () => {
    const camera = { center: [11.4, 59.1] as const, zoom: 12, bearing: 0 }
    const size = { width: 1366, height: 900 }
    const cover = { ...noMapCover, right: widePanelPx + panelEdgeGapPx }
    const centre = screenPointOf(camera, size, cover, [11.4, 59.1])
    expect(centre.x).toBeCloseTo((1366 - cover.right) / 2, 5)
    expect(shownClearOfPanel(camera, size, cover, [11.4, 59.1])).toBe(true)
    expect(shownClearOfPanel(camera, size, cover, [11.56, 59.1])).toBe(false)
    expect(shownClearOfPanel(camera, size, cover, [11.4, 59.3])).toBe(false)
    expect(() => shownClearOfPanel(camera, { width: 0, height: 10 }, cover, [11.4, 59.1])).toThrow('no size')
  })
})

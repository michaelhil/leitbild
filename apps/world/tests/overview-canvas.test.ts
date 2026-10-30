import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { VignetteView } from '../src/features/displays/compose/model.ts'
import { adviceExtent } from '../src/ui/embed/display-extent.ts'
import { COLUMN_PX, BESIDE_GAP_PX, drawnScale, flowFrameWidth, frameLayout, VIGNETTE_INSET_PX, VIGNETTE_ROW_PX } from '../src/ui/embed/vignette/grid.ts'
import { displayFrameGeometry } from '../src/ui/process-display/display-zoom.ts'
import { openBridgeCssPath, paletteTokens, parseColour, resolveToken } from '../scripts/displays/reserved-colour-distance.ts'

const overview = (width: number, height: number): VignetteView => ({
  title: 'A plant overview', beside: true, sections: [{
    kind: 'topology', rows: 37, objectId: 'plant:a', packId: 'process-plant', family: 'flow',
    layout: { family: 'flow', unit: 'grid', width, height, crossings: 0, hash: 'test', nodes: [], edges: [] }, nodes: [], edges: [],
  }],
})

test('every overview canvas follows its topology and side column at each manual zoom, without viewport filler', () => {
  for (const width of [23, 62, 107.5]) for (const zoom of [0.5, 0.67, 0.917, 1, 1.5]) {
    const view = overview(width, 38)
    const section = view.sections[0]!
    if (section.kind !== 'topology') throw Error('Expected topology')
    const canvas = flowFrameWidth(view, zoom)!
    const scale = drawnScale(section, zoom)
    expect(canvas).toBe(Math.ceil(width * VIGNETTE_ROW_PX * scale + COLUMN_PX + BESIDE_GAP_PX + 2 * VIGNETTE_INSET_PX))
    expect(frameLayout({ width: canvas - 2 * VIGNETTE_INSET_PX, drawingWidth: width * VIGNETTE_ROW_PX * scale, drawn: scale, zoom })).toEqual({ kind: 'beside' })
    // The complete useful canvas determines the minimum frame; a very wide
    // iframe cannot spread the title, CSFs or footer beyond that canvas.
    const extent = adviceExtent({ width: canvas, height: 1000, widestDrawing: canvas - 2 * VIGNETTE_INSET_PX, padding: 2 * VIGNETTE_INSET_PX })
    const frame = displayFrameGeometry({ kind: 'advice', zoom, body: { width: 1300, height: 900 }, extent, envelopeHeight: 800 })
    expect(frame.frameWidth).toBeGreaterThanOrEqual(canvas)
    expect(extent.minWidth).toBe(Math.ceil(canvas))
  }
  const stacked = overview(62, 38)
  expect(flowFrameWidth({ title: stacked.title, sections: stacked.sections }, 0.67)).toBeNull()
  expect(flowFrameWidth({ title: 'Values only', sections: [] }, 0.67)).toBeNull()
})

test('exposed display-window background exactly matches the isolated OpenBridge day/dusk canvas', () => {
  const host = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8')
  const css = readFileSync(openBridgeCssPath, 'utf8')
  const backgrounds = [...host.matchAll(/--display-canvas-background:\s*([^;]+);/g)].map(match => parseColour(match[1]!))
  expect(backgrounds).toEqual(['day', 'dusk'].map(palette => parseColour(resolveToken(paletteTokens(css, palette as 'day' | 'dusk'), '--container-background-color'))))
})

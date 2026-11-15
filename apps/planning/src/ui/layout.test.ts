// Nothing on the plan screen overlaps at 375, 1024, 1280, 1440 or 1600 px (maint's walk T1-05, T1-06,
// T7-01, T7-03: the explanations and the glance were hidden under the next column). A geometry helper
// reads the screen grid from App.svelte's own CSS at each width and lays out the three columns; the
// overlap's cause, a column track sized by unbreakable text, is checked as CSS guards.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = /<style>([\s\S]*)<\/style>/.exec(readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8'))?.[1] ?? ''

interface Rule { readonly selectors: readonly string[]; readonly declarations: ReadonlyMap<string, string>; readonly maxWidth: number | null }

/** The rules of a stylesheet with one level of @media (max-width) nesting. */
const rulesOf = (text: string): readonly Rule[] => {
  const rules: Rule[] = []
  const walk = (body: string, maxWidth: number | null): void => {
    let at = 0
    while (at < body.length) {
      const open = body.indexOf('{', at)
      if (open === -1) return
      const head = body.slice(at, open).replace(/\/\*[\s\S]*?\*\//g, '').trim()
      let depth = 1, close = open + 1
      for (; close < body.length && depth > 0; close += 1) depth += body[close] === '{' ? 1 : body[close] === '}' ? -1 : 0
      const inner = body.slice(open + 1, close - 1)
      const media = /^@media\s*\(max-width:\s*(\d+)px\)$/.exec(head)
      if (media) walk(inner, Number(media[1]))
      else if (head === ':global' || head.startsWith('@')) walk(inner, maxWidth)
      else {
        const declarations = new Map(inner.split(';').map(part => part.split(':')).filter(pair => pair.length >= 2).map(([name, ...value]) => [name!.trim(), value.join(':').trim()]))
        rules.push({ selectors: head.split(',').map(selector => selector.trim()), declarations, maxWidth })
      }
      at = close
    }
  }
  walk(text, null)
  return rules
}
const rules = rulesOf(css)

/** The value a selector's property has at a viewport width: later and matching media rules win. */
const valueAt = (selector: string, property: string, width: number): string | undefined => {
  let value: string | undefined
  for (const rule of rules) {
    if (!rule.selectors.includes(selector) || (rule.maxWidth !== null && width > rule.maxWidth)) continue
    value = rule.declarations.get(property) ?? value
  }
  return value
}
const px = (value: string | undefined): number => Number(/^(\d+)px/.exec(value ?? '')?.[1] ?? 0)

interface Box { readonly name: string; readonly rows: readonly number[]; readonly left: number; readonly right: number }

/**
 * Lays out the screen grid at a viewport width from its own CSS: fixed px and minmax(0, 1fr) tracks, and
 * the named areas (attention, views, main, panel) that place the columns and the row of view tabs.
 */
const layout = (width: number): { readonly boxes: readonly Box[]; readonly tracks: readonly number[]; readonly available: number } => {
  const padding = px(valueAt('.plan-screen', 'padding', width)?.split(' ')[1] ?? valueAt('.plan-screen', 'padding', width))
  const gaps = (valueAt('.screen-grid', 'gap', width) ?? '').split(' ')
  const gap = px(gaps[1] ?? gaps[0])
  const available = width - 2 * padding
  const template = (valueAt('.screen-grid', 'grid-template-columns', width) ?? '').match(/minmax\(0, 1fr\)|\d+px/g) ?? []
  const fixed = template.filter(track => track.endsWith('px')).reduce((sum, track) => sum + px(track), 0)
  const flexible = template.filter(track => track.startsWith('minmax')).length
  const share = (available - fixed - gap * (template.length - 1)) / Math.max(1, flexible)
  const tracks = template.map(track => track.startsWith('minmax') ? share : px(track))
  const starts = tracks.map((_, index) => tracks.slice(0, index).reduce((sum, size) => sum + size + gap, 0))
  const areas = [...(valueAt('.screen-grid', 'grid-template-areas', width) ?? '').matchAll(/"([^"]+)"/g)].map(match => match[1]!.split(/\s+/))
  const names = [...new Set(areas.flat())]
  const boxes = names.map((name): Box => {
    const rows = areas.flatMap((row, index) => row.includes(name) ? [index] : [])
    const columns = areas[rows[0]!]!.flatMap((cell, index) => cell === name ? [index] : [])
    const first = columns[0]!, last = columns[columns.length - 1]!
    return { name, rows, left: starts[first]!, right: starts[last]! + tracks[last]! }
  })
  return { boxes, tracks, available }
}
const boxOf = (width: number, name: string): Box => layout(width).boxes.find(box => box.name === name)!

describe('the plan screen lays out without overlap', () => {
  test('each area of the grid is the area its column or tab row is placed in', () => {
    for (const [selector, area] of [['.col-attention', 'attention'], ['.views', 'views'], ['.col-main', 'main'], ['.col-panel', 'panel']] as const) {
      expect({ selector, area: valueAt(selector, 'grid-area', 1600) }).toEqual({ selector, area })
    }
  })

  for (const width of [375, 1024, 1280, 1440, 1600]) {
    test(`at ${width} px the columns fit the screen and no two share space`, () => {
      const { boxes, tracks, available } = layout(width)
      expect(boxes.map(box => box.name).sort()).toEqual(['attention', 'main', 'panel', 'views'])
      for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.right).toBeLessThanOrEqual(available + 0.5)
      }
      for (const [index, one] of boxes.entries()) {
        for (const other of boxes.slice(index + 1)) {
          const sameRow = one.rows.some(row => other.rows.includes(row))
          if (sameRow) expect({ pair: `${one.name} ${other.name}`, apart: one.right <= other.left || other.right <= one.left }).toEqual({ pair: `${one.name} ${other.name}`, apart: true })
        }
      }
      // The main column keeps room for the work list and the timeline's scroll box.
      expect(Math.max(...tracks)).toBeGreaterThanOrEqual(width < 760 ? 300 : 500)
    })
  }

  test('from 1280 px the detail column is beside the work; below it, it stacks under the other two (demo layout pass, item 1)', () => {
    for (const width of [1280, 1440, 1600]) {
      const main = boxOf(width, 'main'), panel = boxOf(width, 'panel'), attention = boxOf(width, 'attention')
      expect({ width, beside: panel.rows.some(row => main.rows.includes(row)) && panel.left >= main.right, order: attention.right <= main.left }).toEqual({ width, beside: true, order: true })
      // About 300 px of attention and 360 to 400 px of detail; the work has the rest.
      expect(attention.right - attention.left).toBe(300)
      expect(panel.right - panel.left).toBeGreaterThanOrEqual(360)
      expect(panel.right - panel.left).toBeLessThanOrEqual(400)
      expect(main.right - main.left).toBeGreaterThan(panel.right - panel.left)
    }
    for (const width of [375, 1024, 1279]) {
      const main = boxOf(width, 'main'), panel = boxOf(width, 'panel')
      expect({ width, below: Math.min(...panel.rows) > Math.max(...main.rows), full: panel.left === 0 && Math.round(panel.right) === Math.round(layout(width).available) }).toEqual({ width, below: true, full: true })
    }
  })

  test('the view tabs are one row above the work, and take the width of everything right of the attention column', () => {
    for (const width of [1024, 1280, 1440, 1600]) {
      const views = boxOf(width, 'views'), main = boxOf(width, 'main')
      expect({ width, above: Math.max(...views.rows) < Math.min(...main.rows), from: views.left === main.left, to: Math.round(views.right) === Math.round(layout(width).available) }).toEqual({ width, above: true, from: true, to: true })
    }
    // From 1280 px the row spans the work and the detail column (at least 900 px) and never wraps.
    for (const width of [1280, 1440, 1600]) {
      expect(valueAt('.views', 'flex-wrap', width)).toBe('nowrap')
      expect(boxOf(width, 'views').right - boxOf(width, 'views').left).toBeGreaterThanOrEqual(900)
    }
    // Below that the tabs wrap, so each stays in sight without a sideways scroll.
    for (const width of [375, 1024, 1279]) expect(valueAt('.views', 'flex-wrap', width)).toBe('wrap')
  })

  test('a column never grows past its track: each is one shrinkable track and its cards wrap long text', () => {
    for (const column of ['.col-attention', '.col-main', '.col-panel', '.desktop-only']) {
      expect({ column, track: valueAt(column, 'grid-template-columns', 1600), min: valueAt(column, 'min-width', 1600) }).toEqual({ column, track: 'minmax(0, 1fr)', min: '0' })
    }
    for (const card of ['.attention', '.glance', '.work-list', '.options', '.rules', '.crews', '.picker', '.authoring', '.job-panel', '.preview', '.shift-list', '.shown-option', '.timeline', '.options-glance', '.finish-panel']) {
      expect({ card, wrap: valueAt(card, 'overflow-wrap', 1600), min: valueAt(card, 'min-width', 1600) }).toEqual({ card, wrap: 'anywhere', min: '0' })
    }
    // Only the timeline scrolls sideways; it scrolls inside its own card.
    expect(valueAt('.timeline', 'overflow-x', 1600)).toBe('auto')
  })
})

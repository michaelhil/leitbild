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

interface Box { readonly name: string; readonly row: number; readonly left: number; readonly right: number }

/** Lays out the screen grid's columns at a viewport width, as CSS grid would with fixed px and minmax(0, 1fr) tracks. */
const layout = (width: number): { readonly boxes: readonly Box[]; readonly tracks: readonly number[]; readonly available: number } => {
  const padding = px(valueAt('.plan-screen', 'padding', width)?.split(' ')[1] ?? valueAt('.plan-screen', 'padding', width))
  const gap = px(valueAt('.screen-grid', 'gap', width))
  const available = width - 2 * padding
  const template = (valueAt('.screen-grid', 'grid-template-columns', width) ?? '').match(/minmax\(0, 1fr\)|\d+px/g) ?? []
  const fixed = template.filter(track => track.endsWith('px')).reduce((sum, track) => sum + px(track), 0)
  const flexible = template.filter(track => track.startsWith('minmax')).length
  const share = (available - fixed - gap * (template.length - 1)) / Math.max(1, flexible)
  const tracks = template.map(track => track.startsWith('minmax') ? share : px(track))
  const starts = tracks.map((_, index) => tracks.slice(0, index).reduce((sum, size) => sum + size + gap, 0))
  const boxes: Box[] = []
  let row = 0, column = 0
  for (const name of ['.col-attention', '.col-main', '.col-panel']) {
    const spansAll = valueAt(name, 'grid-column', width) === '1 / -1'
    if (spansAll || column >= tracks.length) { row += column === 0 ? 0 : 1; column = 0 }
    const last = spansAll ? tracks.length - 1 : column
    boxes.push({ name, row, left: starts[column]!, right: starts[last]! + tracks[last]! })
    column = spansAll ? tracks.length : column + 1
  }
  return { boxes, tracks, available }
}

describe('the plan screen lays out without overlap', () => {
  for (const width of [375, 1024, 1280, 1440, 1600]) {
    test(`at ${width} px the columns fit the screen and no two share space`, () => {
      const { boxes, tracks, available } = layout(width)
      for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.right).toBeLessThanOrEqual(available + 0.5)
      }
      for (const [index, one] of boxes.entries()) {
        for (const other of boxes.slice(index + 1)) {
          if (one.row === other.row) expect({ pair: `${one.name} ${other.name}`, apart: one.right <= other.left || other.right <= one.left }).toEqual({ pair: `${one.name} ${other.name}`, apart: true })
        }
      }
      // The main column keeps room for the work list and the timeline's scroll box.
      expect(Math.max(...tracks)).toBeGreaterThanOrEqual(width < 760 ? 300 : 500)
    })
  }

  test('a column never grows past its track: each is one shrinkable track and its cards wrap long text', () => {
    for (const column of ['.col-attention', '.col-main', '.col-panel', '.desktop-only']) {
      expect({ column, track: valueAt(column, 'grid-template-columns', 1600), min: valueAt(column, 'min-width', 1600) }).toEqual({ column, track: 'minmax(0, 1fr)', min: '0' })
    }
    for (const card of ['.attention', '.glance', '.work-list', '.options', '.rules', '.crews', '.picker', '.authoring', '.job-panel', '.preview', '.shift-list', '.shown-option', '.timeline']) {
      expect({ card, wrap: valueAt(card, 'overflow-wrap', 1600), min: valueAt(card, 'min-width', 1600) }).toEqual({ card, wrap: 'anywhere', min: '0' })
    }
    // Only the timeline scrolls sideways; it scrolls inside its own card.
    expect(valueAt('.timeline', 'overflow-x', 1600)).toBe('auto')
  })
})

// Nothing on the plan screen overlaps at 375, 1024, 1280, 1440 or 1600 px (maint's walk T1-05, T1-06,
// T7-01, T7-03: the explanations and the glance were hidden under the next column). A geometry helper
// reads the screen grid from App.svelte's own CSS at each width and lays out the three columns; the
// overlap's cause, a column track sized by unbreakable text, is checked as CSS guards.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { optionOf, runBasis, status, trainAPlanned } from './fixtures/plans.ts'
import { createTimeFormat } from './format.ts'
import { createNames, sizeCautionMark, type PlanModel } from './model.ts'
import { optionsGlance, type OptionsGlance } from './options-glance.ts'

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
    for (const card of ['.attention', '.glance', '.work-list', '.options', '.rules', '.crews', '.picker', '.authoring', '.job-panel', '.preview', '.shift-list', '.shown-option', '.timeline', '.options-glance', '.finish-panel', '.ladder', '.what-if-panel', '.why-panel', '.compare-panel']) {
      expect({ card, wrap: valueAt(card, 'overflow-wrap', 1600), min: valueAt(card, 'min-width', 1600) }).toEqual({ card, wrap: 'anywhere', min: '0' })
    }
    // Only the timeline scrolls sideways; it scrolls inside its own card.
    expect(valueAt('.timeline', 'overflow-x', 1600)).toBe('auto')
  })
})

// The options table fits its column (maint's walk 7, screenshot 14: at 1280 px the Status chips and the
// caution text were cut off). The table's narrowest possible width is estimated from what cannot wrap in
// it: each value, each goal word and the longest word of each header and option name. Letters are counted
// at 0.58 em each, wider than this typeface sets these strings (the walked screenshots give about 0.5 em),
// so the estimate errs towards "does not fit".
describe('the options table fits its column from 1024 px to 1440 px', () => {
  const em = 0.58
  const wide = (text: string, size: number): number => text.length * size * em
  const words = (text: string): readonly string[] => text.split(/\s+|(?<=-)/).filter(word => word !== '')
  const longestWord = (text: string, size: number): number => Math.max(...words(text).map(word => wide(word, size)))
  const cellPadding = (): number => 2 * px((valueAt('.options-glance th', 'padding', 1440) ?? '').split(' ')[1])
  /** A chip: its shape, a space and its word at 11 px, with the chip's own padding (6 px each side) and border. */
  const chip = (word: string): number => wide(`x ${word}`, 11) + 14
  const needs = (glance: OptionsGlance): number => {
    const option = Math.max(...glance.rows.map(row => Math.max(longestWord(row.label, 13), row.recommended ? chip('Recommended') : 0)))
    const columns = glance.columns.map((column, index) => Math.max(
      longestWord(column, 11),
      ...glance.rows.map(row => { const cell = row.cells?.[index]; return cell == null ? 0 : Math.max(wide(cell.value, 13), cell.mark === null ? 0 : wide(`x ${cell.mark.word}`, 11)) }),
    ))
    // The status row spans the table and wraps; it needs only its widest chip.
    const chips = Math.max(...glance.rows.flatMap(row => [chip(row.mark.word), row.caution === null ? 0 : chip(sizeCautionMark.word)]))
    return Math.max(chips + cellPadding(), [option, ...columns].reduce((sum, column) => sum + column + cellPadding(), 0))
  }
  const room = (width: number): number => {
    const main = boxOf(width, 'main')
    const [, side] = (valueAt('.options-glance', 'padding', width) ?? '').split(' ')
    return main.right - main.left - 2 * px(side) - 2
  }
  /**
   * The flagship's two options as the local stack generated them on 15 Nov (TEST INPUTS: the widest values
   * the demo shows), each carrying the size caution so its chip is counted too.
   */
  const flagship = (): OptionsGlance => {
    const planned = trainAPlanned()
    const run = runBasis(planned.inputs.settings.grid)
    const caution = { kind: 'above-certified-size' as const, text: 'Above the certified size (33 jobs). This plan keeps every hard rule, but it may not be near the best.', about: [] }
    const option = (key: string, label: string, span: number, over: number, cost: number, hours: number) => optionOf(key, label, status({ word: 'validated feasible', run, goals: [
      { word: over === 0 ? 'proven optimal' : 'best found under budget', goal: 0, value: over, unit: 'h', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } },
      { word: 'best found under budget', goal: 1, value: cost, unit: 'NOK' },
      { word: 'best found under budget', goal: 2, value: hours, unit: 'h' },
    ] }), { metrics: [{ id: 'goal:0:COOL-A', value: span, unit: 'h' }], warnings: [caution] })
    const model: PlanModel = { ...planned, options: { ...planned.options!, recommended: 'swap', items: [option('swap', 'Swap in refurbished spare', 49, 0, 472650, 242.5), option('rebuild', 'Rebuild in place', 65, 11, 243200, 322.5)] } }
    return optionsGlance(model, { inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })!
  }

  test('the estimate reads the flagship as the demo shows it', () => {
    const glance = flagship()
    expect(glance.columns).toEqual(['Longest outage', 'Over the 54 h guideline', 'Extra cost', 'Equipment-hours out of service'])
    expect(glance.rows.map(row => row.cells?.map(cell => cell?.value))).toEqual([['49 h of 72 h', '0 h', 'NOK 472,650', '242.5 h'], ['65 h of 72 h', '11 h', 'NOK 243,200', '322.5 h']])
    expect(glance.rows.every(row => row.caution !== null)).toBe(true)
  })

  for (const width of [1024, 1280, 1366, 1440]) {
    test(`at ${width} px the table needs no more than its column gives, so nothing scrolls sideways or is cut off`, () => {
      expect({ width, needs: Math.ceil(needs(flagship())), fits: needs(flagship()) <= room(width) }).toEqual({ width, needs: Math.ceil(needs(flagship())), fits: true })
    })
  }

  test('the tightest width is 1280 px, where the detail column first sits beside the work', () => {
    expect(room(1280)).toBeLessThan(room(1024))
    expect(room(1280)).toBeLessThan(room(1366))
  })

  test('the status and the caution are a row of their own that wraps; only values and goal words stay on one line', () => {
    const source = readFileSync(join(import.meta.dir, 'OptionsGlance.svelte'), 'utf8')
    // No Status column: the chips row spans the whole table.
    expect(source).not.toContain('<th scope="col">Status</th>')
    expect(source).toMatch(/<tr class="chips-row">\s*<td colspan=\{glance\.columns\.length \+ 1\}>/)
    expect(valueAt('.options-glance .chips', 'flex-wrap', 1280)).toBe('wrap')
    expect(valueAt('.options-glance td strong', 'white-space', 1280)).toBe('nowrap')
    expect(valueAt('.options-glance thead th', 'white-space', 1280)).toBeUndefined()
    expect(valueAt('.options-glance .cause', 'white-space', 1280)).toBeUndefined()
  })
})

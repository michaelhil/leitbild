// Every text colour the screen uses, on every background it sits on, meets WCAG 2.1 AA for normal text
// (4.5:1). The colours are read from the tokens in App.svelte, so a changed token is checked again.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8')
const root = /:root\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
const tokens = new Map([...root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map(match => [match[1]!, match[2]!.toLowerCase()]))

const channel = (value: number): number => {
  const share = value / 255
  return share <= 0.03928 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string): number => {
  const [red, green, blue] = [1, 3, 5].map(at => channel(parseInt(hex.slice(at, at + 2), 16))) as [number, number, number]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}
/** The WCAG contrast ratio of two colours. */
const contrast = (one: string, two: string): number => {
  const [light, dark] = [luminance(one), luminance(two)].sort((left, right) => right - left) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}
const token = (name: string): string => {
  const value = tokens.get(name)
  if (value === undefined) throw new Error(`App.svelte has no --${name} token`)
  return value
}

// [text, background], as the screen pairs them.
const pairs: ReadonlyArray<readonly [string, string]> = [
  ...['ink', 'ink-2', 'ink-3', 'accent', 'focus', 'refusal'].flatMap(text => [[text, 'card'], [text, 'paper']] as const),
  ['ink', 'accent-2'], ['ink-2', 'accent-2'], ['ink-3', 'accent-2'], ['refusal', 'accent-2'], ['on-accent', 'accent'], ['on-accent', 'accent-strong'],
  ['rule', 'rule-bg'], ['estimate', 'estimate-bg'], ['unknown', 'unknown-bg'], ['assumption', 'assumption-bg'],
  ['world', 'world-bg'], ['good', 'good-bg'], ['warning', 'warning-bg'], ['refusal', 'refusal-bg'], ['ink-3', 'estimate-bg'], ['ink-2', 'rule-bg'],
  ['load-text', 'load-fill'], ['load-bought-text', 'load-bought-fill'],
]

describe('colour contrast', () => {
  test('the contrast formula matches known values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
  })

  test('every text and background token pair reaches 4.5:1', () => {
    const failing = pairs
      .map(([text, background]) => ({ pair: `--${text} on --${background}`, ratio: Math.round(contrast(token(text), token(background)) * 100) / 100 }))
      .filter(entry => entry.ratio < 4.5)
    expect(failing).toEqual([])
  })

  test('no text colour is written as a literal outside the tokens', () => {
    const styles = /<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? ''
    const literalText = [...styles.replace(/:root\s*\{[^}]*\}/, '').matchAll(/(?:^|[;{\s])color:\s*(#[0-9a-f]{3,6})/gi)].map(match => match[1])
    expect(literalText).toEqual([])
  })
})

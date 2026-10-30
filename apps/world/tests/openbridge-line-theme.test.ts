import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { lineTheme } from '../src/ui/embed/vignette/line-theme.ts'
import { openBridgeCssPath, paletteTokens, resolveToken } from '../scripts/displays/reserved-colour-distance.ts'

const css = readFileSync(openBridgeCssPath, 'utf8')

describe('connector-diagram reads the installed OpenBridge palette', () => {
  for (const palette of ['day', 'dusk', 'night'] as const) {
    test(`flow and no-flow use 2.1 connector tokens in ${palette}, with no implicit day defaults`, () => {
      const tokens = paletteTokens(css, palette)
      const requested: string[] = []
      const theme = lineTheme(name => { requested.push(name); return resolveToken(tokens, name) }, palette)
      expect(theme.pipeFillColor).toBe(resolveToken(tokens, '--automation-connector-on-background-color'))
      expect(theme.pipeOutlineColor).toBe(resolveToken(tokens, '--automation-connector-on-border-color'))
      expect(theme.pipeFillInverted).toBe(resolveToken(tokens, '--automation-connector-no-flow-background-color'))
      expect(theme.pipeOutlineInverted).toBe(resolveToken(tokens, '--automation-connector-no-flow-border-color'))
      expect(theme.genericBackground).toBe(theme.mediumColors!.Teal.background)
      expect(theme.pipeFillColor).not.toBe(theme.pipeFillInverted)
      expect(requested.some(name => name.startsWith('--automation-pipe-'))).toBe(false)
      expect(Object.values(theme).every(value => value !== '')).toBe(true)
    })
  }

  test('a missing token, including a medium token, fails before an incorrect pipe can be drawn', () => {
    const tokens = paletteTokens(css, 'dusk')
    for (const missing of ['--automation-connector-on-background-color', '--base-teal-200']) {
      expect(() => lineTheme(name => name === missing ? '' : resolveToken(tokens, name), 'dusk')).toThrow(`OpenBridge connector token ${missing} is not set`)
    }
  })
})

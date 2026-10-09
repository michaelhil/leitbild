import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createOpenBridgeTextShaper, MIMIC_TEXT_CHARACTERS, TEXT_METRICS_FILE } from '../src/packs/process-plant/displays/mimic/generate-text-metrics.ts'
import { textWidth, unmeasurable, type OpenBridgeTextStyle } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'

// The server reserves OpenBridge text from a checked-in table so it needs
// neither the package nor a shaper at run time. The table must be exactly what
// the installed OpenBridge package generates: its typography read from the
// components' styles, its widths shaped with HarfBuzz from its Noto Sans.
// After an OpenBridge upgrade, regenerate it:
//   bun src/packs/process-plant/displays/mimic/generate-text-metrics.ts

const shaper = await createOpenBridgeTextShaper()

// Labels as mimics set them.
const samples: Readonly<Record<OpenBridgeTextStyle, ReadonlyArray<string>>> = {
  tag: ['SG B', 'PORV-455A', 'CHG PMP 1B', '4.16 kV BUS 1A', 'WAVY Tj', 'Loop flow, kg/s', 'to Core cold leg A, cold leg B, cold leg C', 'from ACC ×4, CHG ×2, RHR iso, SI header', 'Kjølevann Æ/Ø/Å', 'ΔT "A"'],
  value: ['0', '000', '000.0', '4400', '-12.3', '−12.3', '15.5', '‒‒‒.‒', '0.40'],
  unit: ['%', 'kg/s', 'MPa', '°C', 'm³', 'm³/h', 'µS/cm', 'psig'],
  stateRow: ['STOP', 'POS ?', 'CMD 100 %', 'CMD STOP', 'PASSING', 'NO FLOW', 'AUTO OPEN', 'T AVG'],
  alertLabel: ['P LO-LO', 'L HI-HI', 'AMPS HI', 'SPEED LO', 'OVERLOAD', 'TEMP HI +2'],
}

describe('the OpenBridge text table', () => {
  test('is exactly what the installed OpenBridge package generates', async () => {
    const checkedIn = JSON.parse(await readFile(TEXT_METRICS_FILE, 'utf8')) as unknown
    expect(JSON.parse(JSON.stringify(shaper.metrics())) as unknown).toEqual(checkedIn)
  })

  test('measures a label as wide as HarfBuzz shapes it whole', () => {
    for (const [style, texts] of Object.entries(samples) as Array<[OpenBridgeTextStyle, ReadonlyArray<string>]>)
      for (const text of texts) expect({ style, text, width: textWidth(style, text) }).toEqual({ style, text, width: Math.ceil(shaper.width(style, text)) })
  })

  test('covers the label characters in every style, and refuses others', () => {
    for (const style of Object.keys(samples) as OpenBridgeTextStyle[]) {
      expect(unmeasurable(style, MIMIC_TEXT_CHARACTERS.join(''))).toEqual([])
      expect(unmeasurable(style, 'P → Q ≥ 1')).toEqual(['→', '≥'])
    }
  })

  test('sets values in tabular figures, as OpenBridge reserves digits', () => {
    const { styles } = shaper.metrics()
    expect(styles.value.features.tnum).toBe(1)
    expect(new Set([...'0123456789'].map(digit => styles.value.advance[digit])).size).toBe(1)
    expect(textWidth('value', '1111')).toBe(textWidth('value', '8888'))
  })
})

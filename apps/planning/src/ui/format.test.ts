import { describe, expect, test } from 'bun:test'
import { basisWord, createTimeFormat, durationText, factText, moneyText, quantityText, sourceMark, spanText } from './format.ts'
import { routineBreaches } from './fixtures/svelte-ssr.ts'

describe('planner words for time, money and sources', () => {
  test('durations are hours or minutes, never a count of seconds', () => {
    expect(spanText(3.5 * 3_600_000)).toBe('3.5 h')
    expect(spanText(45 * 60_000)).toBe('45 min')
    expect(durationText(130, 's')).toBe('2 min 10 s')
    expect(durationText(330, 's')).toBe('5 min 30 s')
    expect(durationText(30, 's')).toBe('30 s')
    expect(durationText(2, 'd')).toBe('48 h')
    expect(durationText(0, 'min')).toBe('0 min')
    expect(durationText(0, 'h')).toBe('0 h')
  })

  test('civil time in the plan zone, across the summer-time change', () => {
    const oslo = createTimeFormat('Europe/Oslo')
    // Hand-computed: 06:00Z is 07:00 in Oslo in November (+01:00) and 08:00 in September (+02:00).
    expect(oslo.clock('2026-11-16T06:00:00Z')).toBe('Mon 07:00')
    expect(oslo.when('2026-09-03T06:00:00Z')).toBe('Thu 3 Sep 08:00')
    expect(oslo.range('2026-11-16T06:00:00Z', '2026-11-16T09:00:00Z')).toBe('Mon 07:00–10:00')
    expect(oslo.range('2026-11-16T06:00:00Z', '2026-11-17T14:30:00Z')).toBe('Mon 07:00 – Tue 15:30')
    // Seconds appear only when a time is off the whole minute (the 30 s grid).
    expect(oslo.time('2026-09-03T08:05:30Z')).toBe('10:05:30')
    // Sunday 25 Oct 2026, clocks go back at 01:00Z: 00:30Z is 02:30 (+02:00), 01:30Z is 02:30 again (+01:00).
    expect(oslo.time('2026-10-25T00:30:00Z')).toBe('02:30')
    expect(oslo.time('2026-10-25T01:30:00Z')).toBe('02:30')
    const unset = createTimeFormat(null)
    expect(unset.zoneSet).toBe(false)
    expect(unset.clock('2026-11-16T06:00:00Z')).toBe('Mon 06:00')
  })

  test('money, quantities and World values carry their unit, basis and read time', () => {
    expect(moneyText(464250, 'NOK')).toBe('NOK 464,250')
    expect(quantityText(1500, 'kg')).toBe('1,500 kg')
    expect(quantityText(25000, 'NOK')).toBe('NOK 25,000')
    expect(basisWord('owner-estimate')).toBe('owner estimate')
    const oslo = createTimeFormat('Europe/Oslo')
    expect(factText({ label: 'Running', value: true, basis: 'observed', at: '2026-11-12T09:02:00Z' }, oslo)).toBe('Running: yes · observed · read Thu 10:02')
    expect(factText({ label: 'Payload', value: 1500, unit: 'kg', basis: 'configured', at: '2026-09-03T08:00:00Z' }, oslo)).toBe('Payload: 1,500 kg · configured · read Thu 10:00')
    expect(factText({ label: 'Arrival', value: 130, unit: 's', basis: 'owner-estimate', at: '2026-09-03T08:00:00Z' }, oslo)).toBe('Arrival: 2 min 10 s · owner estimate · read Thu 10:00')
  })

  test('every source has its own shape and word', () => {
    const marks = (['planner', 'assumption', 'reference', 'world'] as const).map(by => sourceMark({ by } as never))
    expect(new Set(marks.map(mark => mark.shape)).size).toBe(4)
    expect(new Set(marks.map(mark => mark.word)).size).toBe(4)
  })

  test('the routine-screen check catches ids, JSON and seconds counts, and lets planner words through', () => {
    expect(routineBreaches('Planned SWA-TAG Mon 07:00', ['SWA-TAG'], ['Remove SW A from service'])).toEqual(['id SWA-TAG'])
    expect(routineBreaches('Serve U-1 Sports hall', ['U-1'], ['Serve U-1 Sports hall water tank'])).toEqual([])
    expect(routineBreaches('{"job": 1}', [], [])).toContain('JSON punctuation')
    expect(routineBreaches('at 2026-11-16T06:00:00Z', [], [])).toEqual(['ISO timestamp'])
    expect(routineBreaches('takes 1800 s', [], [])).toEqual(['seconds count 1800 s'])
    expect(routineBreaches('takes 30 seconds', [], [])).toEqual(['the word seconds'])
    expect(routineBreaches('2 min 10 s; starts before the second starts', [], [])).toEqual([])
  })
})

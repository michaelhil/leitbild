import { describe, expect, test } from 'bun:test'
import { citedKeys, createTurnCardsReader, frozenCard, frozenCardText, itemOf, objectsText, WINDOW_ONLY_MARK } from './cards.ts'

const at = { at: '2026-01-01T10:16:00.000Z', clock: 'simulation' as const }
const card = (count: number, more = 0) => ({
  at, more, adjusted: [],
  items: Array.from({ length: count }, (_, index) => ({ key: `k${index + 1}`, label: `Line ${index + 1} · loading`, reading: `${90 + index}.0 %`, numbers: [{ value: 90 + index, decimals: 1 }] })),
})
// An answer's card on one unit after a trip (World's composer, W7.2): its readings, then its alerts.
const unit = {
  at, more: 20, adjusted: [],
  items: [
    { key: 'k1', label: 'Halden Unit 1 · Steam generator narrow-range level · SG A', object: 'Halden Unit 1', reading: '27.0 %', numbers: [{ value: 27, decimals: 1 }] },
    { key: 'k2', label: 'Halden Unit 1 · Auxiliary feedwater to steam generator A flow · AFW valve A → SG', object: 'Halden Unit 1', reading: '28 kg/s', numbers: [{ value: 28, decimals: 0 }] },
    { key: 'k3', label: 'Halden Unit 1', object: 'Halden Unit 1', reading: 'alarm · Steam generator A low-low level', numbers: [] },
    { key: 'k4', label: 'Halden Unit 1', object: 'Halden Unit 1', reading: 'alarm · Loss of offsite power', numbers: [] },
    { key: 'k5', label: 'Halden Unit 1', object: 'Halden Unit 1', reading: 'alarm · Reactor trip on turbine trip · first out', numbers: [] },
  ],
}
// A Run's alerts (an alerts-only card): four units and the grid, alike but for their object.
const run = {
  at, more: 126, adjusted: [],
  items: [
    ...[1, 2, 3, 4].map(unit => ({ key: `k${unit}`, label: `Halden Unit ${unit}`, object: `Halden Unit ${unit}`, reading: 'alarm · Loss of offsite power', numbers: [] })),
    { key: 'k5', label: 'Norway grid · Halden connection', object: 'Norway grid · Halden connection', reading: 'alarm · Branch loading (above-emergency): Sylling - Tegneby (1) · returned', numbers: [] },
    ...[1, 2, 3, 4].map(unit => ({ key: `k${unit + 5}`, label: `Halden Unit ${unit}`, object: `Halden Unit ${unit}`, reading: 'alarm · Reactor trip on turbine trip · first out', numbers: [] })),
  ],
}

describe('answer cards in the chat', () => {
  test('a frozen card says once when it was read and what it is, and shows three lines before the rest', () => {
    const shown = frozenCard(card(8, 3))
    expect(shown.meta).toBe('Frozen at sim 10:16:00 · AI-composed, not an operating display')
    expect(frozenCard({ ...card(1), at: { at: at.at, clock: 'wall' } }).meta).toBe('Frozen at 10:16:00 · AI-composed, not an operating display')
    // A dashboard's card (a view only the window shows) is World's default and anyone's pins: not called AI-composed.
    expect(frozenCard(card(1), [], WINDOW_ONLY_MARK).meta).toBe('Frozen at sim 10:16:00 · not an operating display')
    // No object named: each label whole, the reading whole beside it.
    expect(shown.lines.map(line => [line.label, line.value])).toEqual(Array.from({ length: 8 }, (_, index) => [`Line ${index + 1} · loading`, `${90 + index}.0 %`]))
    expect(shown.shown).toBe(3)
    // Every line is on the card ("N more lines" opens it); what only the live display holds is counted apart.
    expect(shown.elsewhere).toBe(3)
  })

  test('the lines the answer cites come first, in the order it cites them; the object is named once', () => {
    const shown = frozenCard(unit, citedKeys('Level ⟦k1⟧ is past its low-low limit ⟦k3⟧; AFW ⟦k2⟧, again ⟦k1⟧.'))
    expect(shown.lines.map(line => [line.keys, line.label, line.value, line.cited])).toEqual([
      [['k1'], 'Steam generator narrow-range level · SG A', '27.0 %', true],
      // An alert that names only its object reads as its reading alone.
      [['k3'], '', 'alarm · Steam generator A low-low level', true],
      [['k2'], 'Auxiliary feedwater to steam generator A flow · AFW valve A → SG', '28 kg/s', true],
      [['k4'], '', 'alarm · Loss of offsite power', false],
      [['k5'], '', 'alarm · Reactor trip on turbine trip · first out', false],
    ])
    expect(shown.elsewhere).toBe(20)
  })

  test('items alike but for their object are one line naming them all; a cited key brings its line up', () => {
    const shown = frozenCard(run, citedKeys('All four tripped ⟦k6⟧ ⟦k7⟧ ⟦k8⟧ ⟦k9⟧ after losing offsite power ⟦k1⟧.'))
    expect(shown.lines.map(line => [line.keys.join(' '), line.label, line.value])).toEqual([
      ['k6 k7 k8 k9', 'Halden Unit 1, 2, 3, 4', 'alarm · Reactor trip on turbine trip · first out'],
      ['k1 k2 k3 k4', 'Halden Unit 1, 2, 3, 4', 'alarm · Loss of offsite power'],
      ['k5', 'Norway grid · Halden connection', 'alarm · Branch loading (above-emergency): Sylling - Tegneby (1) · returned'],
    ])
    expect(shown.shown).toBe(3)
  })

  test('objects alike but for their last words are written once', () => {
    expect(objectsText(['Halden Unit 1', 'Halden Unit 2'])).toBe('Halden Unit 1, 2')
    expect(objectsText(['Unit 1', 'Unit 2', 'Unit 10'])).toBe('Unit 1, 2, 10')
    expect(objectsText(['Halden Unit 1', 'Norway grid · Halden connection'])).toBe('Halden Unit 1, Norway grid · Halden connection')
    expect(objectsText(['Ambulance', 'Ambulance 2'])).toBe('Ambulance, Ambulance 2')
  })

  test('the keys an answer cites, each once, in the order it first cites them', () => {
    expect(citedKeys('a ⟦k3⟧ b ⟦k1⟧ c ⟦k3⟧ ⟦k12⟧ [k4]')).toEqual(['k3', 'k1', 'k12'])
    expect(citedKeys('none')).toEqual([])
  })

  test('assistive technology reads the frozen card apart from the chip\'s actions: title, what it is, every line, what only the display holds', () => {
    expect(frozenCardText('Loading', frozenCard(card(2, 1)))).toBe('Loading. Frozen at sim 10:16:00 · AI-composed, not an operating display. Line 1 · loading: 90.0 % (k1). Line 2 · loading: 91.0 % (k2). 1 more on the live display')
    expect(frozenCardText('Alerts', frozenCard(run))).toContain('Halden Unit 1, 2, 3, 4: alarm · Loss of offsite power (k1, k2, k3, k4)')
  })

  test('one read per answer turn, validated; a failed or broken read is kept as a refusal that says why', async () => {
    const paths: string[] = []
    const bodies: Record<string, { status: number; body: unknown }> = {
      '/rooms/r/executions/t1/cards': { status: 200, body: { cards: [{ viewRef: 'call_0_0/a', card: card(2) }, { viewRef: 'call_1_0/b', card: { ...card(1), items: [{ ...card(1).items[0]!, key: 'k3', label: 'Reserve' }] } }] } },
      '/rooms/r/executions/t2/cards': { status: 404, body: null },
      '/rooms/r/executions/t3/cards': { status: 200, body: { cards: [{ viewRef: 'call_0_0/a', card: { items: 'none' } }] } },
    }
    const read = createTurnCardsReader(async path => { paths.push(path); return bodies[path]! })
    const first = await read('r', 't1')
    expect(await read('r', 't1')).toBe(first)
    expect(paths).toEqual(['/rooms/r/executions/t1/cards'])
    if (first.kind !== 'cards') throw new Error('expected cards')
    expect(itemOf(first.cards, 'k3')?.label).toBe('Reserve')
    expect(itemOf(first.cards, 'k9')).toBeUndefined()
    expect(await read('r', 't2')).toEqual({ kind: 'refused', message: "reading this answer's cards failed with HTTP 404" })
    expect(await read('r', 't3')).toMatchObject({ kind: 'refused', message: expect.stringContaining("this answer's cards are unreadable") })
  })
})

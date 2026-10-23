import { describe, expect, test } from 'bun:test'
import type { Screen, ScreenLine } from './display-dom.ts'
import { classify, sizeSpec } from './display-press.ts'
import { E0_CHECKS } from './e0.ts'
import { csfRow, viewport } from './matrix.ts'
import type { DisplayState } from './display-dom.ts'

const line = (text: string, region: string, y: number, extra: Partial<ScreenLine> = {}): ScreenLine => ({ text, region, on: true, valueOn: true, x: 20, y, w: 200, h: 16, ...extra })
const screen = (lines: ReadonlyArray<ScreenLine>, window: Partial<NonNullable<Screen['window']>> = {}, dialogs: Screen['dialogs'] = []): Screen => ({
  frame: { x: 13, y: 97, w: 1896, h: 960, visibleW: 1896, visibleH: 960 },
  window: { position: '1 / 5', title: 'Halden Unit 1 · Overview', back: false, src: 'a', ...window },
  lines, dialogs,
})
const judge = (id: string, on: Screen) => E0_CHECKS.find(check => check.id === id)!.judge(on)

// Production (d69fa9df5) as the screen reader read Run A at 1920 (trimmed), and R2 as the lanes' commits write it.
const production = screen([
  line('Halden Unit 1', 'header', 100), line('Alarm', 'header', 101),
  line('Subcriticality (CSF) GREEN', 'chips', 124), line('Core cooling (CSF) GREEN', 'chips', 124), line('Heat sink (CSF) GREEN', 'chips', 124),
  line('RCS integrity (CSF) GREEN', 'chips', 124), line('Containment (CSF) GREEN', 'chips', 124), line('RCS inventory (CSF) GREEN', 'chips', 124), line('Operating mode Hot standby', 'chips', 124),
  line('Turbine OFF LINE 0 MW', 'drawing', 193), line('Core 100.0 % 302.4 °C', 'drawing', 769), line('RCP A commanded RUN', 'drawing', 481),
  line('RCP B commanded RUN', 'drawing', 481), line('RCP C commanded RUN', 'drawing', 481), line('RCP D commanded RUN', 'drawing', 481),
  line('Process header outlet flow · AFW header 113 kg/s', 'column', 195), line('Pressurizer pressure 13.66 MPa', 'column', 219, { on: false }),
  line('Pressurizer level 34.0 %', 'column', 243), line('Pressurizer pressure 13.66 MPa', 'column', 484, { x: 1774, on: false }),
  line('Alerts · 29', 'alerts', 581), line('Loss of offsite power 04:02:02 UTC', 'alerts', 604), line('first out Reactor trip on turbine trip 04:02:02 UTC', 'alerts', 628),
  line('Reactor trip on RCP breaker open 04:02:02 UTC', 'alerts', 652), line('+24 more', 'alerts', 725),
])
const r2 = screen([
  line('Halden Unit 1', 'header', 100), line('Alarm', 'header', 100), line('Hot standby', 'header', 100), line('SUBCRIT', 'header', 100), line('CORE COOL', 'header', 100),
  line('HEAT SINK', 'header', 100), line('INTEGRITY', 'header', 100), line('CTMT', 'header', 100), line('INVENTORY', 'header', 100),
  line('RX TRIP · 1st Reactor trip on turbine trip · 2:58 ago · ACTUATED: AFW START · FWI · TURB TRIP', 'trip', 124),
  line('Turbine OFF LINE 0 MW', 'drawing', 193), line('Core Rods on bottom 4.4×10⁻⁷ A 302.4 °C', 'drawing', 769),
  line('RCP A STOP CMD RUN', 'drawing', 481), line('RCP B STOP CMD RUN', 'drawing', 481), line('RCP C STOP CMD RUN', 'drawing', 481), line('RCP D STOP CMD RUN', 'drawing', 481),
  line('AFW header flow 113 kg/s', 'column', 195), line('PZR pressure 13.66 MPa', 'column', 219), line('Pressurizer level 34.0 %', 'column', 243), line('HI-HI 16.55', 'column', 490),
  line('Alerts · 29', 'alerts', 581), line('1st RX TRIP: Reactor trip on turbine trip 04:02:02 UTC', 'alerts', 604), line('Loss of offsite power 04:02:02 UTC', 'alerts', 628),
  line('Steam generator A level low 04:02:19 UTC', 'alerts', 652), line('17 expected after RX TRIP ▸', 'alerts', 676),
])

describe('E-0 at a glance', () => {
  test('production fails the trip, the actuations, the RCPs and the alarm picture, and passes the turbine, the AFW total, PZR and CSF', () => {
    expect(judge('reactor-tripped', production).pass).toBe(false)
    expect(judge('turbine-tripped', production).pass).toBe(true)
    expect(judge('si-actuated', production).pass).toBe(false)
    expect(judge('afw-total', production).pass).toBe(true)
    expect(judge('rcps-tripped', production).pass).toBe(false)
    expect(judge('pzr-trend', production).pass).toBe(true)
    expect(judge('csf', production).pass).toBe(true)
    expect(judge('alarm-picture', production).pass).toBe(false)
  })
  test("R2's trip line, rods on bottom, STOP · CMD RUN, short chips and aggregate pass", () => {
    for (const id of ['reactor-tripped', 'turbine-tripped', 'si-actuated', 'afw-total', 'rcps-tripped', 'pzr-trend', 'csf', 'alarm-picture']) expect([id, judge(id, r2).pass]).toEqual([id, true])
  })
  test("R2's two-line rows with m:ss ages count, and their first-outs are named by group", () => {
    const rendered = screen([
      line('Alerts · 29 · 29 UNACK', 'alerts', 581), line('1st TURB TRIP: Turbine trip on loss of load', 'alerts', 604), line('UNACK 2:59', 'alerts', 628),
      line('1st RX TRIP: Reactor trip on turbine trip', 'alerts', 652), line('UNACK LO · RX TRIP · 2:58', 'alerts', 676),
      line('UNACK Loss of offsite power', 'alerts', 700), line('LO-LO · ALM · 2:58', 'alerts', 700, { x: 300 }),
      line('15 expected after RX TRIP 15 UNACK', 'alerts', 724),
    ])
    const judged = judge('alarm-picture', rendered)
    expect(judged.pass).toBe(true)
    expect(judged.evidence).toContain('3 rows on screen; first-outs 2 (2 named by group)')
  })
  test('a turbine trip named only in an alert row is no turbine state', () => {
    const rowOnly = screen([line('first out Reactor trip on turbine trip 04:02:02 UTC', 'alerts', 628)])
    expect(judge('turbine-tripped', rowOnly).pass).toBe(false)
  })
  test('a value scrolled out of a narrow window does not count', () => {
    const scrolled = screen([line('Process header outlet flow · AFW header 113 kg/s', 'column', 195, { on: false, valueOn: false })])
    expect(judge('afw-total', scrolled).pass).toBe(false)
  })
  test("a drawn RCP behind the drawing's scroll affordance counts, and says so; one out of view without it does not", () => {
    const narrow = (behind: boolean) => screen(r2.lines.map(entry => /^RCP [CD]/.test(entry.text) ? { ...entry, on: false, valueOn: false, behind } : entry))
    expect(judge('rcps-tripped', narrow(true)).pass).toBe(true)
    expect(judge('rcps-tripped', narrow(true)).evidence).toContain("2 behind the drawing's scroll affordance")
    expect(judge('rcps-tripped', narrow(false)).pass).toBe(false)
  })
  test('a chip cut by the window is not whole', () => {
    const cut = screen(production.lines.map(entry => entry.text.startsWith('Heat sink') ? { ...entry, on: false } : entry))
    expect(judge('csf', cut)).toEqual({ pass: false, evidence: '5 of 6 whole; cut: heat sink' })
  })
})

describe('E-0 in one click', () => {
  test('a detail drawing Bus A LIVE answers the emergency buses; a unit bus does not', () => {
    expect(judge('ac-buses', screen([line('Bus A LIVE 6.6 kV', 'drawing', 600)])).pass).toBe(true)
    expect(judge('ac-buses', screen([line('Unit Bus A DEAD 0 kV', 'drawing', 600)])).pass).toBe(false)
  })
  test('the AFW flow to one SG answers that SG only', () => {
    const sgA = screen([line('Auxiliary feedwater to steam generator A flow · AFW valve A → SG A 28.1 kg/s', 'faceplate', 300)])
    expect(judge('afw-sg-a', sgA).pass).toBe(true)
    expect(judge('afw-sg-b', sgA).pass).toBe(false)
  })
  test('a mixed group partly running does not say MD AFW A runs; a group of the AFW pumps all running does', () => {
    expect(judge('afw-pumps', screen([line('CHG A/CS A/HHSI A/MD AFW A/RHR A RUN 2/5', 'drawing', 380)])).pass).toBe(false)
    expect(judge('afw-pumps', screen([line('MD AFW A/MD AFW B/TD AFW RUN 3/3', 'drawing', 380), line('TD AFW RUN', 'drawing', 420)])).pass).toBe(true)
  })
  test('natural circulation needs its criterion', () => {
    expect(judge('natural-circulation', screen([line('Natural circulation 2/5 · not yet met: SG pressures', 'body', 300)])).pass).toBe(true)
    expect(judge('natural-circulation', screen([line('Natural circulation', 'body', 300)])).pass).toBe(false)
  })
})

describe('what a press opened', () => {
  const home = screen([line('Halden Unit 1', 'header', 100), line('sim 04:05:00', 'footer', 1037)])
  test('another display in the window is a detail; a dialog in the display a faceplate; a menu a chooser', () => {
    expect(classify(home, screen(home.lines, { title: 'Halden Unit 1 · Steam Generator A', position: '2 / 6' }), [], [])).toEqual({ kind: 'detail', title: 'Halden Unit 1 · Steam Generator A', position: '2 / 6' })
    expect(classify(home, screen(home.lines, {}, [{ label: 'SG A: pop-over', where: 'display', x: 600, y: 260, w: 340, h: 600, pinned: false }]), [], []).kind).toBe('faceplate')
    expect(classify(home, screen(home.lines, {}, [{ label: 'Choose: ACC A check valve, ACC B', where: 'display', x: 600, y: 260, w: 200, h: 80, pinned: false }]), [], []).kind).toBe('chooser')
  })
  test('a playing Run moving its numbers is no change; new words are', () => {
    expect(classify(home, screen([line('Halden Unit 1', 'header', 100), line('sim 04:05:03', 'footer', 1037)]), [], []).kind).toBe('nothing')
    expect(classify(home, screen([...home.lines, line('Nothing opened: no display window takes it here', 'body', 140)]), [], []).kind).toBe('changed')
  })
  test('a dialog on the Run page (a tag dialog) is a page dialog', () => {
    expect(classify(home, home, [], ['DG-A emergency diesel generator A status'])).toEqual({ kind: 'page-dialog', label: 'DG-A emergency diesel generator A status' })
  })
})

describe('the rendering matrix', () => {
  test('sizes: the legacy names and <w>x<h>[+chat]', () => {
    expect(sizeSpec('1046')).toEqual({ name: '1046', width: 1920, height: 1080, chat: true })
    expect(sizeSpec('1440x900+chat')).toEqual({ name: '1440x900+chat', width: 1440, height: 900, chat: true })
    expect(() => sizeSpec('wide')).toThrow()
  })
  test("CSF row: production's chips under the title fail; R2's on the title row within 560 px pass", () => {
    expect(csfRow(production, sizeSpec('1920'), 'B').pass).toBe(false)
    const compact = screen(r2.lines.map(entry => entry.region === 'header' && entry.text !== 'Halden Unit 1' ? { ...entry, x: 1400, w: 60 } : entry))
    expect(csfRow(compact, sizeSpec('1920'), 'B').pass).toBe(true)
  })
  test('viewport: leads, the count and three rows on screen', () => {
    const state = { leads: [{ label: 'AFW header flow', value: '113 kg/s' }, { label: 'PZR pressure', value: '13.66 MPa' }] } as unknown as DisplayState
    expect(viewport(state, r2, sizeSpec('1046')).pass).toBe(true)
    const off = screen(r2.lines.map(entry => entry.region === 'alerts' ? { ...entry, on: false, valueOn: false } : entry))
    expect(viewport(state, off, sizeSpec('1046')).pass).toBe(false)
  })
})

/** E-0, 11 of 11, scripted (plan v5 §5.3): the post-trip E-0 / ES-0.1 checks of the hmi audit (hmi.md §1), on a unit
 * overview of Run A (LOOP +3 min, paused), at 1920 px and at 1046 px with the chat open. Reusable every release.
 *
 *   bun scripts/display-eval/e0.ts --origin=http://127.0.0.1:<port> --workspace=<id> --run=<Run A> --out=<dir>
 *       [--label=<stack>] [--sizes=1920,1046] [--port=<CDP port>] [--unit="Halden Unit 1"]
 *
 * At a glance (checks 1, 2, 4, 5 total, 7, 8, 9, 11): read from the overview as it opens, with no press; a check
 * passes only on text whose value shows whole on screen (not scrolled out of a narrow window, not clipped).
 * In one click (checks 3, 5 per SG, 6, 10): every target a person can press on the overview (each drawn item's
 * body, its label and its magnifier, the chips, the trip line's labels, the alert rows and "+N more") is pressed in
 * turn from the overview, what opens is read on screen (a detail as the next deck entry, a faceplate, a chooser),
 * and the view is restored (Esc, then Back). A one-click check passes when some single press shows its answer.
 * The same sweep records what each press opened, so presses that open nothing are counted as dead ends.
 *
 * Writes <out>/<label>-e0.json and shots. Loopback only; reads only (the Run is not changed); no model is called. */
import { join } from 'node:path'
import { ensureChrome, loopbackOrigin, openPage, options, sleep, type Page } from './browser.ts'
import { behindAffordance, onScreen, type PressTarget, type Screen, type ScreenLine } from './display-dom.ts'
import { goHome, homeOf, openOverview, press, sizeSpec, targetsOf, type Outcome, type SizeSpec } from './display-press.ts'

export interface Judged { readonly pass: boolean; readonly evidence: string }
export interface E0Check { readonly id: string; readonly n: string; readonly what: string; readonly mode: 'glance' | 'click'; readonly judge: (screen: Screen) => Judged }

const lines = (screen: Screen, pattern: RegExp, regions?: ReadonlyArray<string>) => onScreen(screen, pattern, regions)
const quote = (found: ReadonlyArray<ScreenLine>) => found.slice(0, 3).map(line => `"${line.text.slice(0, 90)}"`).join(', ')
const FLOW = /\d+(\.\d+)?\s*kg\/s/
const RUNWORD = /\bRUN(NING)?\b/
/** A drawn or listed state of one item: its name, then a run word, in a line that is no mixed group partly running. */
const runningLine = (screen: Screen, name: RegExp): ScreenLine | undefined => lines(screen, name).find(line => {
  if (!RUNWORD.test(line.text) || /\bSTOP\b|NOT RUN/.test(line.text.replace(/CMD RUN/g, ''))) return false
  const count = line.text.match(/RUN\s+(\d+)\/(\d+)/)
  return count === null || count[1] === count[2]
})
const sgs = ['A', 'B', 'C', 'D'] as const
const afwToSg = (sg: string) => new RegExp(`(auxiliary feedwater|AFW)[^|]*(\\bSG ${sg}\\b|steam generator ${sg}\\b)`, 'i')
/** A first-out line written in the frame (not only an alerts row): the trip line or the title row. */
const tripLine = (screen: Screen) => lines(screen, /\bRX TRIP\b|\b1st\b.*TRIP|FIRST OUT.*·|reactor trip/i).filter(line => line.region !== 'alerts' && line.region !== 'drawing')

export const E0_CHECKS: ReadonlyArray<E0Check> = [
  {
    id: 'reactor-tripped', n: '1', what: 'Reactor tripped: a trip line names RX TRIP, and the core writes "Rods on bottom" with its flux on the instrument in range', mode: 'glance',
    judge: screen => {
      const trip = tripLine(screen)
      const rods = lines(screen, /rods on bottom/i)
      const flux = rods.filter(line => /\d(\.\d+)?\s*(×10[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+\s*A|%|cps)/.test(line.text))
      return { pass: trip.length > 0 && flux.length > 0, evidence: `trip line ${trip.length > 0 ? quote(trip) : 'none in the frame'}; rods on bottom ${rods.length > 0 ? quote(rods) : 'not written'}${rods.length > 0 && flux.length === 0 ? ' (no flux beside it)' : ''}` }
    },
  },
  {
    id: 'turbine-tripped', n: '2', what: 'Turbine tripped: the turbine reads OFF LINE (or its stop valves SHUT)', mode: 'glance',
    judge: screen => {
      const regions = ['drawing', 'column', 'trip', 'header', 'chips', 'body']
      const found = [...lines(screen, /\bturbine\b.*\b(OFF ?LINE|TRIP(PED)?)\b/i, regions), ...lines(screen, /turbine stop valves?.*\bSHUT\b/i, regions)]
      return { pass: found.length > 0, evidence: found.length > 0 ? quote(found) : 'no turbine state on screen' }
    },
  },
  {
    id: 'si-actuated', n: '4', what: 'SI actuated or needed: the trip line lists what actuated ("ACTUATED: …")', mode: 'glance',
    judge: screen => {
      const found = lines(screen, /\bACTUATED\b/)
      return { pass: found.length > 0, evidence: found.length > 0 ? quote(found) : 'no ACTUATED line on screen' }
    },
  },
  {
    id: 'afw-total', n: '5 (total)', what: 'Heat sink, total: the AFW flow (kg/s) shows on screen', mode: 'glance',
    judge: screen => {
      const found = lines(screen, /(auxiliary feedwater|\bAFW\b)/i).filter(line => FLOW.test(line.text) && !sgs.some(sg => afwToSg(sg).test(line.text)))
      return { pass: found.length > 0, evidence: found.length > 0 ? quote(found) : 'no AFW total flow on screen' }
    },
  },
  {
    id: 'rcps-tripped', n: '7', what: 'RCPs tripped: each RCP reads STOP (a command not followed reads "STOP · CMD RUN")', mode: 'glance',
    judge: screen => {
      const per = sgs.map(loop => ({ loop, found: lines(screen, new RegExp(`\\bRCP ${loop}\\b|reactor coolant pump ${loop}\\b`, 'i')).filter(line => /\bSTOP\b|NOT RUN/.test(line.text)) }))
      const missing = per.filter(entry => entry.found.length === 0).map(entry => `RCP ${entry.loop}`)
      const shown = sgs.map(loop => lines(screen, new RegExp(`\\bRCP ${loop}\\b`)).map(line => line.text).find(text => text.length < 60) ?? '').filter(Boolean)
      const behind = behindAffordance(per.flatMap(entry => entry.found.slice(0, 1))).length
      return { pass: missing.length === 0, evidence: missing.length === 0 ? `all four read STOP: ${quote(per.map(entry => entry.found[0]!))}${behind > 0 ? ` (${behind} behind the drawing's scroll affordance)` : ''}` : `${missing.join(', ')} not read as stopped; on screen: ${shown.map(text => `"${text}"`).join(', ') || 'no RCP'}` }
    },
  },
  {
    id: 'pzr-trend', n: '8', what: 'PZR pressure and level with a trend: both values show, and a trend (strip legend or sparkline) of PZR pressure', mode: 'glance',
    judge: screen => {
      const pressure = lines(screen, /pressuri[sz]er(?!.*level)|\bPZR\b/i).filter(line => /\d+(\.\d+)?\s*MPa/.test(line.text) && line.region !== 'drawing')
      const level = lines(screen, /pressuri[sz]er level|\bPZR\b.*%/i).filter(line => /\d+(\.\d+)?\s*%/.test(line.text) && line.region !== 'drawing')
      // A trend: a legend entry of a strip, or a sparkline drawn on the pressure row (the screen reader lists the
      // strip's legend and its axis ticks as lines of the column).
      const legend = screen.lines.filter(line => line.valueOn && /^Pres/.test(line.text) && /MPa/.test(line.text) && line.x > (pressure[0]?.x ?? 0) + 100)
      const ticks = screen.lines.filter(line => line.on && /^(LO|HI)(-(LO|HI))? \d/.test(line.text))
      const trend = legend.length > 0 || ticks.length > 0
      return { pass: pressure.length > 0 && level.length > 0 && trend, evidence: `pressure ${pressure.length > 0 ? quote(pressure) : 'not on screen'}; level ${level.length > 0 ? quote(level) : 'not on screen'}; trend ${trend ? (legend.length > 0 ? quote(legend) : `limit ticks ${quote(ticks)}`) : 'none on screen'}` }
    },
  },
  {
    id: 'csf', n: '9', what: 'CSF status: all six safety-function chips show whole', mode: 'glance',
    judge: screen => {
      const names: ReadonlyArray<[string, RegExp]> = [['subcriticality', /subcrit/i], ['core cooling', /core cool/i], ['heat sink', /heat sink/i], ['RCS integrity', /integrity|\bINTEG/i], ['containment', /containment(?! pressure)|\bCTMT\b|\bCONT\b/i], ['RCS inventory', /inventory|\bINV\b/i]]
      const chips = screen.lines.filter(line => line.region === 'chips' || line.region === 'header')
      const per = names.map(([name, pattern]) => ({ name, line: chips.find(line => pattern.test(line.text)) }))
      const whole = per.filter(entry => entry.line?.on === true)
      const cut = per.filter(entry => entry.line !== undefined && !entry.line.on).map(entry => entry.name)
      const missing = per.filter(entry => entry.line === undefined).map(entry => entry.name)
      return { pass: whole.length === 6, evidence: `${whole.length} of 6 whole${cut.length > 0 ? `; cut: ${cut.join(', ')}` : ''}${missing.length > 0 ? `; not on screen: ${missing.join(', ')}` : ''}` }
    },
  },
  {
    id: 'alarm-picture', n: '11', what: 'Alarm picture: at least 3 alert rows on screen, first-outs named by their group ("1st RX TRIP"), and the expected alerts gathered in an aggregate', mode: 'glance',
    judge: screen => {
      // A row's age: "04:02:02 UTC" (production) or "2:59" (R2, m:ss); R2 writes a row on two lines (message, then
      // UNACK, tag and age), so first-outs are read on any of the list's lines on screen.
      const rows = screen.lines.filter(line => line.region === 'alerts' && line.valueOn && /\b\d{1,2}:\d{2}\b|\bago\b|\d+\s*(s|min)\b/.test(line.text))
      const firstOuts = screen.lines.filter(line => line.region === 'alerts' && line.valueOn && /\b1st\b|first out/i.test(line.text))
      const grouped = firstOuts.filter(line => /\b1st [A-Z]{2,}|first out [A-Z]{2,}\b.*:/.test(line.text))
      const aggregate = lines(screen, /\d+\s+expected\b/i)
      return { pass: rows.length >= 3 && (firstOuts.length === 0 || grouped.length === firstOuts.length) && aggregate.length > 0, evidence: `${rows.length} rows on screen; first-outs ${firstOuts.length} (${grouped.length} named by group${firstOuts.length > grouped.length ? `, e.g. "${firstOuts.find(line => !grouped.includes(line))!.text.slice(0, 60)}"` : ''}); expected aggregate ${aggregate.length > 0 ? quote(aggregate) : 'none'}` }
    },
  },
  {
    id: 'ac-buses', n: '3', what: 'AC emergency buses energized: a view showing Bus A or Bus B LIVE (or its kV), one press from the overview', mode: 'click',
    judge: screen => {
      const found = lines(screen, /\b(Bus [AB]|safety bus [AB]|emergency bus)\b/i).filter(line => /\bLIVE\b|energi[sz]ed|\d+(\.\d+)?\s*kV/i.test(line.text) && !/unit bus/i.test(line.text))
      return { pass: found.length > 0, evidence: found.length > 0 ? quote(found) : '' }
    },
  },
  ...sgs.map((sg): E0Check => ({
    id: `afw-sg-${sg.toLowerCase()}`, n: `5 (SG ${sg})`, what: `Heat sink per SG: the AFW flow to SG ${sg} (kg/s), one press from the overview`, mode: 'click',
    judge: screen => {
      const found = lines(screen, afwToSg(sg)).filter(line => FLOW.test(line.text))
      return { pass: found.length > 0, evidence: found.length > 0 ? quote(found) : '' }
    },
  })),
  {
    id: 'afw-pumps', n: '6', what: 'AFW pumps running: MD AFW A, MD AFW B and TD AFW each with its run state, one press from the overview', mode: 'click',
    judge: screen => {
      const per: ReadonlyArray<[string, RegExp]> = [['MD AFW A', /\bMD AFW A\b|MD AFW A\/B/], ['MD AFW B', /\bMD AFW B\b|MD AFW A\/B/], ['TD AFW', /\bTD AFW\b/]]
      const found = per.map(([name, pattern]) => ({ name, line: runningLine(screen, pattern) ?? lines(screen, pattern).find(line => /\bSTOP\b/.test(line.text)) }))
      return { pass: found.every(entry => entry.line !== undefined), evidence: found.filter(entry => entry.line !== undefined).map(entry => `${entry.name}: "${entry.line!.text.slice(0, 60)}"`).join(', ') }
    },
  },
  {
    id: 'natural-circulation', n: '10', what: 'Natural circulation with no RCP running: its criterion ("2/5 · not yet met: …"), one press from the overview', mode: 'click',
    judge: screen => {
      const found = lines(screen, /natural circulation/i).filter(line => /\d\s*\/\s*\d|\bmet\b|not yet/i.test(line.text))
      return { pass: found.length > 0, evidence: found.length > 0 ? quote(found) : '' }
    },
  },
]

export interface SweepEntry { readonly target: Omit<PressTarget, 'x' | 'y' | 'w' | 'h'>; readonly outcome: Outcome; readonly ms: number; readonly homeVia: ReadonlyArray<string>; readonly satisfies: ReadonlyArray<string>; readonly evidence: Readonly<Record<string, string>>; readonly shot?: string }

/** Presses every target of the home view once, judging each one-click check on what opened, and restores the view. */
export const sweep = async (page: Page, config: { readonly checks: ReadonlyArray<E0Check>; readonly reopen: () => Promise<Screen>; readonly shotDir: string; readonly tag: string; readonly log?: (line: string) => void }): Promise<{ readonly entries: ReadonlyArray<SweepEntry>; readonly firstHits: Record<string, number> }> => {
  let homeScreen = await config.reopen()
  const home = homeOf(homeScreen)
  const targets = await targetsOf(page)
  const entries: SweepEntry[] = []
  const firstHits: Record<string, number> = {}
  for (const [index, target] of targets.entries()) {
    // Re-read the target where it stands now (a sample may have moved the text a little).
    const now = (await targetsOf(page)).find(candidate => candidate.key === target.key) ?? target
    const { outcome, ms, after } = await press(page, now, 2_000)
    const judged = outcome.kind === 'nothing' ? [] : config.checks.map(check => ({ id: check.id, ...check.judge(after) })).filter(entry => entry.pass)
    const satisfies = judged.map(entry => entry.id)
    const fresh = satisfies.filter(id => firstHits[id] === undefined)
    let shot: string | undefined
    if (fresh.length > 0) {
      shot = join(config.shotDir, `${config.tag}-click-${String(index).padStart(2, '0')}.png`)
      await page.shot(shot)
      for (const id of fresh) firstHits[id] = entries.length
    }
    const back = outcome.kind === 'nothing' ? { home: true, via: [] } : await goHome(page, home)
    entries.push({ target: { key: target.key, kind: target.kind, name: target.name, item: target.item, reaches: target.reaches, visible: target.visible }, outcome, ms, homeVia: back.via, satisfies, evidence: Object.fromEntries(judged.map(entry => [entry.id, entry.evidence])), ...(shot ? { shot } : {}) })
    config.log?.(`  ${String(index).padStart(2)} ${target.kind.padEnd(9)} ${target.name.slice(0, 50).padEnd(50)} → ${outcome.kind}${'title' in outcome && outcome.title ? ` "${outcome.title}"` : 'label' in outcome ? ` "${outcome.label.slice(0, 40)}"` : ''}${satisfies.length > 0 ? `  ✔ ${satisfies.join(', ')}` : ''}`)
    if (!back.home) { config.log?.('    (not home after Esc and Back: reopening)'); homeScreen = await config.reopen() }
  }
  return { entries, firstHits }
}

const runSize = async (config: { readonly origin: string; readonly workspaceId: string; readonly runId: string; readonly port: number; readonly size: SizeSpec; readonly out: string; readonly label: string; readonly unit: string }) => {
  const tag = `${config.label}-${config.size.name}`
  const page = await openPage(config.port, config.size.width, config.size.height)
  try {
    const reopen = () => openOverview(page, { origin: config.origin, workspaceId: config.workspaceId, runId: config.runId, unit: config.unit, size: config.size })
    const glance = await reopen()
    const glanceShot = join(config.out, `${tag}-e0-glance.png`)
    await page.shot(glanceShot)
    const glanceChecks = E0_CHECKS.filter(check => check.mode === 'glance').map(check => ({ check, judged: check.judge(glance) }))
    const clickChecks = E0_CHECKS.filter(check => check.mode === 'click')
    console.log(`${tag}: sweeping one-click presses`)
    const { entries, firstHits } = await sweep(page, { checks: clickChecks, reopen, shotDir: config.out, tag: `${tag}-e0`, log: line => console.log(line) })
    const results = [
      ...glanceChecks.map(({ check, judged }) => ({ id: check.id, n: check.n, what: check.what, mode: check.mode, pass: judged.pass, evidence: judged.evidence, shot: glanceShot })),
      ...clickChecks.map(check => {
        const hit = firstHits[check.id] === undefined ? undefined : entries[firstHits[check.id]!]!
        // At a glance counts too: a one-click check already answered on the overview needs no press.
        const already = check.judge(glance)
        return {
          id: check.id, n: check.n, what: check.what, mode: check.mode, pass: already.pass || hit !== undefined,
          evidence: already.pass ? `at a glance: ${already.evidence}` : hit === undefined ? `no single press of ${entries.length} shows it` : `press ${hit.target.kind} "${hit.target.name.slice(0, 60)}" → ${hit.outcome.kind}: ${hit.evidence[check.id] ?? 'shown'}`,
          ...(hit?.shot ? { shot: hit.shot } : {}),
        }
      }),
    ]
    const dead = entries.filter(entry => entry.outcome.kind === 'nothing')
    return {
      size: config.size, displayWidth: glance.frame?.w ?? null,
      score: { glance: results.filter(result => result.mode === 'glance' && result.pass).length, click: results.filter(result => result.mode === 'click' && result.pass).length, of: results.length, checks: E0_CHECKS.length },
      results,
      presses: { total: entries.length, opened: entries.filter(entry => entry.outcome.kind !== 'nothing').length, deadEnds: dead.length, byKind: Object.fromEntries([...new Set(entries.map(entry => entry.target.kind))].map(kind => [kind, { pressed: entries.filter(entry => entry.target.kind === kind).length, openedNothing: dead.filter(entry => entry.target.kind === kind).length }])) },
      sweep: entries,
      console: page.console.slice(-20),
    }
  } catch (error) {
    await page.shot(join(config.out, `${tag}-e0-failed.png`))
    throw error
  } finally {
    await page.close()
  }
}

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const origin = loopbackOrigin(argv.get('origin'))
  const workspaceId = argv.get('workspace'), runId = argv.get('run'), out = argv.get('out')
  if (workspaceId === undefined || runId === undefined || out === undefined) throw new Error('usage: e0.ts --origin=… --workspace=<id> --run=<Run A> --out=<dir> (see the header)')
  const label = argv.get('label') ?? new URL(origin).port
  const port = Number(argv.get('port') ?? 44335)
  const chrome = await ensureChrome({ port, profile: join(out, `chrome-${port}`) })
  const results: Array<Record<string, unknown>> = []
  try {
    for (const name of (argv.get('sizes') ?? '1920,1046').split(',')) {
      const result = await runSize({ origin, workspaceId, runId, port, size: sizeSpec(name), out, label, unit: argv.get('unit') ?? 'Halden Unit 1' })
      results.push(result)
      await Bun.write(join(out, `${label}-e0.json`), JSON.stringify({ label, origin, runId, results }, null, 2))
      console.log(`${label} ${name} E-0: ${result.score.glance} at a glance + ${result.score.click} in one click of ${result.score.of} rows (11 checks; 5 per SG counted per SG); ${result.presses.deadEnds} of ${result.presses.total} presses opened nothing`)
      for (const row of result.results) console.log(`  ${row.n.padEnd(9)} ${row.mode.padEnd(6)} ${row.pass ? 'PASS' : 'FAIL'}  ${row.evidence.slice(0, 200)}`)
    }
  } finally {
    if (chrome.started) await chrome.stop()
    await sleep(0)
  }
}

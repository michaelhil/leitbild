/** Needle in the haystack (plan v5 §5.2): a loss of offsite power plus MD AFW A failing to start, set by Instructor
 * action on a copy (no AI). The unit overview is open at power and stays open through the fault.
 *
 *   bun scripts/display-eval/needle.ts --origin=http://127.0.0.1:<port> --workspace=<id> --from=<paused Run at power>
 *       --out=<dir> [--label=<stack>] [--inject=action:<instructor action id> | --inject=write:<path>=<value>]
 *       [--size=1920] [--port=<CDP port>] [--unit="Halden Unit 1"] [--plant=plant:halden-1] [--element=auxFeedwaterPumpMotor]
 *       [--name="MD AFW A"] [--window=300] [--after=330]
 *
 * It copies the at-power Run (the copy keeps the Scenario's LOOP ahead of it), sets the needle on the copy before
 * the fault — an Instructor action (`world.process-plant.action.invoke`, as a person), or a write as the Run's own
 * system (`world.process-plant.control.write` with a system actor, as a Scenario timeline writes a fault) — opens
 * the overview, plays at realtime and reads the display every 400 ms until `after` seconds past the upset.
 *
 * Checks (R2 gate unless marked):
 *   set-up         the injection was accepted and the element is demanded to run but does not (from the plant)
 *   needle-alert   the plant raises an alert on the element (the Pack must declare one; else nothing can frame it)
 *   needle-frame   within one sample of that alert, the element's drawn item is framed (an alert frame, not the
 *                  neutral dashed "expected" outline). Where the overview does not draw it (R2, lead ruling), a press
 *                  on its alert row opens its own detail, and there it is framed at the first read: one press from
 *                  the row. The script presses the row once, after the row check's window, reads the detail and goes
 *                  back; the overview's own tile for it is R3 (W2.2).
 *   needle-row     within one sample, its row stands above the expected aggregate row in the list
 *   needle-tile    (R3, W2.2) a category tile on the overview is lit for it, within one sample of its alert
 *   expiry         at the declared window (`--window`, s after the first-out) an expected SG low-low that still
 *                  stands leaves the aggregate within one sample: its own row shows and the aggregate count drops
 *   coverage       the share of the unit's alerts expected after a first-out, and how many name no observable
 *                  (coverage.ts on the copy at the end, and the sample's own `expected` marks)
 *
 * Writes <out>/<label>-needle.json and shots. Loopback only; no model is called. */
import { join } from 'node:path'
import { ensureChrome, loopbackOrigin, openPage, options, sleep } from './browser.ts'
import { readDisplay, readScreen, type DisplayState, type Screen } from './display-dom.ts'
import { goHome, homeOf, openOverview, press, screenOf, sizeSpec, targetsOf } from './display-press.ts'
import { createStackApi } from './stack-api.ts'

const ONE_SAMPLE_S = 2
const POLL_MS = 400

interface Poll { readonly wall: number; readonly simMs: number | null; readonly state: DisplayState; readonly screen: Screen }
const simOf = (state: DisplayState, day: string): number | null => {
  const match = state.sim?.match(/(\d{2}):(\d{2}):(\d{2})/)
  return match ? Date.parse(`${day}T${match[1]}:${match[2]}:${match[3]}.000Z`) : null
}
/** The alert list's rows in order, as the display shows them (on screen or not), with the aggregate's place. */
const listOf = (screen: Screen) => screen.lines.filter(line => line.region === 'alerts' && !/^alerts\b/i.test(line.text))
const aggregateIndex = (rows: ReadonlyArray<{ text: string }>) => rows.findIndex(row => /\d+\s+expected\b/i.test(row.text))
const aggregateCount = (rows: ReadonlyArray<{ text: string }>) => { const row = rows.find(entry => /\d+\s+expected\b/i.test(entry.text)); return row === undefined ? null : Number(row.text.match(/(\d+)\s+expected/i)![1]) }

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const origin = loopbackOrigin(argv.get('origin'))
  const workspaceId = argv.get('workspace'), from = argv.get('from'), out = argv.get('out')
  if (workspaceId === undefined || from === undefined || out === undefined) throw new Error('usage: needle.ts --origin=… --workspace=<id> --from=<paused Run at power> --out=<dir> (see the header)')
  const label = argv.get('label') ?? new URL(origin).port
  const port = Number(argv.get('port') ?? 44331)
  const unit = argv.get('unit') ?? 'Halden Unit 1', plantId = argv.get('plant') ?? 'plant:halden-1'
  const element = argv.get('element') ?? 'auxFeedwaterPumpMotor', name = argv.get('name') ?? 'MD AFW A'
  const windowS = Number(argv.get('window') ?? 300), afterS = Number(argv.get('after') ?? windowS + 30)
  const inject = argv.get('inject')
  const size = sizeSpec(argv.get('size') ?? '1920')
  const api = createStackApi(origin, workspaceId)
  const chrome = await ensureChrome({ port, profile: join(out, `chrome-${port}`) })
  const page = await openPage(port, size.width, size.height)
  const tag = `${label}-${size.name}`
  const shots: Record<string, string> = {}
  const shot = async (key: string) => { shots[key] = join(out, `${tag}-needle-${key}.png`); await page.shot(shots[key]!) }
  const polls: Poll[] = []
  const copy = await api.copy(from, `needle ${size.name} px · ${new Date().toISOString().slice(0, 19)}`)
  try {
    await api.load(copy)
    const day = String((await api.presence(copy)).execution.currentSimulationTime).slice(0, 10)
    const ref = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: copy }
    // ---- set the needle (before the fault) ----
    let setUp: { readonly how: string; readonly accepted: boolean; readonly reply: string } = { how: 'none', accepted: false, reply: 'no --inject given: the Pack offers no Instructor action that fails MD AFW A to start (see the report)' }
    if (inject !== undefined) {
      const [kind, rest] = [inject.slice(0, inject.indexOf(':')), inject.slice(inject.indexOf(':') + 1)]
      const reply = kind === 'action'
        ? await api.request(`/api/workspaces/${workspaceId}/capabilities/world.process-plant.action.invoke/invoke`, { resource: ref, actor: { kind: 'human', id: 'display-eval', displayName: 'Instructor (display evaluation)' }, input: { plantId, actionId: rest } }).catch(error => ({ error: String(error) }))
        : await api.request(`/api/workspaces/${workspaceId}/capabilities/world.process-plant.control.write/invoke`, { resource: ref, actor: { kind: 'system', id: 'display-eval', displayName: 'Scenario (display evaluation)' }, input: { plantId, path: rest.split('=')[0], value: JSON.parse(rest.split('=')[1]!) } }).catch(error => ({ error: String(error) }))
      setUp = { how: inject, accepted: reply?.result?.ok === true, reply: JSON.stringify(reply).slice(0, 400) }
    }
    console.log(`${tag} needle set-up: ${setUp.how} → ${setUp.accepted ? 'accepted' : 'not accepted'} ${setUp.accepted ? '' : setUp.reply.slice(0, 200)}`)
    await openOverview(page, { origin, workspaceId, runId: copy, unit, size })
    await shot('0-at-power')
    const known = new Set(((await api.objects(copy)).find(object => object.id === plantId)?.alerts ?? []).map((alert: any) => alert.id))
    const playSim = Date.parse((await api.presence(copy)).execution.currentSimulationTime)
    await api.playRealtime(copy)
    let upsetMs: number | null = null, firstOutMs: number | null = null, needleAlert: { readonly id: string; readonly message: string; readonly raisedMs: number } | null = null
    let elementState: Record<string, unknown> | null = null
    const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|${element}`, 'i')
    const framedNeedle = (poll: Pick<Poll, 'state'>) => poll.state.framed.find(item => item.item === element || nameRe.test(item.name))
    const rowAbove = (poll: Poll) => {
      const rows = listOf(poll.screen)
      const own = rows.findIndex(row => needleAlert !== null && row.text.includes(needleAlert.message.slice(0, 30)))
      const aggregate = aggregateIndex(rows)
      return own >= 0 && (aggregate < 0 || own < aggregate) && aggregate >= 0
    }
    // One press on the needle's alert row, as a person does: what it opens, and the needle's frame there at the first read.
    let detail: { readonly pressed: string; readonly outcome: string; readonly title: string | null; readonly tone: string | null; readonly readMs: number | null; readonly framedSimMs: number | null; readonly home: boolean } | null = null
    const pressRow = async (raisedMs: number, message: string) => {
      const home = homeOf(await screenOf(page))
      const words = message.slice(0, 30)
      const row = (await targetsOf(page)).find(target => target.kind === 'row' && target.name.includes(words))
      if (row === undefined) return { pressed: 'none', outcome: `no row naming "${words}" to press`, title: null, tone: null, readMs: null, framedSimMs: null, home: true }
      const pressed = await press(page, row)
      const started = Date.now()
      let found: { tone: string; simMs: number | null } | null = null
      for (let read = 0; read < 12 && found === null; read += 1) {
        const state = await page.eval<DisplayState>(readDisplay())
        const hit = framedNeedle({ state })
        if (hit !== undefined) found = { tone: hit.tone, simMs: simOf(state, day) }
        else await sleep(350)
      }
      await shot('needle-detail')
      const back = await goHome(page, home)
      const outcome = pressed.outcome
      return {
        pressed: row.name.slice(0, 120),
        outcome: outcome.kind === 'detail' ? `detail "${outcome.title ?? ''}"` : 'label' in outcome ? `${outcome.kind} "${outcome.label}"` : outcome.kind,
        title: outcome.kind === 'detail' ? outcome.title : null,
        tone: found?.tone ?? null, readMs: found === null ? null : Date.now() - started, framedSimMs: found?.simMs ?? null, home: back.home,
      }
    }
    let stopAt = Date.now() + (afterS + 120) * 1_000
    let lastApi = 0
    while (Date.now() < stopAt) {
      const state = await page.eval<DisplayState>(readDisplay())
      const screen = await page.eval<Screen>(readScreen())
      const simMs = simOf(state, day)
      polls.push({ wall: Date.now(), simMs, state, screen })
      if (Date.now() - lastApi > 1_000) {
        lastApi = Date.now()
        const plant = (await api.objects(copy)).find(object => object.id === plantId)
        const raised = (plant?.alerts ?? []).filter((alert: any) => !known.has(alert.id) && Date.parse(alert.raisedAt) >= playSim - 1_000)
        if (upsetMs === null && raised.length > 0) {
          upsetMs = Math.min(...raised.map((alert: any) => Date.parse(alert.raisedAt)))
          stopAt = Date.now() + afterS * 1_000
        }
        const firstOuts = raised.filter((alert: any) => alert.firstOut === true || /first.?out/i.test(String(alert.kind ?? '')) || alert.firstOut?.group !== undefined)
        if (firstOutMs === null && firstOuts.length > 0) firstOutMs = Math.min(...firstOuts.map((alert: any) => Date.parse(alert.raisedAt)))
        const onElement = raised.find((alert: any) => alert.subject?.element === element)
        if (needleAlert === null && onElement !== undefined) needleAlert = { id: String(onElement.id), message: String(onElement.message), raisedMs: Date.parse(onElement.raisedAt) }
      }
      if (upsetMs !== null && simMs !== null) {
        for (const [key, at] of [['1-first-sample', upsetMs], ['2-upset+60s', upsetMs + 60_000], ['3-before-expiry', (firstOutMs ?? upsetMs) + windowS * 1_000 - 5_000], ['4-after-expiry', (firstOutMs ?? upsetMs) + windowS * 1_000 + 5_000]] as const) {
          if (shots[key] === undefined && simMs >= at) await shot(key)
        }
        if (needleAlert !== null && shots['needle'] === undefined && simMs >= needleAlert.raisedMs) await shot('needle')
        // After the row check's window (its row above the aggregate, or 6 s on): the press, once.
        if (needleAlert !== null && detail === null && (rowAbove(polls.at(-1)!) || simMs >= needleAlert.raisedMs + 6_000) && simMs >= needleAlert.raisedMs + ONE_SAMPLE_S * 1_000) {
          detail = await pressRow(needleAlert.raisedMs, needleAlert.message)
        }
      }
      await sleep(POLL_MS)
    }
    await shot('5-end')
    // The element as the plant reads it at the end: demanded and running (signals of the Run, not the display).
    const variables = await api.request(`/api/workspaces/${workspaceId}/capabilities/world.process-plant.variables.read/invoke`, { resource: ref, actor: { kind: 'human', id: 'display-eval' }, input: { plantId, paths: [`${element}.running`, `${element}.runningState`] } }).catch(error => ({ error: String(error) }))
    elementState = variables?.result ?? variables
    await api.pause(copy)
    // Coverage on the copy at the end (coverage.ts: annunciator systems, expected after a first-out, no observable).
    const coverageFile = join(out, `${tag}-needle-coverage.json`)
    const coverage = Bun.spawnSync(['bun', join(import.meta.dir, 'coverage.ts'), `--origin=${origin}`, `--workspace=${workspaceId}`, `--run=${copy}`, `--out=${coverageFile}`], { stdout: 'pipe', stderr: 'pipe' })
    const coverageResult = coverage.exitCode === 0 ? JSON.parse(await Bun.file(coverageFile).text()) : null
    const unitCoverage = coverageResult?.units?.find((entry: any) => entry.plant === plantId) ?? null
    // The display's own expected marks: rows of the default's alerts view that carry `expected` (W2.3, R2).
    const fresh = await api.defaultView(copy, plantId).catch(() => null)
    const sample = fresh === null ? null : await api.sample(copy, fresh.state).catch(() => null)
    const sampleRows: ReadonlyArray<any> = sample?.alerts ?? []
    const marked = sampleRows.filter(row => row.expected !== undefined)

    // ---- checks ----
    const last = polls.at(-1)!
    const after = (ms: number | null) => ms === null ? [] : polls.filter(poll => poll.simMs !== null && poll.simMs >= ms)
    const drawnNeedle = (poll: Poll) => poll.screen.lines.some(line => line.region === 'drawing' && nameRe.test(line.text))
    const firstWithin = (condition: (poll: Poll) => boolean, from: number | null) => { const hit = after(from).find(condition); return hit === undefined || from === null ? null : (hit.simMs! - from) / 1000 }
    const frameLag = needleAlert === null ? null : firstWithin(poll => framedNeedle(poll) !== undefined, needleAlert.raisedMs)
    const rowLag = needleAlert === null ? null : firstWithin(rowAbove, needleAlert.raisedMs)
    const drawn = polls.some(drawnNeedle)
    const expiryAt = (firstOutMs ?? upsetMs ?? 0) + windowS * 1_000
    const beforeExpiry = polls.filter(poll => poll.simMs !== null && poll.simMs < expiryAt && poll.simMs >= expiryAt - 20_000).at(-1)
    const lowLowOwn = (poll: Poll) => listOf(poll.screen).some(row => /low-low level/i.test(row.text) && !/expected/i.test(row.text))
    const countBefore = beforeExpiry === undefined ? null : aggregateCount(listOf(beforeExpiry.screen))
    const expiryLag = firstWithin(poll => lowLowOwn(poll) && (countBefore === null || (aggregateCount(listOf(poll.screen)) ?? 0) < countBefore), expiryAt)
    const sawAggregate = polls.some(poll => aggregateIndex(listOf(poll.screen)) >= 0)
    const checks = [
      { id: 'set-up', release: 'R2', pass: setUp.accepted, detail: `${setUp.how}: ${setUp.accepted ? 'accepted' : setUp.reply.slice(0, 240)}; ${element} at the end: ${JSON.stringify(elementState).slice(0, 200)}` },
      { id: 'needle-alert', release: 'R2', pass: needleAlert !== null, detail: needleAlert === null ? `no alert on ${element} in the Run (the Pack declares none for a pump that does not start)` : `"${needleAlert.message}" raised ${new Date(needleAlert.raisedMs).toISOString().slice(11, 19)}` },
      {
        id: 'needle-frame', release: 'R2',
        pass: needleAlert === null ? false : drawn ? frameLag !== null && frameLag <= ONE_SAMPLE_S : detail !== null && detail.title !== null && detail.tone !== null,
        detail: needleAlert === null ? 'no alert, so no frame'
          : drawn ? (frameLag === null ? 'drawn on the overview, never framed' : `framed on the overview ${frameLag} s after its alert (${framedNeedle(after(needleAlert.raisedMs).find(poll => framedNeedle(poll))!)?.tone})`)
          : `${name} is not drawn on the overview (its tile there is R3, W2.2); one press on its row → ${detail === null ? 'never pressed' : `${detail.outcome}${detail.title === null ? ' (not its detail)' : ''}; ${detail.tone === null ? `${name} not framed there` : `framed ${detail.tone} at the first read${detail.framedSimMs === null ? '' : `, ${(detail.framedSimMs - needleAlert.raisedMs) / 1000} s of Run time after its alert`}`}; back home: ${detail.home}`}`,
      },
      { id: 'needle-row', release: 'R2', pass: needleAlert === null ? false : rowLag !== null && rowLag <= ONE_SAMPLE_S, detail: needleAlert === null ? 'no alert, so no row' : rowLag === null ? `its row never stood above an expected aggregate (aggregate ${sawAggregate ? 'seen' : 'never shown'})` : `above the aggregate ${rowLag} s after its alert` },
      { id: 'needle-tile', release: 'R3', pass: null, detail: 'category tiles are W2.2 (R3): not judged' },
      { id: 'expiry', release: 'R2', pass: sawAggregate && expiryLag !== null && expiryLag <= ONE_SAMPLE_S, detail: !sawAggregate ? 'no expected aggregate was ever shown' : `window ends ${new Date(expiryAt).toISOString().slice(11, 19)}; aggregate ${countBefore ?? '?'} before; an SG low-low ${expiryLag === null ? 'never left it' : `left it ${expiryLag} s after`}` },
      { id: 'coverage', release: 'R2', pass: null, detail: unitCoverage === null ? `coverage.ts failed: ${coverage.stderr.toString().slice(0, 200)}` : `${unitCoverage.alerts} alerts on ${plantId}: ${unitCoverage.expected.count} (${unitCoverage.expected.share} %) expected after a first-out by the Pack's rule, ${unitCoverage.noObservable.count} (${unitCoverage.noObservable.share} %) name no observable; the display's sample marks ${marked.length} of ${sampleRows.length} rows expected` },
    ]
    const result = {
      label, origin, from, copy, size, inject: inject ?? null, events: { playSim: new Date(playSim).toISOString(), upset: upsetMs && new Date(upsetMs).toISOString(), firstOut: firstOutMs && new Date(firstOutMs).toISOString(), needleAlert, expiryAt: new Date(expiryAt).toISOString() },
      checks, detail, coverage: unitCoverage === null ? null : { alerts: unitCoverage.alerts, expected: unitCoverage.expected, noObservable: unitCoverage.noObservable, systemResolves: unitCoverage.systemResolves, sampleMarked: marked.length, sampleRows: sampleRows.length },
      end: { alerts: last.state.alerts, framed: last.state.framed, rows: listOf(last.screen).map(row => row.text) },
      timeline: polls.filter((_, index) => index % 5 === 0).map(poll => ({ sim: poll.state.sim, rows: listOf(poll.screen).length, aggregate: aggregateCount(listOf(poll.screen)), framed: poll.state.framed.length, needle: framedNeedle(poll)?.tone ?? null })),
      shots, console: page.console.slice(-20),
    }
    await Bun.write(join(out, `${label}-needle.json`), JSON.stringify(result, null, 2))
    for (const check of checks) console.log(`${label} ${size.name} ${check.release} ${check.id.padEnd(13)} ${check.pass === null ? 'info' : check.pass ? 'PASS' : 'FAIL'}  ${check.detail.slice(0, 240)}`)
  } catch (error) {
    await page.shot(join(out, `${tag}-needle-failed.png`)).catch(() => undefined)
    throw error
  } finally {
    await api.pause(copy).catch(() => undefined)
    await page.close()
    if (chrome.started) await chrome.stop()
  }
}

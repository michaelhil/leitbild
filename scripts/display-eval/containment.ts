/** Containment acceptance (plan v5 §5.5): every value inside its box, in the unit overview's column and drawing and
 * in every drawn item's faceplate (the pop-over before R2), at each size of the rendering matrix; and the matrix's R2
 * rows (matrix.ts): the viewport rule, the CSF row, navigation, auto-pin and presses. Reusable every release.
 *
 *   bun scripts/display-eval/containment.ts --origin=http://127.0.0.1:<port> --workspace=<id> --run=<Run A> --out=<dir>
 *       [--steady=<Run B>] [--label=<stack>] [--sizes=1920,1046,1440,1280] [--port=<CDP port>] [--unit="Halden Unit 1"]
 *       [--plant=plant:halden-1] [--items=<n>] [--no-matrix] [--no-faceplates]
 *
 * A value fails when a box that hides overflow clips any of its text, when a drawn reading runs past the room its
 * drawing reserved for it, or when it stands sideways out of a box that scrolls (display-dom.ts): a faceplate's body
 * scrolled sideways, a window column scrolled out of a narrow window. A value below the fold of a box that scrolls
 * down (a tall faceplate's body) is counted apart, not failed, and so is a drawing reading sideways in the drawing's
 * own scroller while that shows its affordance (R2's edge fade and "drawing continues ›"; lead ruling, 23 Oct):
 * "behind the drawing's scroll affordance". Column and band values, the trip line, alerts and faceplates must be
 * fully in view, nothing sideways. Faceplates are opened one by one on every drawn item —
 * by its magnifier where it has one (R2: a body press opens the detail), else by a press on the item — and read once
 * their content has drawn. Faceplates are read at 1920 and 1046 only. The matrix rows: viewport and CSF row at
 * every size (on Run B too where --steady names it; the CSF width is judged on Run B at 1920), navigation and
 * presses at 1920 and 1046, auto-pin at 1046 (on its own copy with a seeded AI proposal; no model is called).
 * Writes <out>/<label>-containment.json and shots. Loopback only; the shared Runs are only read. */
import { join } from 'node:path'
import { ensureChrome, loopbackOrigin, openPage, options, sleep, type Page } from './browser.ts'
import { readDisplay, type DisplayState, type ValueBox } from './display-dom.ts'
import { goHome, homeOf, openOverview, press, screenOf, sizeSpec, targetsOf, type SizeSpec } from './display-press.ts'
import { autoPin, csfRow, navigation, presses, viewport, type MatrixCheck } from './matrix.ts'
import { createStackApi, type StackApi } from './stack-api.ts'

/** Clipped, run past its drawn room, or hidden sideways in a scrolling box (a 304 px pop-over or a 1046 px window
 * that scrolls its column away): not readable where it stands. Below the fold of a box that scrolls down is not. */
const FAILING: ReadonlyArray<string> = ['clipped', 'overrun', 'scrolled-x']
const failing = (values: ReadonlyArray<ValueBox>) => values.filter(value => FAILING.includes(value.status))
const count = (values: ReadonlyArray<ValueBox>, status: string) => values.filter(value => value.status === status).length
const summary = (values: ReadonlyArray<ValueBox>) => ({
  values: values.length,
  failing: failing(values).length,
  clipped: count(values, 'clipped'), overrun: count(values, 'overrun'), sideways: count(values, 'scrolled-x'), belowFold: count(values, 'scrolled-y'),
  // Drawing readings sideways in the drawing's scroller while it shows "drawing continues ›": reachable (lead ruling).
  behindAffordance: count(values, 'affordance'),
  byWhere: Object.fromEntries([...new Set(values.map(value => value.where))].map(where => [where, { values: values.filter(value => value.where === where).length, failing: failing(values.filter(value => value.where === where)).length }])),
})

/** Opens one drawn item's faceplate: its magnifier where it has one, else a press on its body; a body press that
 * opens the detail instead is undone (Back) and recorded. */
const openFaceplate = async (page: Page, home: ReturnType<typeof homeOf>, item: { readonly key: string; readonly name: string; readonly item: string | null }): Promise<{ readonly opened: boolean; readonly how: string }> => {
  const targets = await targetsOf(page)
  const body = targets.find(target => target.key === item.key)
  const magnifier = targets.find(target => target.kind === 'magnifier' && ((item.item !== null && target.item === item.item) || target.name.includes(item.name.split(' · ')[0]!)))
  const target = magnifier ?? body
  if (target === undefined) return { opened: false, how: 'not on screen' }
  // Scroll it into view first, as a person would (the press machinery presses where it stands).
  const { outcome } = await press(page, target, 2_500)
  if (outcome.kind === 'faceplate') {
    await page.until(`(() => { const s = ${readDisplay('popover')}; return s.popover !== null && s.popover.ready && !/Reading the element/.test(s.text) })()`, 15_000, 100).catch(() => undefined)
    await sleep(800)
    return { opened: true, how: magnifier ? 'magnifier' : 'body' }
  }
  if (outcome.kind !== 'nothing') await goHome(page, home)
  return { opened: false, how: `${magnifier ? 'magnifier' : 'body'} → ${outcome.kind}` }
}

const runSize = async (config: { origin: string; workspaceId: string; runId: string; steady: string | undefined; port: number; size: SizeSpec; out: string; label: string; unit: string; plantId: string; maxItems: number; matrix: boolean; faceplates: boolean; api: StackApi }) => {
  const { size, out, label } = config
  const tag = `${label}-${size.name}`
  const page = await openPage(config.port, size.width, size.height)
  try {
    const reopen = () => openOverview(page, { origin: config.origin, workspaceId: config.workspaceId, runId: config.runId, unit: config.unit, size })
    const screen = await reopen()
    await sleep(1_000)
    const home = homeOf(screen)
    const window = await page.eval<DisplayState>(readDisplay())
    await page.shot(join(out, `${tag}-window.png`))
    const matrix: MatrixCheck[] = []
    if (config.matrix) {
      matrix.push(viewport(window, await screenOf(page), size), csfRow(await screenOf(page), size, 'A'))
    }
    const faceplates: Array<Record<string, unknown>> = []
    let itemCount = 0
    if (config.faceplates && (size.name === '1920' || size.name === '1046')) {
      const items = (await targetsOf(page)).filter(target => target.kind === 'item').slice(0, config.maxItems)
      itemCount = items.length
      for (const [index, item] of items.entries()) {
        const { opened, how } = await openFaceplate(page, home, item)
        if (!opened) { faceplates.push({ item: item.name, opened: false, how }); continue }
        const state = await page.eval<DisplayState>(readDisplay('popover'))
        // The card's place (§5.5 faceplate row): inside the viewport, not over its item, no arrow, its height.
        const seen = await screenOf(page)
        const card = seen.dialogs.at(-1)
        const body = (await targetsOf(page)).find(target => target.key === item.key) ?? item
        const geometry = card === undefined ? null : {
          h: card.h, w: card.w, arrow: card.arrow === true, arrowParts: card.arrowParts ?? [],
          inViewport: card.x >= 0 && card.y >= 0 && card.x + card.w <= size.width && card.y + card.h <= size.height,
          coversItem: !(card.x + card.w <= body.x - body.w / 2 || card.x >= body.x + body.w / 2 || card.y + card.h <= body.y - body.h / 2 || card.y >= body.y + body.h / 2),
        }
        const bad = failing(state.values)
        const shot = bad.length > 0 ? join(out, `${tag}-faceplate-${String(index).padStart(2, '0')}.png`) : undefined
        if (shot !== undefined) await page.shot(shot)
        faceplates.push({ item: item.name, opened: true, how, title: state.popover?.title ?? null, geometry, ...summary(state.values), failingValues: bad, ...(shot === undefined ? {} : { shot }) })
        const back = await goHome(page, home)
        if (!back.home) await reopen()
      }
    }
    if (config.matrix && faceplates.length > 0) {
      // W3.2's acceptance: ≤ 300 px without a proposal for SG A, RCP A, PZR, the core and the PORV; every card in the
      // viewport, not over its item, with no arrow.
      const named = /^(Open\s+)?(Steam Generator A|SG A|Reactor Coolant Pump A|RCP A|Pressurizer|PZR|Reactor Core|Core|PORV)\b/i
      const opened = faceplates.filter(entry => entry.opened && entry.geometry !== null) as Array<{ item: string; geometry: { h: number; w: number; arrow: boolean; arrowParts: ReadonlyArray<string>; inViewport: boolean; coversItem: boolean } }>
      const tall = opened.filter(entry => named.test(entry.item) && entry.geometry.h > 300)
      const outside = opened.filter(entry => !entry.geometry.inViewport), covering = opened.filter(entry => entry.geometry.coversItem), arrows = opened.filter(entry => entry.geometry.arrow)
      matrix.push({ id: `faceplate-card-${size.name}`, release: 'R2', pass: opened.length > 0 && tall.length === 0 && outside.length === 0 && covering.length === 0 && arrows.length === 0,
        detail: `${opened.length} faceplates: ${tall.length === 0 ? 'the named five ≤ 300 px' : `taller than 300 px: ${tall.map(entry => `${entry.item.split(' · ')[0]} ${entry.geometry.h} px`).join(', ')}`}; ${outside.length} outside the viewport; ${covering.length} over their item; ${arrows.length} with an arrow at the card's edge${arrows.length === 0 ? '' : ` (${arrows.slice(0, 3).map(entry => `${entry.item.split(' · ')[0]}: ${entry.geometry.arrowParts.filter(part => part.endsWith('(at the edge)')).join(', ')}`).join('; ')})`}${(() => { const inner = [...new Set(opened.flatMap(entry => entry.geometry.arrowParts.filter(part => !part.endsWith('(at the edge)'))))]; return inner.length === 0 ? '' : ` (inside cards, not pointers: ${inner.slice(0, 4).join(', ')})` })()}; widths ${Math.min(...opened.map(entry => entry.geometry.w))}–${Math.max(...opened.map(entry => entry.geometry.w))} px` })
    }
    if (config.matrix && (size.name === '1920' || size.name === '1046')) {
      matrix.push(await navigation(page, home, reopen, join(out, `${tag}-navigation.png`)))
      matrix.push(...await presses(page, { api: config.api, runId: config.runId, plantId: config.plantId, home, reopen, chatOpen: size.chat, out, tag }))
    }
    if (config.matrix && size.name === '1046') {
      matrix.push(await autoPin(page, { api: config.api, origin: config.origin, workspaceId: config.workspaceId, runA: config.runId, plantId: config.plantId, unit: config.unit, size, shotPath: join(out, `${tag}-auto-pin.png`) }))
    }
    if (config.matrix && config.steady !== undefined) {
      const steadyScreen = await openOverview(page, { origin: config.origin, workspaceId: config.workspaceId, runId: config.steady, unit: config.unit, size })
      const steadyState = await page.eval<DisplayState>(readDisplay())
      await page.shot(join(out, `${tag}-steady-window.png`))
      matrix.push({ ...viewport(steadyState, steadyScreen, size, 0), id: `viewport-${size.name}-run-B` }, csfRow(steadyScreen, size, 'B'))
    }
    const total = (field: string) => faceplates.reduce((sum, entry) => sum + Number(entry[field] ?? 0), 0)
    const faceplateValues = total('values'), faceplateFailing = total('failing')
    // Every item a faceplate opens for (its magnifier) opens one; an item with no magnifier whose body opens its detail
    // (L3, Option A) is no failure.
    const containmentPass = failing(window.values).length === 0 && faceplateFailing === 0 && faceplates.every(entry => entry.opened || /^body → detail$/.test(String(entry.how)))
    return {
      size, displayWidth: window.frame?.width ?? null, generation: window.generation,
      window: { ...summary(window.values), failingValues: failing(window.values) },
      faceplates: { opened: faceplates.filter(entry => entry.opened).length, of: itemCount, values: faceplateValues, failing: faceplateFailing, clipped: total('clipped'), overrun: total('overrun'), sideways: total('sideways'), belowFold: total('belowFold'), withFailing: faceplates.filter(entry => Number(entry.failing ?? 0) > 0).length, items: faceplates },
      pass: containmentPass,
      matrix,
      console: page.console.slice(-20),
    }
  } catch (error) {
    await page.shot(join(out, `${tag}-failed.png`))
    throw error
  } finally {
    await page.close()
  }
}

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const origin = loopbackOrigin(argv.get('origin'))
  const workspaceId = argv.get('workspace'), runId = argv.get('run'), out = argv.get('out')
  if (workspaceId === undefined || runId === undefined || out === undefined) throw new Error('usage: containment.ts --origin=… --workspace=<id> --run=<Run A> --out=<dir> (see the header)')
  const label = argv.get('label') ?? new URL(origin).port
  const port = Number(argv.get('port') ?? 44333)
  const chrome = await ensureChrome({ port, profile: join(out, `chrome-${port}`) })
  const api = createStackApi(origin, workspaceId)
  const results: Array<Record<string, unknown>> = []
  try {
    for (const name of (argv.get('sizes') ?? '1920,1046,1440,1280').split(',')) {
      const size = sizeSpec(name)
      const result = await runSize({ origin, workspaceId, runId, steady: argv.get('steady'), port, size, out, label, unit: argv.get('unit') ?? 'Halden Unit 1', plantId: argv.get('plant') ?? 'plant:halden-1', maxItems: Number(argv.get('items') ?? 200), matrix: !argv.has('no-matrix'), faceplates: !argv.has('no-faceplates'), api })
      results.push(result)
      await Bun.write(join(out, `${label}-containment.json`), JSON.stringify({ label, origin, runId, steady: argv.get('steady') ?? null, results }, null, 2))
      const w = result.window, p = result.faceplates
      console.log(`${label} ${name} ${result.pass ? 'PASS' : 'FAIL'}  window ${w.failing}/${w.values} failing (clipped ${w.clipped}, overrun ${w.overrun}, sideways ${w.sideways}; ${w.belowFold} below the fold; ${w.behindAffordance} drawing readings behind the drawing's scroll affordance)${p.of > 0 ? `  faceplates ${p.failing}/${p.values} failing in ${p.withFailing} of ${p.opened} opened (${p.of} items; clipped ${p.clipped}, overrun ${p.overrun}, sideways ${p.sideways}, ${p.belowFold} below the fold)` : ''}`)
      for (const value of w.failingValues.slice(0, 8)) console.log(`   window ${value.where} "${value.label}" ${value.text} ${value.status} by ${value.by} ${value.px} px`)
      for (const check of result.matrix) console.log(`   ${check.release} ${check.id.padEnd(24)} ${check.pass === null ? 'info' : check.pass ? 'PASS' : 'FAIL'}  ${check.detail.slice(0, 230)}`)
    }
  } finally {
    if (chrome.started) await chrome.stop()
  }
}

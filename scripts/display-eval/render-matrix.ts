/** The rendering matrix (plan v5 §5.5), R3's rows, on any loopback stack: every size, day and dusk, Runs A and B,
 * the unit overview and the details a person opens from it. Interaction rows (faceplate, navigation, auto-pin,
 * presses) stay in containment.ts; the chat card at 480 px is chat-cards.ts.
 *
 *   bun scripts/display-eval/render-matrix.ts --origin=http://127.0.0.1:<port> --workspace=<id> --runA=<Run A> --runB=<Run B>
 *       --out=<dir> [--label=<stack>] [--sizes=1920,1440,1280,1046] [--themes=day,dusk] [--runs=A,B]
 *       [--details=Pressurizer,Steam Generator A,Reactor Core] [--port=<CDP port>] [--unit="Halden Unit 1"]
 *
 * For each view it shoots the screen (<out>/<label>-<size>-<theme>-<run>-<view>.png) and judges, as a person sees it:
 *   viewport, csf-row   (overview) leads, counts and 3 alert rows on screen; CSF chips on the title row, ≤ 560 px
 *   containment         every value inside its box (display-dom's value boxes)
 *   overlap             no text against text, a pipe, a symbol (drawing-geometry.ts: the display's own flowDrawing
 *                       for the view and sample, against the glyph boxes the page rendered)
 *   stubs, vessel-gap   every stopped pipe ends on ≥ 16 px of straight; a pipe into a vessel stops ≤ 1 px short of
 *                       what the vessel draws
 *   colour-at-rest      (Run B) no pixel of the theme's alarm, warning, caution or critical colour in the display frame
 *   trends              ≤ 2 path pieces per pen on Run B (steady); limit names in value order; no text colliding or
 *                       clipped in a plot; no legend name cut
 *   font                Noto Sans loaded and the drawing's text rendered in it; the composer's width for each drawn
 *                       line within 5 % of the rendered width (none wider than its estimate by more than 5 %)
 *   drawn-content       a sparkline in every lead row whose value has a series; a margin line (Run A); a stub reading
 *                       LIVE or DEAD (Run A); "<0 %" and a WR substitute wherever World's sample reads off span
 * Writes <out>/<label>-render-matrix.json. Loopback only; no model is called; nothing is operated. */
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ensureChrome, loopbackOrigin, openPage, options, sleep, type Page } from './browser.ts'
import { readDisplay, readScreen, type DisplayState, type Screen } from './display-dom.ts'
import { goHome, homeOf, openOverview, press, sizeSpec, targetsOf, type SizeSpec } from './display-press.ts'
import { judgeDrawing, topologyOf, type GeometryResult } from './drawing-geometry.ts'
import { csfRow, viewport, type MatrixCheck } from './matrix.ts'
import { colourScan } from './pixels.ts'
import { readColumn, readDrawing, readFonts, readTheme, readTrends, readWords, type ColumnRead, type FontsRead, type RenderedDrawing, type ThemeRead, type TrendsRead } from './render-checks.ts'
import { createStackApi, type StackApi } from './stack-api.ts'

const WORKTREE = new URL('../../', import.meta.url).pathname
type Theme = 'day' | 'dusk'
type RunName = 'A' | 'B'

/** The shown display's envelope state, from its frame's URL. */
const shownViewState = (page: Page): Promise<string | null> => page.eval<string | null>(`(() => {
  const docs = lb.documents().filter(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))
  const area = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }
  const shown = docs.sort((a, b) => area(b) - area(a))[0]
  const hash = shown && (shown.frame.getAttribute('src') || '').split('#view=')[1]
  if (!hash) return null
  try { return JSON.parse(decodeURIComponent(hash)).state ?? null } catch { return null }
})()`)

/** Day or dusk as a person picks it: the stored theme the Host and the embed read, and the matching media query. */
const setTheme = async (page: Page, origin: string, theme: Theme): Promise<void> => {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme === 'dusk' ? 'dark' : 'light' }] })
  await page.goto(`${origin}/`)
  await sleep(1_500)
  await page.eval(`localStorage.setItem('leitbild.theme', ${JSON.stringify(theme === 'dusk' ? 'dark' : 'light')})`)
}

/** The composer's width for a drawn text line: its own function where the worktree exports one, else its per-character width. */
const composerWidth = async (): Promise<{ readonly how: string; readonly of: (text: string, size: number, weight: number) => number }> => {
  const sizing: any = await import(`${WORKTREE}apps/world/src/features/displays/topology/flow-sizing.ts`)
  for (const name of ['textWidth', 'flowTextWidth', 'measureText', 'widthOf']) {
    if (typeof sizing[name] === 'function') return { how: `flow-sizing.${name}`, of: (text, size, weight) => Number(sizing[name](text, size, weight)) }
  }
  const per = Number(sizing.FLOW_TEXT_LINE?.perCharacter ?? 8)
  return { how: `flow-sizing FLOW_TEXT_LINE.perCharacter ${per} px`, of: text => text.length * per }
}

interface ViewResult {
  readonly size: string; readonly theme: Theme; readonly run: RunName; readonly view: string; readonly title: string | null; readonly shot: string
  readonly checks: ReadonlyArray<MatrixCheck>
  readonly data: { readonly geometry: GeometryResult | null; readonly trends: TrendsRead; readonly column: ColumnRead; readonly fonts: FontsRead | null; readonly theme: ThemeRead; readonly drawing: Pick<RenderedDrawing, 'found' | 'scale' | 'font'> }
}

const check = (id: string, pass: boolean | null, detail: string): MatrixCheck => ({ id, release: 'R3', pass, detail })
const listed = (items: ReadonlyArray<string>, n = 4) => items.length === 0 ? '' : `: ${items.slice(0, n).join('; ')}${items.length > n ? `; +${items.length - n} more` : ''}`

/** Judges the view on screen now. */
const judgeView = async (ctx: { readonly page: Page; readonly scratch: Page; readonly api: StackApi; readonly runId: string; readonly size: SizeSpec; readonly theme: Theme; readonly run: RunName; readonly view: string; readonly out: string; readonly label: string; readonly width: Awaited<ReturnType<typeof composerWidth>> }): Promise<ViewResult> => {
  const { page, scratch, api, size, theme, run, view } = ctx
  const state = await page.eval<DisplayState>(readDisplay())
  const screen = await page.eval<Screen>(readScreen())
  const shotPath = join(ctx.out, `${ctx.label}-${size.name}-${theme}-${run}-${view.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.png`)
  const png = (await page.send('Page.captureScreenshot', { format: 'png' })).data as string
  mkdirSync(ctx.out, { recursive: true })
  writeFileSync(shotPath, Buffer.from(png, 'base64'))
  const themeRead = await page.eval<ThemeRead>(readTheme())
  const rendered = await page.eval<RenderedDrawing>(readDrawing())
  const trends = await page.eval<TrendsRead>(readTrends())
  const column = await page.eval<ColumnRead>(readColumn())
  const fonts = await page.eval<FontsRead | null>(readFonts())
  const words = await page.eval<ReadonlyArray<{ where: string; text: string; lowIntegrity: boolean }>>(readWords())
  const viewState = await shownViewState(page)
  const compiled = viewState === null ? null : await api.view(ctx.runId, viewState).catch(() => null)
  const sample = viewState === null ? null : await api.sample(ctx.runId, viewState).catch(() => null)
  const checks: MatrixCheck[] = []

  if (view === 'overview') checks.push({ ...viewport(state, screen, size, run === 'B' ? 0 : 3), release: 'R3' }, { ...csfRow(screen, size, run), release: 'R3' })
  // Containment: every value inside its box.
  const bad = state.values.filter(value => value.status === 'clipped' || value.status === 'overrun' || value.status === 'scrolled-x')
  checks.push(check('containment', bad.length === 0, `${state.values.length - bad.length} of ${state.values.length} values inside their boxes${listed(bad.map(value => `${value.where} "${value.label}" ${value.text} ${value.status} by ${value.by ?? '?'} ${value.px ?? '?'} px`))}`))

  // The drawing: overlap, stubs, vessel gaps.
  const section = topologyOf(compiled)
  let geometry: GeometryResult | null = null
  if (rendered.found && section !== null) {
    geometry = await judgeDrawing(section, sample, rendered).catch(error => { checks.push(check('overlap', false, `the drawing could not be judged: ${String(error).slice(0, 200)}`)); return null })
    if (geometry !== null) {
      const against = [...geometry.textAgainstText.map(entry => `text × text ${entry}`), ...geometry.textAgainstPipe.map(entry => `text × pipe ${entry}`), ...geometry.textAgainstSymbol.map(entry => `text × symbol ${entry}`)]
      checks.push(check('overlap', against.length === 0, `${geometry.lines} drawn text lines (scale ${Math.round(rendered.scale * 100)} %): ${geometry.textAgainstText.length} against text, ${geometry.textAgainstPipe.length} against a pipe or bar, ${geometry.textAgainstSymbol.length} against a symbol${listed(against)}`))
      checks.push(check('stubs', geometry.stubs.short.length === 0, `${geometry.stubs.ends} stopped pipes, ${geometry.stubs.short.length} ending on less than ${geometry.stubs.stubStraight} px of straight${listed(geometry.stubs.short)}`))
      checks.push(check('vessel-gap', geometry.drawn.silhouettes === 0 ? null : geometry.vesselGaps.length === 0, geometry.drawn.silhouettes === 0 ? 'no vessel, tank or exchanger silhouette found in the drawing' : `${geometry.drawn.silhouettes} vessel silhouettes; ${geometry.vesselGaps.length} pipe ends stop more than 1 px short${listed(geometry.vesselGaps.map(gap => `${gap.silhouette} ${gap.gap} px at ${gap.at}`))}`))
    }
  } else if (view !== 'overview' || rendered.found) checks.push(check('overlap', null, rendered.found ? 'the view carries no topology section' : 'no flow drawing in this view'))

  // Colour at rest (Run B): no alert colour anywhere in the display frame.
  if (run === 'B' && themeRead.frame !== null) {
    const hits = await colourScan(scratch, png, themeRead.frame, themeRead.colours)
    const found = hits.filter(hit => hit.pixels > 3)
    checks.push(check('colour-at-rest', Object.keys(themeRead.colours).length === 0 ? null : found.length === 0, Object.keys(themeRead.colours).length === 0 ? 'the theme names no alert colours' : `${themeRead.theme ?? '?'} theme; ${hits.map(hit => `${hit.colour.replace(/^alert-|-color$/g, '')} ${hit.pixels} px`).join(', ')}${found.length === 0 ? '' : `; where: ${found.map(hit => `${hit.colour.replace(/^alert-|-color$/g, '')} at ${hit.cells.slice(0, 4).map(cell => `(${cell.x},${cell.y}) ${cell.pixels}`).join(' ')}`).join('; ')}`}`))
  }

  // Trends: pieces per pen (Run B), limit names in value order, no collisions or clipped texts, no legend name cut.
  if (trends.strips.length > 0) {
    const pieces = trends.strips.flatMap(strip => strip.pens.filter(pen => pen.pieces > 2).map(pen => `strip ${strip.index} ${pen.cls} ${pen.pieces} pieces`))
    const order: string[] = [], collide: string[] = [], clipped: string[] = []
    for (const strip of trends.strips) {
      const named = strip.texts.map(text => ({ ...text, value: Number((text.text.match(/(-?\d+(?:\.\d+)?)\s*$/) ?? [])[1]) })).filter(text => /\b(LO|HI|LOW|HIGH|TRIP|CTL|SP)\b/.test(text.text) && Number.isFinite(text.value))
      const byValue = [...named].sort((a, b) => b.value - a.value)
      for (let i = 1; i < byValue.length; i += 1) if (byValue[i]!.y + byValue[i]!.h / 2 < byValue[i - 1]!.y + byValue[i - 1]!.h / 2 - 1) order.push(`strip ${strip.index}: "${byValue[i]!.text}" above "${byValue[i - 1]!.text}"`)
      for (let i = 0; i < strip.texts.length; i += 1) for (let j = i + 1; j < strip.texts.length; j += 1) {
        const a = strip.texts[i]!, b = strip.texts[j]!
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ox > 1 && oy > 2) collide.push(`strip ${strip.index}: "${a.text}" × "${b.text}"`)
      }
      for (const text of strip.texts) if (text.x < -1 || text.y < -1 || text.x + text.w > strip.width + 1 || text.y + text.h > strip.height + 1) clipped.push(`strip ${strip.index}: "${text.text}"`)
    }
    const cut = trends.strips.flatMap(strip => strip.legend.filter(entry => entry.cut).map(entry => `strip ${strip.index}: "${entry.name}"`))
    if (run === 'B') checks.push(check('trend-pieces', pieces.length === 0, `${trends.strips.reduce((n, strip) => n + strip.pens.length, 0)} pens in ${trends.strips.length} strips; ${pieces.length} drawn in more than 2 pieces${listed(pieces)}`))
    checks.push(check('trend-labels', order.length + collide.length + clipped.length === 0, `limit names out of value order ${order.length}, texts colliding ${collide.length}, clipped ${clipped.length}${listed([...order, ...collide, ...clipped])}`))
    checks.push(check('trend-legend', cut.length === 0, `${trends.strips.reduce((n, strip) => n + strip.legend.length, 0)} legend entries, ${cut.length} cut${listed(cut)}`))
  }

  // Font: Noto Sans loaded and used; the composer's widths within 5 % of the rendered ones.
  if (fonts !== null && rendered.found) {
    const noto = fonts.faces.some(face => /noto sans/i.test(face.family) && face.status === 'loaded')
    const renders = [fonts.families.drawingName, fonts.families.drawingReading].every(family => family != null && /noto sans/i.test(family))
    checks.push(check('font-noto', noto && renders, `Noto Sans ${noto ? 'loaded' : 'not loaded'} (faces: ${[...new Set(fonts.faces.filter(face => face.status === 'loaded').map(face => face.family))].join(', ') || 'none loaded'}); drawing names in ${fonts.families.drawingName ?? '?'}, readings in ${fonts.families.drawingReading ?? '?'}`))
    const ratios = fonts.widths.map(line => ({ ...line, estimate: ctx.width.of(line.text, line.size, line.weight) })).filter(line => line.estimate > 0).map(line => ({ ...line, ratio: line.px / line.estimate }))
    const wider = ratios.filter(line => line.ratio > 1.05)
    const sorted = [...ratios].sort((a, b) => a.ratio - b.ratio)
    const median = sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]!.ratio
    checks.push(check('font-widths', ratios.length === 0 ? null : wider.length === 0 && median !== null && Math.abs(median - 1) <= 0.05, `${ratios.length} drawn lines against ${ctx.width.how}: median rendered/estimate ${median === null ? '-' : median.toFixed(3)}; ${wider.length} wider than the estimate by more than 5 %${listed(wider.sort((a, b) => b.ratio - a.ratio).map(line => `"${line.text}" ${line.size}px ${line.px} px vs ${Math.round(line.estimate)} (${Math.round((line.ratio - 1) * 100)} %)`))}`))
  }

  // Drawn content: sparklines on lead rows with a series; the margin line; LIVE/DEAD stubs; "<0 %" and WR.
  if (column.rows.length > 0) {
    const leadValues: ReadonlyArray<any> = Object.values(sample?.leads ?? {}).flat() as any[]
    const withSeries = new Set(leadValues.filter(value => value?.series !== undefined).map(value => String(value.label).split(' · ').slice(-2).join(' · ')))
    const seriesOf = (label: string) => [...withSeries].some(full => full.includes(label.replace(/\s*\.\.\.$|…$/, '')) || label.includes(full.split(' · ')[0]!))
    const missing = column.rows.filter(row => row.spark === null && (withSeries.size === 0 || seriesOf(row.label)))
    checks.push(check('sparklines', missing.length === 0, `${column.rows.length} lead rows, ${column.rows.filter(row => row.spark !== null).length} with a sparkline; ${withSeries.size} lead values with a series; without one${listed(missing.map(row => `"${row.label}"`), 6) || ': none'}`))
  }
  if (run === 'A' && view === 'overview') checks.push(check('margin-line', column.margins.length > 0, column.margins.length > 0 ? `"${column.margins.slice(0, 3).join('" · "')}"` : 'no margin line ("… above/below LO … ") in the display'))
  const live = words.filter(word => word.where === 'drawing' && /\b(LIVE|DEAD)\b/.test(word.text))
  if (run === 'A' && view !== 'overview') checks.push(check('stub-live-dead', null, live.length > 0 ? `${live.length} drawn items read LIVE/DEAD: ${live.slice(0, 4).map(word => `"${word.text}"`).join(', ')}` : 'no drawn item reads LIVE or DEAD here'))
  const offSpan = words.filter(word => /<\s?0\s?%|\bWR\s+-?\d/.test(word.text))
  if (offSpan.length > 0) checks.push(check('off-span', offSpan.every(word => !/<\s?0\s?%/.test(word.text) || word.lowIntegrity), `${offSpan.length} values read off span: ${offSpan.slice(0, 4).map(word => `${word.where} "${word.text.slice(0, 60)}"${word.lowIntegrity ? ' (low integrity)' : ''}`).join(', ')}`))

  return {
    size: size.name, theme, run, view, title: screen.window?.title ?? state.title, shot: shotPath, checks,
    data: { geometry, trends, column, fonts, theme: themeRead, drawing: { found: rendered.found, scale: rendered.scale, font: rendered.font } },
  }
}

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const origin = loopbackOrigin(argv.get('origin'))
  const workspaceId = argv.get('workspace'), runA = argv.get('runA'), runB = argv.get('runB'), out = argv.get('out')
  if (workspaceId === undefined || runA === undefined || runB === undefined || out === undefined) throw new Error('usage: render-matrix.ts --origin=… --workspace=<id> --runA=<Run A> --runB=<Run B> --out=<dir> (see the header)')
  const label = argv.get('label') ?? new URL(origin).port
  const port = Number(argv.get('port') ?? 44334)
  const unit = argv.get('unit') ?? 'Halden Unit 1'
  const sizes = (argv.get('sizes') ?? '1920,1440,1280,1046').split(',').map(sizeSpec)
  const themes = (argv.get('themes') ?? 'day,dusk').split(',') as Theme[]
  const runs = (argv.get('runs') ?? 'A,B').split(',') as RunName[]
  const details = (argv.get('details') ?? 'Pressurizer,Steam Generator A,Reactor Core').split(',').filter(Boolean)
  const api = createStackApi(origin, workspaceId)
  const chrome = await ensureChrome({ port, profile: join(out, `chrome-${port}`) })
  const scratch = await openPage(port, 400, 300)
  const width = await composerWidth()
  const results: ViewResult[] = []
  const save = () => Bun.write(join(out, `${label}-render-matrix.json`), JSON.stringify({ label, origin, runA, runB, composer: width.how, results }, null, 2))
  try {
    for (const size of sizes) for (const theme of themes) {
      const page = await openPage(port, size.width, size.height)
      try {
        await setTheme(page, origin, theme)
        for (const run of runs) {
          const runId = run === 'A' ? runA : runB
          await api.load(runId)
          const reopen = () => openOverview(page, { origin, workspaceId, runId, unit, size })
          const home = homeOf(await reopen())
          await sleep(1_000)
          const ctx = { page, scratch, api, runId, size, theme, run, out, label, width }
          const log = (result: ViewResult) => {
            results.push(result)
            for (const entry of result.checks) console.log(`${label} ${size.name} ${theme} ${run} ${result.view.padEnd(18)} ${entry.id.padEnd(15)} ${entry.pass === null ? 'info' : entry.pass ? 'PASS' : 'FAIL'}  ${entry.detail.slice(0, 220)}`)
          }
          log(await judgeView({ ...ctx, view: 'overview' }))
          await save()
          for (const name of details) {
            const target = (await targetsOf(page)).find(entry => entry.kind === 'item' && entry.name.toLowerCase().startsWith(name.toLowerCase()))
            if (target === undefined) { console.log(`${label} ${size.name} ${theme} ${run} ${name}: no item to press`); continue }
            const { outcome } = await press(page, target, 6_000)
            if (outcome.kind !== 'detail') { console.log(`${label} ${size.name} ${theme} ${run} ${name}: the body press opened ${outcome.kind}, not its detail`); await goHome(page, home); continue }
            await sleep(1_500)
            log(await judgeView({ ...ctx, view: name }))
            await save()
            const back = await goHome(page, home)
            if (!back.home) await reopen()
          }
        }
      } finally {
        await page.close()
      }
    }
  } finally {
    await save()
    await scratch.close()
    if (chrome.started) await chrome.stop()
  }
  // The rows of §5.5, over every view: how many views pass each.
  const ids = [...new Set(results.flatMap(result => result.checks.map(entry => entry.id)))]
  console.log('\n§5.5 R3 rows over all views (pass / judged; info rows not counted):')
  for (const id of ids) {
    const judged = results.flatMap(result => result.checks.filter(entry => entry.id === id && entry.pass !== null).map(entry => ({ result, entry })))
    const failed = judged.filter(({ entry }) => !entry.pass)
    console.log(`  ${id.padEnd(16)} ${judged.length - failed.length} / ${judged.length}${failed.length === 0 ? '' : `  failing: ${failed.slice(0, 6).map(({ result }) => `${result.size} ${result.theme} ${result.run} ${result.view}`).join('; ')}${failed.length > 6 ? ` +${failed.length - 6}` : ''}`}`)
  }
}

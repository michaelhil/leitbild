/** The R2 rows of the rendering matrix (plan v5 §5.5) that containment.ts runs beside its value containment:
 *
 *   viewport     leads, the alert count and 3 alert rows on screen (1046 with the chat open, 1280 × 800, 1440 × 900;
 *                1920 too)
 *   csf-row      the CSF and mode chips on the title row, ≤ 560 px at 1920 px while all are satisfied (Run B), and
 *                wrapping whole at 1280 and 1046 (no chip cut)
 *   navigation   a body press shows the element's default with its drawing as the next deck entry; Esc = Back
 *   auto-pin     "Review" from the proposals chip opens the proposal's faceplate pinned and open on its item
 *                (a seeded AI proposal on a copy: World's propose Capability with an AI actor, no model call)
 *   presses      chips open their targets; a label press opens its item; a stop with several far ends opens a
 *                chooser; a press in another frame closes an unpinned faceplate; a refused default is no button
 *
 * Each check returns pass/fail with its evidence; none changes a shared Run (auto-pin works on its own copy). */
import { join } from 'node:path'
import { sleep, type Page } from './browser.ts'
import { readDisplay, type DisplayState, type PressTarget, type Screen } from './display-dom.ts'
import { goHome, homeOf, openOverview, press, screenOf, targetsOf, type Outcome, type SizeSpec } from './display-press.ts'
import type { StackApi } from './stack-api.ts'

export interface MatrixCheck { readonly id: string; readonly release: 'R2' | 'R3'; readonly pass: boolean | null; readonly detail: string; readonly shot?: string }

/** The CSF chips (long labels before R2, the declared short labels SUBCRIT, CORE COOL, HEAT SINK, INTEGRITY, CTMT,
 * INVENTORY after) and the mode chip (its label before R2, its state word after). */
const CSF = /subcrit|core cool|heat sink|integrity|\bINTEG|containment(?! pressure)|\bCTMT\b|\bCONT\b|inventory|\bINV\b|operating mode|power operation|hot standby|hot shutdown|cold shutdown|startup|refuel|shutdown/i
const describe = (outcome: Outcome): string => outcome.kind === 'detail' ? `detail "${outcome.title ?? ''}" (${outcome.position ?? ''})` : 'label' in outcome ? `${outcome.kind} "${outcome.label.slice(0, 50)}"` : outcome.kind === 'changed' ? `changed: ${outcome.what.slice(0, 50)}` : outcome.kind

/** Viewport: every lead row's value, the alerts heading (its count) and at least three alert rows show on screen. */
export const viewport = (state: DisplayState, screen: Screen, size: SizeSpec, rowsWanted = 3): MatrixCheck => {
  const leadLines = state.leads.map(lead => ({ lead, line: screen.lines.find(line => line.text.startsWith(lead.label.slice(0, 18)) && line.region !== 'drawing') }))
  const leadsOn = leadLines.filter(entry => entry.line?.valueOn === true)
  const heading = screen.lines.find(line => line.region === 'alerts' && /^alerts\b|\d+\s+(alarms?|alerts?)\b/i.test(line.text))
  const rows = screen.lines.filter(line => line.region === 'alerts' && line.valueOn && line !== heading && !/^\+\s*\d+|more$/i.test(line.text))
  const pass = state.leads.length > 0 && leadsOn.length === state.leads.length && heading?.valueOn === true && rows.length >= rowsWanted
  return {
    id: `viewport-${size.name}`, release: 'R2', pass,
    detail: `${leadsOn.length} of ${state.leads.length} lead values on screen${leadsOn.length < state.leads.length ? ` (off: ${leadLines.filter(entry => entry.line?.valueOn !== true).slice(0, 4).map(entry => entry.lead.label).join(', ')})` : ''}; alerts heading ${heading === undefined ? 'absent' : heading.valueOn ? `"${heading.text}" on screen` : 'off screen'}; ${rows.length} alert rows on screen${rowsWanted < 3 ? ` (${rowsWanted} wanted: a steady Run)` : ''}; drawing: ${screen.lines.filter(line => line.region === 'drawing' && line.behind === true).length} lines behind its scroll affordance, ${screen.lines.filter(line => line.region === 'drawing' && !line.valueOn && line.behind !== true).length} out of view with none (display ${screen.frame?.w ?? '?'} px)`,
  }
}

/** CSF row: the chips' lines (on the title row where the title row holds them), their width, rows and whether each shows whole. */
export const csfRow = (screen: Screen, size: SizeSpec, run: 'A' | 'B'): MatrixCheck => {
  const title = screen.lines.find(line => line.region === 'header' && /^Halden Unit \d$|^[A-Z].{2,60}$/.test(line.text) && line.y < (screen.frame?.y ?? 0) + 40)
  const chips = screen.lines.filter(line => (line.region === 'chips' || line.region === 'header') && CSF.test(line.text))
  if (chips.length === 0) return { id: `csf-row-${size.name}-run-${run}`, release: 'R2', pass: false, detail: 'no CSF chips found' }
  const left = Math.min(...chips.map(chip => chip.x)), right = Math.max(...chips.map(chip => chip.x + chip.w))
  const tops = [...new Set(chips.map(chip => Math.round(chip.y / 6)))].length
  const cut = chips.filter(chip => !chip.on)
  const onTitleRow = title !== undefined && chips.some(chip => Math.abs(chip.y - title.y) <= 12)
  const width = Math.round(right - left)
  const widthOk = size.name !== '1920' || run !== 'B' || width <= 560
  return {
    id: `csf-row-${size.name}-run-${run}`, release: 'R2', pass: onTitleRow && widthOk && cut.length === 0,
    detail: `${chips.length} chips, ${width} px wide in ${tops} row${tops === 1 ? '' : 's'}; ${onTitleRow ? 'on the title row' : `not on the title row (title at y ${title?.y ?? '?'}, chips from y ${Math.min(...chips.map(chip => chip.y))})`}${cut.length > 0 ? `; cut: ${cut.slice(0, 4).map(chip => `"${chip.text.slice(0, 24)}"`).join(', ')}` : '; none cut'}${size.name === '1920' && run === 'B' ? `; ${width <= 560 ? '≤' : '>'} 560 px` : ''}`,
  }
}

/** The SG A item's body press: the element's default as the next deck entry with its drawing; Esc = Back. */
export const navigation = async (page: Page, home: ReturnType<typeof homeOf>, reopen: () => Promise<Screen>, shotPath: string): Promise<MatrixCheck> => {
  const targets = await targetsOf(page)
  const body = targets.find(target => target.kind === 'item' && /^(Open\s+)?(Steam Generator A|SG A)\b/i.test(target.name))
  if (body === undefined) return { id: 'navigation', release: 'R2', pass: false, detail: 'no SG A item on screen' }
  const before = home.position
  const { outcome, after } = await press(page, body)
  const drawing = after.lines.filter(line => line.region === 'drawing').length
  const next = (() => { const a = before?.match(/(\d+)\s*\/\s*(\d+)/), b = outcome.kind === 'detail' ? outcome.position?.match(/(\d+)\s*\/\s*(\d+)/) : null; return a && b ? Number(b[1]) === Number(a[1]) + 1 : false })()
  await page.shot(shotPath)
  let escaped = false, escTitle: string | null = null
  if (outcome.kind === 'detail') {
    await page.key('Escape')
    await sleep(1_200)
    const back = await screenOf(page)
    escTitle = back.window?.title ?? null
    escaped = escTitle === home.title
  }
  const restored = await goHome(page, home)
  if (!restored.home) await reopen()
  const pass = outcome.kind === 'detail' && /SG A|Steam Generator A/i.test(outcome.title ?? '') && drawing > 0 && next && escaped
  return { id: 'navigation', release: 'R2', pass, detail: `SG A body press → ${describe(outcome)}${outcome.kind === 'detail' ? `; ${drawing > 0 ? `with its drawing (${drawing} drawn lines)` : 'no drawing'}; ${next ? 'the next deck entry' : `not the next entry (from ${before})`}; Esc → "${escTitle ?? '?'}"${escaped ? ' (Back)' : ''}` : ''}`, shot: shotPath }
}

/** A point on the app's top bar (the Host page's own, 20 px down), outside the display window, on no control and no
 * frame: scanned along the bar from the middle outward, each candidate checked with elementFromPoint. */
const TOP_BAR_POINT = `(() => {
  const y = 20
  const mid = window.innerWidth / 2
  for (let step = 0; step < 40; step += 1) {
    const x = Math.round(mid + (step % 2 === 0 ? 1 : -1) * Math.ceil(step / 2) * 16)
    const el = document.elementFromPoint(x, y)
    if (el && !el.closest('button, a, input, select, textarea, iframe, [role=button], [role=link], [tabindex], [contenteditable=true]')) return { x, y }
  }
  return null
})()`

/** Presses: chips, a label, a stop with several far ends, a press in another frame, and refused defaults. */
export const presses = async (page: Page, config: { readonly api: StackApi; readonly runId: string; readonly plantId: string; readonly home: ReturnType<typeof homeOf>; readonly reopen: () => Promise<Screen>; readonly chatOpen: boolean; readonly out: string; readonly tag: string }): Promise<ReadonlyArray<MatrixCheck>> => {
  const { home, reopen } = config
  const restore = async () => { const back = await goHome(page, home); if (!back.home) await reopen() }
  const checks: MatrixCheck[] = []
  // Chips: each CSF or mode chip drawn as a button opens its target (W4.1: the deciding element). A chip with no
  // deciding element (the mode) is a plain chip, not a button (a refused default is not a button): reported apart.
  const allChips = (await targetsOf(page)).filter(target => target.kind === 'chip' && CSF.test(target.name))
  const chips = allChips.filter(target => target.pressable)
  const plain = allChips.filter(target => !target.pressable)
  const chipResults: string[] = []
  let chipsOpen = 0
  for (const chip of chips) {
    const now = (await targetsOf(page)).find(target => target.key === chip.key) ?? chip
    const { outcome } = await press(page, now)
    if (outcome.kind !== 'nothing') chipsOpen += 1
    chipResults.push(`"${chip.name.slice(0, 20)}" → ${describe(outcome)}`)
    if (outcome.kind !== 'nothing') await restore()
  }
  checks.push({ id: 'press-chips', release: 'R2', pass: chips.length > 0 && chipsOpen === chips.length, detail: `${chipsOpen} of ${chips.length} button chips open a target: ${chipResults.slice(0, 7).join('; ')}; ${plain.length} plain chips, not buttons (no deciding element)${plain.length === 0 ? '' : `: ${plain.map(chip => `"${chip.name.slice(0, 24)}"`).join(', ')}`}` })
  // A label press opens its item (as its body press does).
  const targets = await targetsOf(page)
  const label = targets.find(target => target.kind === 'label' && /^SG A$|^Steam Generator A$/i.test(target.name)) ?? targets.find(target => target.kind === 'label' && target.item !== null && targets.some(other => other.kind === 'item' && other.item === target.item))
  if (label === undefined) checks.push({ id: 'press-label', release: 'R2', pass: false, detail: 'no item label on screen' })
  else {
    const { outcome } = await press(page, label)
    checks.push({ id: 'press-label', release: 'R2', pass: outcome.kind === 'detail' || outcome.kind === 'faceplate', detail: `label "${label.name}" → ${describe(outcome)}` })
    if (outcome.kind !== 'nothing') await restore()
  }
  // A stop with several far ends opens a chooser.
  const stops = (await targetsOf(page)).filter(target => /,/.test(target.name) && (target.kind === 'label' || target.kind === 'item') && target.name.length < 80)
  const stop = stops.find(target => /ACC|PORV|check valve|safety valve/i.test(target.name)) ?? stops[0]
  if (stop === undefined) checks.push({ id: 'press-stop-chooser', release: 'R2', pass: false, detail: 'no stop naming several far ends on screen' })
  else {
    const { outcome, after } = await press(page, stop)
    const options = after.dialogs.length > 0 ? (await targetsOf(page)).filter(target => target.kind === 'control' || target.kind === 'item').filter(target => stop.name.split(/,\s*/).some(part => target.name.includes(part.trim()))).length : 0
    const pass = outcome.kind === 'chooser' || (outcome.kind === 'faceplate' && options >= 2)
    await page.shot(join(config.out, `${config.tag}-press-stop.png`))
    checks.push({ id: 'press-stop-chooser', release: 'R2', pass, detail: `stop "${stop.name}" → ${describe(outcome)}${outcome.kind === 'faceplate' ? ` (${options} of its far ends offered)` : ''}`, shot: join(config.out, `${config.tag}-press-stop.png`) })
    if (outcome.kind !== 'nothing') await restore()
  }
  // A press in another frame closes an unpinned faceplate: open one on SG A (its magnifier, else its body), then
  // press in the chat panel, or without the chat outside the display window on a part of the page that is no
  // control: the app's top bar (lead ruling: the window's title is its drag handle, and dragging keeps the faceplate).
  {
    const all = await targetsOf(page)
    const opener = all.find(target => target.kind === 'magnifier' && /SG A|Steam Generator A/i.test(target.name)) ?? all.find(target => target.kind === 'item' && /^(Open\s+)?(Steam Generator A|SG A)\b/i.test(target.name))
    if (opener === undefined) checks.push({ id: 'press-other-frame', release: 'R2', pass: false, detail: 'no SG A opener' })
    else {
      const opened = await press(page, opener)
      if (opened.outcome.kind !== 'faceplate') {
        checks.push({ id: 'press-other-frame', release: 'R2', pass: false, detail: `SG A ${opener.kind} → ${describe(opened.outcome)}: no faceplate to close` })
        await restore()
      } else {
        const elsewhere = config.chatOpen
          ? await page.eval<{ x: number; y: number } | null>(`(() => { const d = lb.documents().find(x => x.frame && /\\/agents/.test(x.frame.getAttribute('src') || '') && lb.shown(x.frame)); if (!d) return null; const r = d.frame.getBoundingClientRect(); let ox = 0, oy = 0; for (let f = d.frame.ownerDocument.defaultView.frameElement; f; f = f.ownerDocument.defaultView.frameElement) { const q = f.getBoundingClientRect(); ox += q.left; oy += q.top } return { x: ox + r.left + r.width / 2, y: oy + r.top + r.height * 0.4 } })()`)
          : await page.eval<{ x: number; y: number } | null>(TOP_BAR_POINT)
        if (elsewhere === null) checks.push({ id: 'press-other-frame', release: 'R2', pass: false, detail: 'no other frame to press' })
        else {
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: elsewhere.x, y: elsewhere.y })
          await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: elsewhere.x, y: elsewhere.y, button: 'left', clickCount: 1 })
          await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: elsewhere.x, y: elsewhere.y, button: 'left', clickCount: 1 })
          await sleep(1_000)
          const after = await screenOf(page)
          const still = after.dialogs.filter(dialog => !dialog.pinned).length
          checks.push({ id: 'press-other-frame', release: 'R2', pass: still === 0, detail: `faceplate "${'label' in opened.outcome ? opened.outcome.label.slice(0, 40) : ''}" ${still === 0 ? 'closed' : 'still open'} after a press in ${config.chatOpen ? 'the chat panel' : `the app's top bar (${Math.round(elsewhere.x)}, ${Math.round(elsewhere.y)})`}` })
        }
        await restore()
      }
    }
  }
  // A refused default is no button: every drawn element whose default World refuses must draw no button.
  {
    const viewState = await page.eval<string | null>(`(() => { const docs = lb.documents().filter(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame)); const area = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }; const shown = docs.sort((a, b) => area(b) - area(a))[0]; const hash = shown && (shown.frame.getAttribute('src') || '').split('#view=')[1]; if (!hash) return null; try { return JSON.parse(decodeURIComponent(hash)).state ?? null } catch { return null } })()`)
    const view = viewState === null ? null : await config.api.view(config.runId, viewState).catch(() => null)
    const nodes: ReadonlyArray<any> = (view?.sections ?? []).filter((section: any) => section.kind === 'topology').flatMap((section: any) => section.nodes ?? [])
    const elements = [...new Set(nodes.map(node => node.element).filter((element: unknown): element is string => typeof element === 'string'))]
    const refused: string[] = []
    for (const element of elements) {
      const ok = await config.api.defaultView(config.runId, `${config.plantId}#${element}`).then(() => true, () => false)
      if (!ok) refused.push(element)
    }
    const buttons = (await targetsOf(page)).filter(target => target.kind === 'item' || target.kind === 'magnifier')
    const nodeOf = new Map(nodes.map(node => [String(node.element ?? node.id), String(node.id)]))
    const offending = refused.filter(element => buttons.some(button => button.item === nodeOf.get(element) || button.item === element))
    checks.push({ id: 'press-refused-default', release: 'R2', pass: offending.length === 0, detail: `${elements.length} drawn elements, ${refused.length} with a default World refuses${refused.length > 0 ? ` (${refused.slice(0, 6).join(', ')})` : ''}; ${offending.length} of them drawn as buttons${offending.length > 0 ? `: ${offending.join(', ')}` : ''}` })
  }
  return checks
}

/** Auto-pin: on a copy with a seeded AI proposal, the chip's "Review" opens the proposal faceplate pinned and open on
 * its item, Approve on screen, not covering the item. */
export const autoPin = async (page: Page, config: { readonly api: StackApi; readonly origin: string; readonly workspaceId: string; readonly runA: string; readonly plantId: string; readonly unit: string; readonly size: SizeSpec; readonly shotPath: string }): Promise<MatrixCheck> => {
  const copy = await config.api.copy(config.runA, `auto-pin ${config.size.name} · ${new Date().toISOString().slice(0, 19)}`)
  await config.api.load(copy)
  const ref = { workspaceId: config.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: copy }
  const proposed = await config.api.request(`/api/workspaces/${config.workspaceId}/capabilities/world.process-plant.control.propose/invoke`, {
    resource: ref, actor: { kind: 'ai', id: 'display-eval', displayName: 'Display evaluation (seeded proposal)' },
    input: { plantId: config.plantId, tagId: 'AFW-A-CV', value: 0.4, reason: 'Seeded for the display evaluation: throttle AFW valve A to 40 % to hold SG A level.', evidence: ['AFW-A-CV'] },
  })
  if (proposed?.result?.ok !== true) return { id: 'auto-pin', release: 'R2', pass: false, detail: `the seeded proposal was refused: ${JSON.stringify(proposed).slice(0, 200)}` }
  await openOverview(page, { origin: config.origin, workspaceId: config.workspaceId, runId: copy, unit: config.unit, size: config.size })
  const chip = await page.waitFor({ sel: 'button', text: 'proposal' }, 15_000).catch(() => null)
  if (chip === null) return { id: 'auto-pin', release: 'R2', pass: false, detail: 'no proposals chip' }
  await page.click(chip)
  await sleep(600)
  const entry = await page.find({ sel: 'li button, [role=menuitem], [role=option]', text: 'THROTTLE' })
  if (entry !== null) await page.click(entry)
  // The review: the proposal faceplate, open and pinned, with Approve, beside its item.
  let found: { dialog: Screen['dialogs'][number] | null; approve: boolean; item: { x: number; y: number; w: number; h: number } | null } = { dialog: null, approve: false, item: null }
  for (let i = 0; i < 20 && (found.dialog === null || !found.approve); i += 1) {
    await sleep(500)
    const screen = await screenOf(page)
    const dialog = screen.dialogs.find(entry => /AFW valve A|Auxiliary Feedwater Valve A|proposal/i.test(entry.label)) ?? screen.dialogs[0] ?? null
    const approve = screen.lines.some(line => line.region === 'faceplate' && line.on && /^approve\b/i.test(line.text))
    const item = (await targetsOf(page)).find(target => target.kind === 'item' && /AFW valve A|Auxiliary Feedwater Valve A/i.test(target.name)) ?? null
    found = { dialog, approve, item }
  }
  await page.shot(config.shotPath)
  const { dialog, approve, item } = found
  const covers = dialog !== null && item !== null && !(dialog.x + dialog.w <= item.x - item.w / 2 || dialog.x >= item.x + item.w / 2 || dialog.y + dialog.h <= item.y - item.h / 2 || dialog.y >= item.y + item.h / 2)
  await config.api.pause(copy).catch(() => undefined)
  return {
    id: 'auto-pin', release: 'R2', pass: dialog !== null && dialog.pinned && approve && !covers,
    detail: dialog === null ? 'the review opened no faceplate (a person must find the item and press it)' : `faceplate "${dialog.label.slice(0, 50)}" ${dialog.pinned ? 'pinned' : 'not pinned'}, Approve ${approve ? 'on screen' : 'not on screen'}, ${item === null ? 'its item not drawn here' : covers ? 'covering its item' : 'beside its item'}`,
    shot: config.shotPath,
  }
}

/** Opens the overview for the matrix checks and returns its home, at a size. */
export const matrixHome = async (page: Page, config: { readonly origin: string; readonly workspaceId: string; readonly runId: string; readonly unit: string; readonly size: SizeSpec }) => {
  const reopen = () => openOverview(page, config)
  const screen = await reopen()
  const state = await page.eval<DisplayState>(readDisplay())
  return { screen, state, home: homeOf(screen), reopen }
}
export type { PressTarget }

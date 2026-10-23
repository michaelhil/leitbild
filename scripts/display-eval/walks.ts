/** Click-budget walks T1–T10 (plan v5 §5.4; the tasks of the ux audit, ux.md §2), scripted over CDP with no
 * Assistant and no procedure tag except in T4 and T7. Each walk records its clicks, the presses that opened nothing
 * (dead ends) and a verdict: ✔ done within its budget, ◐ done beyond it or only by a workaround, ✖ not possible in
 * the display window. The new display may have no ✖.
 *
 *   bun scripts/display-eval/walks.ts --origin=http://127.0.0.1:<port> --workspace=<id> --run=<Run A> --out=<dir>
 *       [--label=<stack>] [--tasks=T1,T2,…] [--port=<CDP port>] [--unit="Halden Unit 1"] [--plant=plant:halden-1]
 *
 * Every walk runs on its own paused copy of Run A ("walk <task> …"), so the shared Runs are never operated: T2 opens
 * the PORV and T3 approves a proposal there. T1 and T3 also run live (the copy playing at realtime).
 *
 * How a walk finds its way: from the unit overview it presses what a person would press, the most relevant first
 * (by the task's words), and reads what opened on screen (display-press.ts). A path that needs a second press is
 * replayed from the overview each time, so every count is from a cold start. Presses that operate the plant
 * (OPEN, SHUT, START, TRIP, RESET, Approve, …) are never made by a search, only by the walk that means to.
 *
 *   T1  MD AFW A's state in ≤ 2 clicks (also live)
 *   T2  "OPEN PORV-456A" in ≤ 5 actions from the overview
 *   T3  a seeded AI proposal (World's propose Capability with an AI actor: no model call): with the chat open and two
 *       faceplates pinned, Approve is on screen at 1046 px (1920 × 1080 + chat) and at 1440 × 900 + chat (live)
 *   T4  a procedure tag (E-0 step 3, DG-A) opens the element it is measured on (EDG A), and its "Open in display
 *       window" brings the window forward
 *   T5  the four units' SG levels compared (deck › three times; a side-by-side view is R4)
 *   T6  why a grid line alarms: the grid overview in the deck, an alarmed element pressed (grid buttons are R3, W9.1)
 *   T7  "Anything to worry about?": every cited key resolves. Needs an Assistant answer: reported as R3 (paired eval)
 *   T8  an alert row selects its element (faceplate or detail), and "+N more" opens the full list (L4)
 *   T9  overview → SG A → AFW header with one click per hop, then Esc = Back twice
 *   T10 the same gesture elsewhere: alert rows (T8) and drawn items on the plant; grid elements (R3, W9.1)
 *
 * Writes <out>/<label>-walks.json and shots. Loopback only; no model is called. */
import { join } from 'node:path'
import { ensureChrome, loopbackOrigin, openPage, options, sleep, type Page } from './browser.ts'
import { onScreen, type PressTarget, type Screen } from './display-dom.ts'
import { goHome, homeOf, openOverview, pageDialogs, press, screenOf, sizeSpec, targetsOf, type Home, type Outcome, type SizeSpec } from './display-press.ts'
import { createStackApi, type StackApi } from './stack-api.ts'

type Verdict = '✔' | '◐' | '✖' | 'R3' | 'n/a'
interface Step { readonly press: string; readonly kind: string; readonly outcome: string }
interface TaskResult {
  readonly id: string
  readonly title: string
  readonly verdict: Verdict
  readonly budget: number | null
  readonly clicks: number | null
  readonly path: ReadonlyArray<Step>
  readonly deadEnds: number
  readonly searched: number
  readonly detail: string
  readonly shots: ReadonlyArray<string>
  readonly live?: boolean
  readonly size?: string
}

/** Presses that operate the plant or the Run: never made by a search. */
const OPERATES = /^(OPEN|SHUT|CLOSE|START|STOP|TRIP|RESET|THROTTLE|RUN|ACTUATE|BLOCK|ARM|ENABLE|DISABLE|SET)\b|approve|reject|withdraw|extend|execute|\bsend\b|delete|remove|acknowledge|\back\b|shelve|suppress|slide/i
const describe = (outcome: Outcome): string => outcome.kind === 'detail' ? `detail "${outcome.title ?? ''}" (${outcome.position ?? ''})` : 'label' in outcome ? `${outcome.kind} "${outcome.label.slice(0, 60)}"` : outcome.kind === 'changed' ? `changed: ${outcome.what.slice(0, 60)}` : outcome.kind

interface Ctx {
  readonly page: Page
  readonly api: StackApi
  readonly origin: string
  readonly workspaceId: string
  readonly unit: string
  readonly plantId: string
  readonly out: string
  readonly label: string
  readonly runA: string
  /** One paused copy of Run A that the walks which only look share (made on first use). */
  shared?: string
}

/** A copy of Run A for a walk, opened at a size: its own when it operates or plays, else the shared one. */
const session = async (ctx: Ctx, task: string, size: SizeSpec, live = false, own = live): Promise<{ readonly runId: string; readonly home: Home; readonly reopen: () => Promise<Screen> }> => {
  const runId = own ? await ctx.api.copy(ctx.runA, `walk ${task} ${size.name} · ${new Date().toISOString().slice(0, 19)}`)
    : ctx.shared ??= await ctx.api.copy(ctx.runA, `walks (look only) · ${new Date().toISOString().slice(0, 19)}`)
  await ctx.api.load(runId)
  const reopen = () => openOverview(ctx.page, { origin: ctx.origin, workspaceId: ctx.workspaceId, runId, unit: ctx.unit, size })
  const screen = await reopen()
  if (live) await ctx.api.playRealtime(runId)
  return { runId, home: homeOf(screen), reopen }
}

/** Replays a path of target keys from the home view; false where a step's target is gone. */
const replay = async (ctx: Ctx, home: Home, reopen: () => Promise<Screen>, path: ReadonlyArray<PressTarget>): Promise<{ ok: boolean; after: Screen | null; outcome: Outcome | null }> => {
  const back = await goHome(ctx.page, home)
  if (!back.home) await reopen()
  let after: Screen | null = null, outcome: Outcome | null = null
  for (const step of path) {
    const now = (await targetsOf(ctx.page)).find(target => target.key === step.key) ?? (await targetsOf(ctx.page)).find(target => target.name === step.name)
    if (now === undefined) return { ok: false, after, outcome }
    const pressed = await press(ctx.page, now)
    after = pressed.after; outcome = pressed.outcome
  }
  return { ok: true, after, outcome }
}

/** Breadth-first search for a view where `goal` holds, pressing the most relevant targets first: up to `width[d]`
 * targets at depth d, never a press that operates. Each candidate is replayed from home. */
const search = async (ctx: Ctx, config: {
  readonly home: Home; readonly reopen: () => Promise<Screen>
  readonly goal: (screen: Screen) => string | null
  readonly rank: (target: PressTarget) => number
  readonly width: ReadonlyArray<number>
}): Promise<{ readonly path: ReadonlyArray<{ target: PressTarget; outcome: Outcome }> | null; readonly evidence: string | null; readonly searched: number; readonly deadEnds: number; readonly tried: ReadonlyArray<string> }> => {
  let frontier: Array<ReadonlyArray<{ target: PressTarget; outcome: Outcome }>> = [[]]
  let searched = 0, deadEnds = 0
  const tried: string[] = []
  for (const [depth, width] of config.width.entries()) {
    const next: Array<ReadonlyArray<{ target: PressTarget; outcome: Outcome }>> = []
    for (const parent of frontier) {
      const at = await replay(ctx, config.home, config.reopen, parent.map(step => step.target))
      if (!at.ok) continue
      const candidates = (await targetsOf(ctx.page)).filter(target => !OPERATES.test(target.name) && config.rank(target) > 0)
        .sort((a, b) => config.rank(b) - config.rank(a)).slice(0, width)
      for (const candidate of candidates) {
        const ready = depth === 0 ? { ok: true } : await replay(ctx, config.home, config.reopen, parent.map(step => step.target))
        if (!ready.ok) continue
        const target = (await targetsOf(ctx.page)).find(entry => entry.key === candidate.key) ?? candidate
        const { outcome, after } = await press(ctx.page, target)
        searched += 1
        tried.push(`${'  '.repeat(depth)}${target.kind} "${target.name.slice(0, 50)}" → ${describe(outcome)}`)
        if (outcome.kind === 'nothing') { deadEnds += 1; continue }
        const path = [...parent, { target, outcome }]
        const evidence = config.goal(after)
        if (evidence !== null) return { path, evidence, searched, deadEnds, tried }
        next.push(path)
        const back = await goHome(ctx.page, config.home)
        if (!back.home) await config.reopen()
      }
    }
    frontier = next
  }
  return { path: null, evidence: null, searched, deadEnds, tried }
}

const stepsOf = (path: ReadonlyArray<{ target: PressTarget; outcome: Outcome }>): ReadonlyArray<Step> => path.map(step => ({ press: step.target.name.slice(0, 80), kind: step.target.kind, outcome: describe(step.outcome) }))
const keywords = (...patterns: ReadonlyArray<[RegExp, number]>) => (target: PressTarget) => {
  let score = 0
  for (const [pattern, weight] of patterns) if (pattern.test(target.name)) score += weight
  // Items and their labels first, then rows and chips; the display's own chrome last.
  return score === 0 ? 0 : score + ({ item: 3, label: 2, magnifier: 2, row: 1, more: 1, chip: 1, control: 0, window: 0 } as Record<string, number>)[target.kind]!
}
/** A line naming the item with a state word, not a mixed group partly running. */
const stateOf = (screen: Screen, name: RegExp): string | null => {
  const line = onScreen(screen, name).find(entry => /\b(RUN(NING)?|STOP(PED)?|OFF|ON|STANDBY|TRIPPED)\b/.test(entry.text) && (() => {
    const count = entry.text.match(/(\d+)\/(\d+)/)
    const members = entry.text.split('/').length - 1
    return count === null || members <= 1 || count[1] === count[2] || count[1] === '0'
  })())
  return line === undefined ? null : line.text.slice(0, 120)
}
const shotOf = async (ctx: Ctx, name: string): Promise<string> => { const path = join(ctx.out, `${ctx.label}-walk-${name}.png`); await ctx.page.shot(path); return path }
const titleIs = (screen: Screen, pattern: RegExp) => pattern.test(screen.window?.title ?? '')

// ---------------- the tasks ----------------

const t1 = async (ctx: Ctx, live: boolean): Promise<TaskResult> => {
  const size = sizeSpec('1920')
  const { runId, home, reopen } = await session(ctx, live ? 'T1-live' : 'T1', size, live)
  try {
    const goal = (screen: Screen) => stateOf(screen, /\bMD AFW A\b|MD AFW A\/B|motor-driven auxiliary feedwater pump( A)?\b/i)
    const already = goal(await screenOf(ctx.page))
    if (already !== null) return { id: live ? 'T1-live' : 'T1', title: "MD AFW A's state in ≤ 2 clicks", verdict: '✔', budget: 2, clicks: 0, path: [], deadEnds: 0, searched: 0, detail: `at a glance: "${already}"`, shots: [await shotOf(ctx, live ? 'T1-live' : 'T1')], live }
    const found = await search(ctx, { home, reopen, goal, width: [10, 6, 4], rank: keywords([/MD AFW|AFW pump|auxiliary feedwater pump/i, 10], [/\bAFW\b|aux/i, 6], [/feed|SG [A-D]|steam generator/i, 2], [/bus [AB]|EDG|diesel/i, 1]) })
    const clicks = found.path?.length ?? null
    // Not found: the overview it started from, for the gallery's pair.
    if (found.path === null) await goHome(ctx.page, home)
    const shots = [await shotOf(ctx, live ? 'T1-live' : 'T1')]
    return {
      id: live ? 'T1-live' : 'T1', title: "MD AFW A's state in ≤ 2 clicks", live,
      verdict: clicks === null ? '✖' : clicks <= 2 ? '✔' : '◐', budget: 2, clicks, path: found.path === null ? [] : stepsOf(found.path), deadEnds: found.deadEnds, searched: found.searched,
      detail: found.evidence === null ? `MD AFW A's state not found within 3 presses (${found.searched} presses searched): ${found.tried.slice(0, 12).join('; ')}` : `"${found.evidence}"`, shots,
    }
  } finally { if (live) await ctx.api.pause(runId).catch(() => undefined) }
}

const t2 = async (ctx: Ctx): Promise<TaskResult> => {
  const { runId, home, reopen } = await session(ctx, 'T2', sizeSpec('1920'), false, true)
  // A view with the PORV's own OPEN command: a faceplate or detail of the PORV itself (PORV-456A), not its block
  // valve (the block's faceplate names PORV too, and its OPEN is disabled while the block stands open), with OPEN.
  const porvItself = (text: string) => /\bPORV\b(?!\s*block)|PORV-456A|power-operated relief valve(?!\s*block)/i.test(text) && !/\bblock\b/i.test(text)
  // Reached: the PORV's own faceplate (its controls, folded or not), or its detail with OPEN in its body.
  const goal = (screen: Screen) => {
    const faceplate = screen.dialogs.find(dialog => porvItself(dialog.label))
    if (faceplate !== undefined) return `the PORV's own faceplate (${faceplate.label.slice(0, 60)})`
    return porvItself(screen.window?.title ?? '') && onScreen(screen, /^OPEN\b/, ['body']).length > 0 ? `the PORV's detail with OPEN (${screen.window!.title!.slice(0, 60)})` : null
  }
  // Stops ("to PORV") are items: a stop opens its far end (W6.1). The PORV itself first, its block valve after.
  const found = await search(ctx, { home, reopen, goal, width: [10, 6, 4], rank: keywords([/\bPORV\b(?!\s*block)|PORV-456A/i, 12], [/\bPZR\b|pressuri[sz]er/i, 6], [/\bPORV block\b/i, 3], [/relief|safety valve/i, 1]) })
  if (found.path === null) {
    return { id: 'T2', title: '"OPEN PORV-456A" in ≤ 5 actions from the overview', verdict: '✖', budget: 5, clicks: null, path: [], deadEnds: found.deadEnds, searched: found.searched, detail: `no PORV control within 3 presses: ${found.tried.slice(0, 10).join('; ')}`, shots: [await shotOf(ctx, 'T2')] }
  }
  // Operate on this walk's own copy: OPEN, then the command's own execute button.
  const steps = [...stepsOf(found.path)]
  // Its OPEN, enabled (a disabled control is not listed), in the PORV's own faceplate or detail; where the faceplate
  // folds its controls ("Controls (n) ▸", W3.2), unfolding them is one more action.
  const openOf = async () => (await targetsOf(ctx.page)).find(target => /^OPEN\b/.test(target.name) && target.kind !== 'item' && target.pressable && target.reaches)
  let open = await openOf()
  if (open === undefined) {
    const fold = (await targetsOf(ctx.page)).find(target => target.kind === 'control' && /^Controls\b/i.test(target.name))
    if (fold !== undefined) {
      const unfolded = await press(ctx.page, fold)
      steps.push({ press: fold.name, kind: fold.kind, outcome: describe(unfolded.outcome) })
      open = await openOf()
    }
  }
  let opened = false, detail = ''
  if (open !== undefined) {
    const selected = await press(ctx.page, open)
    steps.push({ press: open.name, kind: open.kind, outcome: describe(selected.outcome) })
    await sleep(1_500)
    const executeOf = async () => (await targetsOf(ctx.page)).find(target => target.pressable && target.reaches && target.name !== open!.name && (/OPEN PORV|PORV-456A/i.test(target.name) || (target.kind === 'control' && /^(send|execute|confirm|apply)\b/i.test(target.name))))
    let execute = await executeOf()
    // A selection the faceplate folded away ("Controls (n) ▸" after OPEN): unfolding it is one more action.
    if (execute === undefined) {
      const fold = (await targetsOf(ctx.page)).find(target => target.kind === 'control' && /^Controls\b/i.test(target.name))
      if (fold !== undefined) {
        const unfolded = await press(ctx.page, fold)
        steps.push({ press: fold.name, kind: fold.kind, outcome: describe(unfolded.outcome) })
        execute = await executeOf()
      }
    }
    if (execute !== undefined) {
      const sent = await press(ctx.page, execute, 3_000)
      steps.push({ press: execute.name, kind: execute.kind, outcome: describe(sent.outcome) })
      await sleep(3_000)
      const status = onScreen(await screenOf(ctx.page), /accepted|travelling|done|OPEN since|refused|not followed/i, ['faceplate', 'body'])
      opened = status.some(line => !/refused|not followed/i.test(line.text))
      detail = status.map(line => line.text).join(' | ').slice(0, 200) || 'no feedback on screen'
    } else detail = `OPEN selected, but no execute button naming PORV-456A on screen (controls: ${(await targetsOf(ctx.page)).filter(target => target.kind === 'control').map(target => target.name.slice(0, 30)).slice(0, 12).join(' | ')})`
  } else detail = `the PORV's faceplate offers no enabled OPEN (controls: ${(await targetsOf(ctx.page)).filter(target => target.kind === 'control').map(target => target.name.slice(0, 30)).slice(0, 12).join(' | ')})`
  const clicks = steps.length
  const shots = [await shotOf(ctx, 'T2')]
  await ctx.api.pause(runId).catch(() => undefined)
  return { id: 'T2', title: '"OPEN PORV-456A" in ≤ 5 actions from the overview', verdict: !opened ? '✖' : clicks <= 5 ? '✔' : '◐', budget: 5, clicks: opened ? clicks : null, path: steps, deadEnds: found.deadEnds, searched: found.searched, detail, shots }
}

/** Seeds a pending AI proposal on a copy (World's propose Capability with an AI actor; no model is called). */
const seedProposal = async (ctx: Ctx, runId: string): Promise<string> => {
  const ref = { workspaceId: ctx.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId }
  const result = await ctx.api.request(`/api/workspaces/${ctx.workspaceId}/capabilities/world.process-plant.control.propose/invoke`, {
    resource: ref, actor: { kind: 'ai', id: 'display-eval', displayName: 'Display evaluation (seeded proposal)' },
    input: { plantId: ctx.plantId, tagId: 'AFW-A-CV', value: 0.4, reason: 'Seeded for the display evaluation: throttle AFW valve A to 40 % to hold SG A level.', evidence: ['AFW-A-CV'] },
  })
  if (result?.result?.ok !== true) throw new Error(`the seeded proposal was refused: ${JSON.stringify(result).slice(0, 300)}`)
  return String(result.result.commandId)
}

const where = (found: { whole: boolean; reaches: boolean } | null) => found === null ? 'not shown' : found.whole ? (found.reaches ? 'whole on screen and reachable' : 'on screen but covered') : 'below or beside the screen'

const t3 = async (ctx: Ctx, sizeName: string): Promise<TaskResult> => {
  const size = sizeSpec(sizeName)
  const id = `T3-${sizeName}`
  const runId = await ctx.api.copy(ctx.runA, `walk ${id} · ${new Date().toISOString().slice(0, 19)}`)
  await ctx.api.load(runId)
  await seedProposal(ctx, runId)
  const screen = await openOverview(ctx.page, { origin: ctx.origin, workspaceId: ctx.workspaceId, runId, unit: ctx.unit, size })
  await ctx.api.playRealtime(runId)
  const steps: Step[] = []
  const shots: string[] = []
  try {
    // The proposals chip in the window's header (Host side), then the entry that opens its review.
    const chip = await ctx.page.waitFor({ sel: 'button', text: 'proposal' }, 15_000).catch(() => null)
    if (chip === null) return { id, title: 'Approve on screen with the chat open and two faceplates pinned', verdict: '✖', budget: null, clicks: null, path: [], deadEnds: 0, searched: 0, detail: 'no proposals chip in the window header', shots: [await shotOf(ctx, id)], live: true, size: sizeName }
    const opened = await press(ctx.page, { x: chip.x + chip.w / 2, y: chip.y + chip.h / 2, name: chip.label })
    steps.push({ press: chip.label, kind: 'window', outcome: describe(opened.outcome) })
    // An entry naming the proposal (its word or item) in the chip's list, where the chip opens a list.
    // Its list (where the chip opens one) draws a moment later; press the chip again if it closed.
    const entryOf = () => ctx.page.waitFor({ sel: 'li button, [role=menuitem], [role=option]', text: 'THROTTLE' }, 4_000).catch(() => null)
    let entry = opened.outcome.kind === 'detail' ? null : await entryOf()
    if (entry === null && opened.outcome.kind !== 'detail') {
      await ctx.page.click(chip)
      steps.push({ press: chip.label, kind: 'window', outcome: 'pressed again: its list did not show' })
      entry = await entryOf()
    }
    if (entry !== null && opened.outcome.kind !== 'detail') {
      const reviewed = await press(ctx.page, { x: entry.x + entry.w / 2, y: entry.y + entry.h / 2, name: entry.label })
      steps.push({ press: entry.label.slice(0, 60), kind: 'window', outcome: describe(reviewed.outcome) })
    }
    await sleep(2_000)
    // Approve on screen? If not, open AFW valve A's faceplate (the item the proposal is on).
    const approveOnScreen = async () => ctx.page.eval<{ whole: boolean; reaches: boolean } | null>(`(() => {
      const el = lb.everything().map(([e]) => e).find(e => e.getAttribute && /^approve\\b/i.test((e.getAttribute('aria-label') || e.innerText || '').trim()) && lb.shown(e))
      if (!el) return null
      let ox = 0, oy = 0
      for (let f = el.ownerDocument.defaultView.frameElement; f; f = f.ownerDocument.defaultView.frameElement) { const r = f.getBoundingClientRect(); ox += r.left + f.clientLeft; oy += r.top + f.clientTop }
      const r = el.getBoundingClientRect()
      const whole = ox + r.left >= 0 && oy + r.top >= 0 && ox + r.right <= innerWidth && oy + r.bottom <= innerHeight
      const hit = el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { whole, reaches: !!hit && (hit === el || el.contains(hit) || (el.shadowRoot && el.shadowRoot.contains(hit))) }
    })()`)
    // The proposal card reads the pending proposals every 2 s: wait for it.
    const approveWithin = async (ms: number) => { const until = Date.now() + ms; for (;;) { const found = await approveOnScreen(); if (found !== null || Date.now() > until) return found; await sleep(400) } }
    let approve = await approveWithin(6_000)
    if (approve === null) {
      const item = (await targetsOf(ctx.page)).find(target => /AFW valve A|Auxiliary Feedwater Valve A/i.test(target.name) && (target.kind === 'magnifier' || target.kind === 'item'))
      if (item !== undefined) {
        const faceplate = await press(ctx.page, item)
        steps.push({ press: item.name, kind: item.kind, outcome: describe(faceplate.outcome) })
        approve = await approveWithin(6_000)
      }
    }
    const approveFirst = approve
    // Two faceplates pinned: the proposal's (if it has a pin) and one more (SG A's).
    const pins: string[] = []
    const pinOf = () => targetsOf(ctx.page).then(targets => targets.find(target => /^pin\b|pin (this|faceplate)|keep open/i.test(target.name)))
    const pin1 = await pinOf()
    if (pin1 !== undefined) { await press(ctx.page, pin1); pins.push(pin1.name); steps.push({ press: pin1.name, kind: pin1.kind, outcome: 'pinned' }) }
    const other = (await targetsOf(ctx.page)).find(target => /SG A|Steam Generator A/i.test(target.name) && target.kind === 'magnifier') ?? (await targetsOf(ctx.page)).find(target => /SG A|Steam Generator A/i.test(target.name) && target.kind === 'item')
    if (other !== undefined) {
      const second = await press(ctx.page, other)
      steps.push({ press: other.name, kind: other.kind, outcome: describe(second.outcome) })
      const pin2 = await pinOf()
      if (pin2 !== undefined && pin2.name !== pin1?.name) { await press(ctx.page, pin2); pins.push(pin2.name); steps.push({ press: pin2.name, kind: pin2.kind, outcome: 'pinned' }) }
    }
    approve = await approveOnScreen()
    shots.push(await shotOf(ctx, id))
    const pinnedNow = (await screenOf(ctx.page)).dialogs.filter(dialog => dialog.pinned).length
    const twoPinned = pins.length >= 2 || pinnedNow >= 2
    const reachable = (found: typeof approve) => found !== null && found.whole && found.reaches
    const verdict: Verdict = reachable(approve) && twoPinned ? '✔' : reachable(approve) || reachable(approveFirst) ? '◐' : '✖'
    return {
      id, title: 'Approve on screen with the chat open and two faceplates pinned', verdict, budget: null, clicks: steps.length, path: steps, deadEnds: 0, searched: 0, live: true, size: sizeName,
      detail: `display ${screen.frame?.w ?? '?'} px wide; after the review Approve ${where(approveFirst)}; with the second faceplate ${where(approve)}; ${pins.length} pin presses, ${pinnedNow} faceplates read as pinned${pins.length === 0 ? ' (no pin control)' : ''}`,
      shots,
    }
  } finally { await ctx.api.pause(runId).catch(() => undefined) }
}

const t4 = async (ctx: Ctx): Promise<TaskResult> => {
  const { runId } = await session(ctx, 'T4', sizeSpec('1920'))
  const steps: Step[] = []
  const expected = (await ctx.api.defaultView(runId, `${ctx.plantId}#dieselGeneratorA`)).view.title as string
  const procedures = await ctx.page.waitFor({ sel: 'button', text: `Computer-based procedures for ${ctx.unit}` }, 15_000).catch(() => null)
  if (procedures === null) return { id: 'T4', title: 'A procedure tag opens the element it is measured on', verdict: '✖', budget: null, clicks: null, path: [], deadEnds: 0, searched: 0, detail: 'no procedures button', shots: [] }
  await ctx.page.click(procedures)
  steps.push({ press: procedures.label.slice(0, 60), kind: 'window', outcome: 'procedures' })
  const tag = await ctx.page.waitFor({ sel: 'button', text: 'DG-A', exact: true }, 30_000).catch(() => null)
  if (tag === null) return { id: 'T4', title: 'A procedure tag opens the element it is measured on', verdict: '✖', budget: null, clicks: null, path: steps, deadEnds: 0, searched: 0, detail: 'no DG-A tag in E-0', shots: [await shotOf(ctx, 'T4')] }
  await ctx.page.click(tag)
  steps.push({ press: 'DG-A', kind: 'tag', outcome: 'pressed' })
  await sleep(4_000)
  // The display the tag shows: its title (a dialog's embed, or the window when the tag opens there directly).
  const titles = await ctx.page.eval<ReadonlyArray<{ title: string; inDialog: boolean }>>(`lb.documents().filter(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame)).map(d => ({ title: (d.doc.querySelector('article h1, h1')?.innerText || '').trim(), inDialog: !!d.frame.closest('[role=dialog]') }))`)
  const shown = titles.find(entry => entry.inDialog) ?? titles[0]
  const element = (title: string) => {
    const bare = title.replace(new RegExp(`^${ctx.unit} · `), '')
    return title === expected || /^(Emergency Diesel Generator A|EDG A)$/.test(bare)
  }
  const shots = [await shotOf(ctx, 'T4-tag')]
  // "Open in display window": the window then shows it, in front (no dialog over it).
  const openIn = await ctx.page.find({ sel: 'button', text: 'Open in display window' }) ?? await ctx.page.find({ sel: 'button', text: 'Open in the display window' })
  let forward = false, windowTitle: string | null = null
  if (openIn !== null) {
    await ctx.page.click(openIn)
    steps.push({ press: openIn.label.slice(0, 40), kind: 'dialog', outcome: 'pressed' })
    await sleep(3_000)
    const screen = await screenOf(ctx.page)
    windowTitle = screen.window?.title ?? null
    forward = (await pageDialogs(ctx.page)).length === 0
    shots.push(await shotOf(ctx, 'T4-window'))
  }
  const ok = shown !== undefined && element(shown.title)
  // Something about the element (an observable's display on it) is a workaround, not its element.
  const about = shown !== undefined && /Emergency Diesel Generator A|\bEDG A\b/.test(shown.title)
  return {
    id: 'T4', title: 'A procedure tag opens the element it is measured on', verdict: ok && forward ? '✔' : ok || about ? '◐' : '✖', budget: null, clicks: steps.length, path: steps, deadEnds: 0, searched: 0,
    detail: `the tag shows "${shown?.title ?? '(no display)'}" (World's element default: "${expected}"); "Open in display window" ${openIn === null ? 'not offered' : `→ window "${windowTitle ?? '?'}", ${forward ? 'in front' : 'still behind a dialog'}`}`,
    shots,
  }
}

const t5 = async (ctx: Ctx): Promise<TaskResult> => {
  await session(ctx, 'T5', sizeSpec('1920'))
  const steps: Step[] = []
  const levels: string[] = []
  for (let unit = 1; unit <= 4; unit += 1) {
    const screen = await screenOf(ctx.page)
    const sg = ['A', 'B', 'C', 'D'].map(letter => onScreen(screen, new RegExp(`^SG ${letter}\\b.*%`), ['drawing'])[0]?.text.match(/(\d+(\.\d+)?)\s*%/)?.[1] ?? '?')
    levels.push(`${screen.window?.title?.split(' · ')[0] ?? `unit ${unit}`}: ${sg.join(' / ')} %`)
    if (unit === 4) break
    const next = await ctx.page.find({ sel: 'button', text: 'Next display' })
    if (next === null) break
    const pressed = await press(ctx.page, { x: next.x + next.w / 2, y: next.y + next.h / 2, name: 'Next display' })
    steps.push({ press: 'Next display', kind: 'window', outcome: describe(pressed.outcome) })
  }
  const read = levels.filter(entry => !entry.includes('?')).length
  return { id: 'T5', title: "Compare the four units' SG levels", verdict: read === 4 ? '◐' : '✖', budget: null, clicks: steps.length, path: steps, deadEnds: 0, searched: 0, detail: `read one unit at a time, from memory (a side-by-side view is R4): ${levels.join('; ')}`, shots: [await shotOf(ctx, 'T5')] }
}

const t6 = async (ctx: Ctx): Promise<TaskResult> => {
  const { home } = await session(ctx, 'T6', sizeSpec('1920'))
  const steps: Step[] = []
  // The grid overview: the deck entry after the units (Previous from the first display wraps to it, else Next ×4).
  let screen = await screenOf(ctx.page)
  for (let i = 0; i < 5 && !/grid/i.test(screen.window?.title ?? ''); i += 1) {
    const next = await ctx.page.find({ sel: 'button', text: 'Next display' })
    if (next === null) break
    const pressed = await press(ctx.page, { x: next.x + next.w / 2, y: next.y + next.h / 2, name: 'Next display' })
    steps.push({ press: 'Next display', kind: 'window', outcome: describe(pressed.outcome) })
    screen = pressed.after
  }
  if (!/grid/i.test(screen.window?.title ?? '')) return { id: 'T6', title: 'Why a grid line alarms', verdict: '✖', budget: null, clicks: steps.length, path: steps, deadEnds: 0, searched: 0, detail: `no grid display in the deck (last: "${screen.window?.title ?? ''}")`, shots: [await shotOf(ctx, 'T6')] }
  const gridHome = homeOf(screen)
  const targets = (await targetsOf(ctx.page)).filter(target => !OPERATES.test(target.name))
  const drawn = targets.filter(target => target.kind === 'item' || target.kind === 'magnifier')
  const rows = targets.filter(target => target.kind === 'row')
  let opened: { target: PressTarget; outcome: Outcome } | null = null
  let dead = 0
  for (const target of [...drawn.slice(0, 4), ...rows.slice(0, 2)]) {
    const result = await press(ctx.page, target)
    if (result.outcome.kind === 'nothing') { dead += 1; continue }
    opened = { target, outcome: result.outcome }
    steps.push({ press: target.name.slice(0, 60), kind: target.kind, outcome: describe(result.outcome) })
    break
  }
  const shots = [await shotOf(ctx, 'T6')]
  await goHome(ctx.page, gridHome)
  await goHome(ctx.page, home)
  return { id: 'T6', title: 'Why a grid line alarms', verdict: opened === null ? '◐' : '✔', budget: null, clicks: steps.length, path: steps, deadEnds: dead, searched: Math.min(6, drawn.length + rows.length), detail: `grid overview reached; ${drawn.length} drawn grid elements and ${rows.length} alert rows can be pressed${opened === null ? '; none opens content (grid buttons: R3, W9.1); the main app\'s grid alarm list stays the route (◐, as on OLD)' : `; "${opened.target.name.slice(0, 50)}" opens ${describe(opened.outcome)}`}`, shots }
}

const t8 = async (ctx: Ctx): Promise<TaskResult> => {
  const { home, reopen } = await session(ctx, 'T8', sizeSpec('1920'))
  const steps: Step[] = []
  const targets = await targetsOf(ctx.page)
  const row = targets.find(target => target.kind === 'row' && /steam generator A|SG A/i.test(target.name)) ?? targets.find(target => target.kind === 'row' && !/first out|1st/i.test(target.name))
  let selected = false, rowDetail = 'no alert row on screen'
  if (row !== undefined) {
    const result = await press(ctx.page, row)
    steps.push({ press: row.name.slice(0, 60), kind: 'row', outcome: describe(result.outcome) })
    selected = result.outcome.kind === 'faceplate' || result.outcome.kind === 'detail'
    rowDetail = `row "${row.name.slice(0, 50)}" → ${describe(result.outcome)}`
    await goHome(ctx.page, home)
  }
  const more = (await targetsOf(ctx.page)).find(target => target.kind === 'more')
  let list = false, moreDetail = 'no "+N more" on screen'
  if (more !== undefined) {
    const result = await press(ctx.page, more)
    steps.push({ press: more.name, kind: 'more', outcome: describe(result.outcome) })
    list = result.outcome.kind === 'detail' && /alert/i.test(result.outcome.title ?? '')
    const rows = result.after.lines.filter(line => line.region === 'alerts' && line.valueOn).length
    moreDetail = `"${more.name}" → ${describe(result.outcome)}${list ? `, ${rows} rows on screen` : ''}`
  }
  const shots = [await shotOf(ctx, 'T8')]
  const back = await goHome(ctx.page, home)
  if (!back.home) await reopen()
  return { id: 'T8', title: 'An alert row selects its element; "+N more" opens the full list', verdict: selected && list ? '✔' : selected || list ? '◐' : '✖', budget: 2, clicks: steps.length, path: steps, deadEnds: steps.filter(step => step.outcome === 'nothing').length, searched: steps.length, detail: `${rowDetail}; ${moreDetail}`, shots }
}

const t9 = async (ctx: Ctx): Promise<TaskResult> => {
  const { home } = await session(ctx, 'T9', sizeSpec('1920'))
  const steps: Step[] = []
  const hop = async (name: RegExp, want: RegExp): Promise<boolean> => {
    const targets = await targetsOf(ctx.page)
    const body = targets.find(target => target.kind === 'item' && name.test(target.name)) ?? targets.find(target => target.kind === 'label' && name.test(target.name))
    if (body === undefined) { steps.push({ press: String(name), kind: '-', outcome: 'not on screen' }); return false }
    const result = await press(ctx.page, body)
    steps.push({ press: body.name.slice(0, 60), kind: body.kind, outcome: describe(result.outcome) })
    return result.outcome.kind === 'detail' && titleIs(result.after, want)
  }
  const first = await hop(/^(SG A|Steam Generator A)\b/i, /\bSG A\b|Steam Generator A/i)
  const second = first && await hop(/^(AFW header|Auxiliary Feedwater Header)\b/i, /AFW header|Auxiliary Feedwater Header/i)
  let escBack = 0
  if (first) {
    for (const want of second ? [/\bSG A\b|Steam Generator A/i, /Overview/] : [/Overview/]) {
      await ctx.page.key('Escape')
      await sleep(1_200)
      const screen = await screenOf(ctx.page)
      if (titleIs(screen, want)) escBack += 1
      steps.push({ press: 'Esc', kind: 'key', outcome: `window "${screen.window?.title ?? ''}"` })
    }
  }
  const shots = [await shotOf(ctx, 'T9')]
  await goHome(ctx.page, home)
  const verdict: Verdict = first && second && escBack === 2 ? '✔' : first ? '◐' : '✖'
  return { id: 'T9', title: 'Walk the plant: overview → SG A → AFW header, one click per hop; Esc = Back', verdict, budget: 2, clicks: steps.filter(step => step.kind !== 'key').length, path: steps, deadEnds: steps.filter(step => step.outcome === 'nothing').length, searched: steps.length, detail: `${first ? 'SG A opened as the next display' : 'a press on SG A does not open its detail'}${first ? `; ${second ? 'AFW header opened from it' : 'AFW header not opened from it'}` : ''}${first ? `; Esc returned ${escBack} of ${second ? 2 : 1} hops` : ''}`, shots }
}

const t10 = async (ctx: Ctx, t8Result: TaskResult | undefined, t6Result: TaskResult | undefined): Promise<TaskResult> => {
  // The plant side: every drawn item and alert row a person presses opens content (the E-0 sweep counts them all;
  // here the overview's items and rows once each), then the other Packs (grid: T6; Einsatz tables: no such Run here).
  const { home } = await session(ctx, 'T10', sizeSpec('1920'))
  const targets = (await targetsOf(ctx.page)).filter(target => ['item', 'label', 'row', 'more'].includes(target.kind) && !OPERATES.test(target.name))
  let opened = 0, dead = 0
  const nothing: string[] = []
  for (const target of targets) {
    const result = await press(ctx.page, target, 1_800)
    if (result.outcome.kind === 'nothing') { dead += 1; nothing.push(`${target.kind} "${target.name.slice(0, 30)}"`) } else opened += 1
    if (result.outcome.kind !== 'nothing') await goHome(ctx.page, home)
  }
  const plantOk = dead === 0
  return {
    id: 'T10', title: 'The same gesture everywhere: drawn items, labels, alert rows; grid elements', verdict: plantOk ? (t6Result?.verdict === '✔' ? '✔' : '◐') : '✖', budget: 1, clicks: 1, path: [], deadEnds: dead, searched: targets.length,
    detail: `plant overview: ${opened} of ${targets.length} items, labels and rows open content${dead > 0 ? `; open nothing: ${nothing.slice(0, 12).join(', ')}${nothing.length > 12 ? ` (+${nothing.length - 12})` : ''}` : ''}; alert row → ${t8Result?.detail.split(';')[0] ?? '(T8 not run)'}; grid: ${t6Result?.detail ?? '(T6 not run)'} (W9.1, R3); Einsatz table rows: no Einsatz Run on this stack (W9.2, R3)`,
    shots: [],
  }
}

const t7 = (): TaskResult => ({
  id: 'T7', title: '"Anything to worry about?": every cited key resolves', verdict: 'R3', budget: null, clicks: null, path: [], deadEnds: 0, searched: 0,
  detail: 'needs an Assistant answer with a vignette; no stored answer exists on these stacks and a paid call is not allowed here. Key resolution is W7.1 (R3); the paired eval at R3 (≤ USD 4) runs it',
  shots: [],
})

export const TASKS = ['T1', 'T1-live', 'T2', 'T3-1046', 'T3-1440x900+chat', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'] as const

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const origin = loopbackOrigin(argv.get('origin'))
  const workspaceId = argv.get('workspace'), runA = argv.get('run'), out = argv.get('out')
  if (workspaceId === undefined || runA === undefined || out === undefined) throw new Error('usage: walks.ts --origin=… --workspace=<id> --run=<Run A> --out=<dir> (see the header)')
  const label = argv.get('label') ?? new URL(origin).port
  const port = Number(argv.get('port') ?? 44336)
  const wanted = (argv.get('tasks') ?? TASKS.join(',')).split(',')
  const chrome = await ensureChrome({ port, profile: join(out, `chrome-${port}`) })
  const api = createStackApi(origin, workspaceId)
  const page = await openPage(port, 1920, 1080)
  const ctx: Ctx = { page, api, origin, workspaceId, unit: argv.get('unit') ?? 'Halden Unit 1', plantId: argv.get('plant') ?? 'plant:halden-1', out, label, runA }
  // A rerun of some tasks keeps the others' results in the same file.
  const file = join(out, `${label}-walks.json`)
  const earlier: ReadonlyArray<TaskResult> = await Bun.file(file).exists() ? (JSON.parse(await Bun.file(file).text()).results ?? []) : []
  const results: TaskResult[] = earlier.filter(result => !wanted.includes(result.id))
  const write = () => Bun.write(file, JSON.stringify({ label, origin, runA, results: [...results].sort((a, b) => TASKS.indexOf(a.id as typeof TASKS[number]) - TASKS.indexOf(b.id as typeof TASKS[number])), score: { done: results.filter(r => r.verdict === '✔').length, workaround: results.filter(r => r.verdict === '◐').length, failed: results.filter(r => r.verdict === '✖').length, r3: results.filter(r => r.verdict === 'R3').length } }, null, 2))
  try {
    for (const task of wanted) {
      const started = Date.now()
      let result: TaskResult
      try {
        result = task === 'T1' ? await t1(ctx, false) : task === 'T1-live' ? await t1(ctx, true) : task === 'T2' ? await t2(ctx)
          : task.startsWith('T3-') ? await t3(ctx, task.slice(3)) : task === 'T4' ? await t4(ctx) : task === 'T5' ? await t5(ctx) : task === 'T6' ? await t6(ctx)
            : task === 'T7' ? t7() : task === 'T8' ? await t8(ctx) : task === 'T9' ? await t9(ctx)
              : task === 'T10' ? await t10(ctx, results.find(r => r.id === 'T8'), results.find(r => r.id === 'T6')) : (() => { throw new Error(`unknown task ${task}`) })()
      } catch (error) {
        result = { id: task, title: '(walk failed to run)', verdict: '✖', budget: null, clicks: null, path: [], deadEnds: 0, searched: 0, detail: `the walk threw: ${String(error).slice(0, 300)}`, shots: [await shotOf(ctx, `${task}-failed`).catch(() => '')] }
      }
      results.push(result)
      await write()
      console.log(`${label} ${result.id.padEnd(17)} ${result.verdict}  clicks ${result.clicks ?? '-'}${result.budget === null ? '' : ` (budget ${result.budget})`}, dead ends ${result.deadEnds}, searched ${result.searched}, ${Math.round((Date.now() - started) / 1000)} s  ${result.detail.slice(0, 260)}`)
    }
  } finally {
    await page.close()
    if (chrome.started) await chrome.stop()
  }
}

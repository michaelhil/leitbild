/** Presses in the display window as a person does, and what came of each (plan v5 §3, §5.3, §5.4): the task scripts
 * (e0.ts, walks.ts, needle.ts) count clicks and dead ends with these. A press is a real mouse press at the target's
 * centre (CDP Input), never a DOM click, so a label that is not part of a button's target opens nothing, as it would
 * for a person. What came of it is read from the screen: the window moved to another display (a detail, L3, or an
 * alerts list, L4), a faceplate or chooser opened in the display, or nothing changed.
 *
 * Generation-agnostic by design: the markup changes between releases; the window's header (position word, title),
 * dialogs and on-screen text do not. */
import { sleep, type Page } from './browser.ts'
import { readScreen, readTargets, revealTarget, type PressTarget, type Screen } from './display-dom.ts'

export type Outcome =
  | { readonly kind: 'detail'; readonly title: string | null; readonly position: string | null }
  | { readonly kind: 'faceplate' | 'chooser'; readonly label: string }
  | { readonly kind: 'page-dialog'; readonly label: string }
  | { readonly kind: 'changed'; readonly what: string }
  | { readonly kind: 'nothing' }

export interface Press { readonly target: PressTarget; readonly outcome: Outcome; readonly ms: number }

/** An in-page read, tried again while a frame is between documents (a deck switch, a detail loading). */
const settled = async <T>(page: Page, expression: string): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try { return await page.eval<T>(expression) } catch (error) {
      if (attempt >= 4) throw error
      await sleep(400)
    }
  }
}
export const screenOf = (page: Page): Promise<Screen> => settled<Screen>(page, readScreen())
export const targetsOf = (page: Page): Promise<ReadonlyArray<PressTarget>> => settled<ReadonlyArray<PressTarget>>(page, readTargets())

/** Dialogs on the Run page itself (a tag dialog, the procedure window), outside the display frame. */
const PAGE_DIALOGS = `lb.everything().map(([el]) => el).filter(el => el.getAttribute && el.getAttribute('role') === 'dialog' && lb.shown(el) && !/\\/world\\/embed\\//.test(el.ownerDocument.location.pathname)).map(el => (el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').slice(0, 100))`
export const pageDialogs = (page: Page): Promise<ReadonlyArray<string>> => page.eval<ReadonlyArray<string>>(PAGE_DIALOGS)

const signature = (screen: Screen) => JSON.stringify({ w: screen.window && { p: screen.window.position, t: screen.window.title, s: screen.window.src }, d: screen.dialogs.map(d => d.label) })
const textOf = (screen: Screen) => screen.lines.filter(line => line.on).map(line => line.text).join('\n')
/** The screen's text with its numbers masked: what a press changed, not what a sample moved. */
const shapeOf = (screen: Screen) => textOf(screen).replace(/[\d.,:×⁻⁰¹²³⁴⁵⁶⁷⁸⁹−-]+/g, '#')

/** What a press changed, from the screens before and after it. */
export const classify = (before: Screen, after: Screen, pageBefore: ReadonlyArray<string>, pageAfter: ReadonlyArray<string>): Outcome => {
  const moved = before.window !== null && after.window !== null && (before.window.position !== after.window.position || before.window.title !== after.window.title || before.window.src !== after.window.src)
  if (moved) return { kind: 'detail', title: after.window!.title, position: after.window!.position }
  const opened = after.dialogs.filter(dialog => !before.dialogs.some(old => old.label === dialog.label && old.x === dialog.x && old.y === dialog.y))
  if (opened.length > 0) {
    const chooser = opened.find(dialog => /menu|listbox|choose|chooser|which/i.test(dialog.label))
    return chooser ? { kind: 'chooser', label: chooser.label } : { kind: 'faceplate', label: opened[0]!.label }
  }
  const newPage = pageAfter.filter(label => !pageBefore.includes(label))
  if (newPage.length > 0) return { kind: 'page-dialog', label: newPage[0]! }
  // New text, not a reading that moved (a playing Run changes its numbers every sample).
  const shape = (text: string) => text.replace(/[\d.,:×⁻⁰¹²³⁴⁵⁶⁷⁸⁹−-]+/g, '#')
  if (shapeOf(before) !== shapeOf(after)) {
    const added = after.lines.filter(line => line.on && !before.lines.some(old => old.on && shape(old.text) === shape(line.text))).map(line => line.text)
    if (added.length > 0) return { kind: 'changed', what: added.slice(0, 3).join(' | ').slice(0, 200) }
  }
  return { kind: 'nothing' }
}

/** Presses a target at its centre (a real mouse press) and waits for what it opens to settle: up to `waitMs` for
 * any change, then until the screen holds still for 500 ms (a faceplate reads its element first). */
export const press = async (page: Page, given: Pick<PressTarget, 'x' | 'y' | 'name'> & Partial<PressTarget>, waitMs = 2_500, modifiers = 0): Promise<{ outcome: Outcome; ms: number; after: Screen }> => {
  let target = given
  // Scrolled out of view (a 1046 px window scrolls its drawing): scroll it in first, as a person does.
  if (given.visible === false && given.kind !== undefined) {
    await page.eval(revealTarget({ kind: given.kind, name: given.name }))
    await sleep(300)
    target = (await targetsOf(page)).find(entry => entry.kind === given.kind && entry.name === given.name) ?? given
  }
  const before = await screenOf(page)
  const pageBefore = await pageDialogs(page)
  const started = Date.now()
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1, modifiers })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1, modifiers })
  let after = before
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(150)
    after = await screenOf(page)
    if (signature(after) !== signature(before) || shapeOf(after) !== shapeOf(before)) break
  }
  // Settle: the new view reads its element and draws.
  let last = signature(after) + shapeOf(after)
  for (let i = 0; i < 20; i += 1) {
    await sleep(300)
    const now = await screenOf(page)
    const sig = signature(now) + shapeOf(now)
    if (sig === last && !/Reading the element|Reading [^\n]{1,40}…|Loading|Composing|Connecting to the Run/i.test(textOf(now))) { after = now; break }
    last = sig
    after = now
  }
  return { outcome: classify(before, after, pageBefore, await pageDialogs(page)), ms: Date.now() - started, after }
}

/** The screen a walk starts from: its window header and no dialog open. */
export interface Home { readonly title: string | null; readonly position: string | null; readonly src: string | null }
export const homeOf = (screen: Screen): Home => ({ title: screen.window?.title ?? null, position: screen.window?.position ?? null, src: screen.window?.src ?? null })
/** Home: its title, the same place in the deck (a deck that kept a visited detail counts one more entry), no dialog. */
const placeOf = (position: string | null) => position?.match(/^\s*(\d+)/)?.[1] ?? position
const atHome = (screen: Screen, home: Home) => screen.window !== null && screen.window.title === home.title && placeOf(screen.window.position) === placeOf(home.position) && screen.dialogs.length === 0

/** Back to the home view: Escape (closes a faceplate, then Back), up to four times; then the window's Back or
 * "Previous display" while the position differs. True when home. Records how it got there. */
export const goHome = async (page: Page, home: Home): Promise<{ readonly home: boolean; readonly via: ReadonlyArray<string> }> => {
  const via: string[] = []
  const settledHome = async () => atHome(await screenOf(page), home) && (await pageDialogs(page)).length === 0
  for (let i = 0; i < 4; i += 1) {
    if (await settledHome()) return { home: true, via }
    await page.key('Escape')
    via.push('Esc')
    await sleep(500)
  }
  // A page window Esc does not close (the procedure window): its own close control, as a person closes it.
  for (let i = 0; i < 3 && (await pageDialogs(page)).length > 0; i += 1) {
    const close = await page.eval<{ x: number; y: number; label: string } | null>(PAGE_DIALOG_CLOSE)
    if (close === null) break
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) await page.send('Input.dispatchMouseEvent', { type, x: close.x, y: close.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
    via.push(close.label.slice(0, 30))
    await sleep(600)
  }
  for (let i = 0; i < 4; i += 1) {
    if (await settledHome()) return { home: true, via }
    const back = await page.find({ sel: 'button', text: 'Back' }) ?? await page.find({ sel: 'button', text: 'Previous display' })
    if (back === null) break
    await page.click(back)
    via.push(back.label.slice(0, 30))
    await sleep(800)
  }
  return { home: await settledHome(), via }
}
/** The close control of a dialog on the Run page outside the display (its button named "Close …"), at its centre. */
const PAGE_DIALOG_CLOSE = `(() => {
  const dialogs = lb.everything().map(([el]) => el).filter(el => el.getAttribute && el.getAttribute('role') === 'dialog' && lb.shown(el) && !/\\/world\\/embed\\//.test(el.ownerDocument.location.pathname))
  for (const dialog of dialogs.reverse()) {
    const button = [...dialog.querySelectorAll('button')].find(b => lb.shown(b) && /^close\\b/i.test((b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').trim()))
    if (!button) continue
    let x = 0, y = 0
    for (let f = button.ownerDocument.defaultView.frameElement; f; f = f.ownerDocument.defaultView.frameElement) { const q = f.getBoundingClientRect(); x += q.left + f.clientLeft; y += q.top + f.clientTop }
    const r = button.getBoundingClientRect()
    return { x: x + r.left + r.width / 2, y: y + r.top + r.height / 2, label: button.getAttribute('aria-label') || button.getAttribute('title') || 'Close' }
  }
  return null
})()`

/** A screen size of the rendering matrix (§5.5): the viewport and whether the Assistant's chat is open. The legacy
 * names stay: 1920 (1920 × 1080), 1046 (1920 × 1080 with the chat open, which leaves the display 1046 px), 1440
 * (1440 × 900) and 1280 (1280 × 800); any other is `<w>x<h>` with an optional `+chat`. */
export interface SizeSpec { readonly name: string; readonly width: number; readonly height: number; readonly chat: boolean }
export const sizeSpec = (name: string): SizeSpec => {
  const legacy: Record<string, SizeSpec> = {
    '1920': { name, width: 1920, height: 1080, chat: false },
    '1046': { name, width: 1920, height: 1080, chat: true },
    '1440': { name, width: 1440, height: 900, chat: false },
    '1280': { name, width: 1280, height: 800, chat: false },
  }
  if (legacy[name]) return legacy[name]!
  const match = name.match(/^(\d+)x(\d+)(\+chat)?$/)
  if (!match) throw new Error(`size ${name}: use 1920, 1046, 1440, 1280 or <w>x<h>[+chat]`)
  return { name, width: Number(match[1]), height: Number(match[2]), chat: match[3] !== undefined }
}

/** Opens the Workspace page on a Run at a size, the chat when the size asks for it, and the unit's overview from the
 * rail; resolves once the display has drawn its values and held still. */
export const openOverview = async (page: Page, config: { readonly origin: string; readonly workspaceId: string; readonly runId: string; readonly unit: string; readonly size: SizeSpec }): Promise<Screen> => {
  const { openUnitDisplay, readDisplay } = await import('./display-dom.ts')
  await page.size(config.size.width, config.size.height)
  await page.goto(`${config.origin}/workspaces/${config.workspaceId}?world=${encodeURIComponent(config.runId)}`)
  await page.waitFor({ sel: 'button', text: `Open process display for ${config.unit}` }, 120_000)
  await sleep(1_500)
  if (config.size.chat) {
    await page.click({ sel: 'button', text: 'Open Leitbild Assistant' })
    await page.until(`lb.documents().some(d => d.frame && /\\/agents/.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))`, 60_000)
    await sleep(2_000)
  }
  await openUnitDisplay(page, config.unit)
  await page.until(`(() => { const s = ${readDisplay()}; return s.generation !== 'none' && s.word !== null && s.values.length > 0 })()`, 120_000)
  await sleep(2_500)
  return screenOf(page)
}

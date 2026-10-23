/** Reads what the display window shows, in the page, for the acceptance scripts: the frame's clock word, the
 * worst chip, the lead rows, the alerts, the drawn items an alert frames, and every value with whether its box
 * holds it (plan v5 §5.1, §5.5). Two display generations are read: today's vignette (`display.vignette`, base and
 * later) and the pre-swap composed display (`process-plant.display`, OLD 724ae2ac8), each by its own markup.
 *
 * Containment: a value's text (every text node under it, through shadow roots and slots, not a hidden spacer) must
 * lie inside every ancestor that does not let overflow show, as CSS clips it (an absolutely placed box escapes the
 * ancestors below its containing block, a fixed one all but the viewport). Outside an ancestor that hides overflow
 * it is `clipped`; drawn in a flow drawing past the room the layout reserved for its text it is `overrun` (nothing
 * clips it, but it runs into whatever stands next to it). Outside a scrolling ancestor's view it is `scrolled-x`
 * or `scrolled-y`: there, but not readable without scrolling. The scripts fail clipped, overrun and scrolled-x (a
 * value hidden sideways: a pop-over's body scrolled sideways, a column scrolled out of a narrow window) and count
 * scrolled-y apart (a tall pop-over's body scrolls down by design). */

import type { Page } from './browser.ts'

/** Opens a unit's overview from the rail's monitor button and waits for its frame. A press the page takes before it
 * is ready opens nothing (seen on the pre-swap display), so it presses again, at most three times. */
export const openUnitDisplay = async (page: Page, unit: string): Promise<void> => {
  const shown = `lb.documents().some(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))`
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.click({ sel: 'button', text: `Open process display for ${unit}` })
    const opened = await page.until(shown, 15_000).then(() => true, () => false)
    if (opened) return
  }
  throw new Error(`three presses on "Open process display for ${unit}" opened no display`)
}

/** An expression for `Page.eval` (browser.ts): the shown display window's state, or the pop-over's when `scope` is 'popover'. */
export const readDisplay = (scope: 'window' | 'popover' = 'window'): string => `(${READER})(${JSON.stringify(scope)})`

/** `affordance`: sideways in the drawing's own scroller while it shows its affordance (R2 W4.3's edge fade and "drawing
 * continues ›"): reachable by that scroll (lead ruling, 23 Oct), reported apart, failing nothing. */
export type ValueStatus = 'ok' | 'clipped' | 'overrun' | 'scrolled-x' | 'scrolled-y' | 'affordance'
export interface ValueBox {
  readonly where: string
  readonly label: string
  readonly text: string
  readonly status: ValueStatus
  /** The ancestor that hides it, or the box it runs past. */
  readonly by?: string
  /** How far past, in px. */
  readonly px?: number
}
export interface DisplayState {
  readonly generation: 'vignette' | 'old' | 'none'
  readonly frame: { readonly width: number; readonly height: number } | null
  readonly title: string | null
  /** LIVE, PAUSED or FROZEN, as the frame says it. */
  readonly word: string | null
  readonly sim: string | null
  readonly worst: string | null
  readonly chips: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly leads: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly alerts: { readonly heading: string; readonly rows: ReadonlyArray<string>; readonly more: string | null } | null
  /** Drawn items framed or marked by an alert: their item ids, by tone. */
  readonly framed: ReadonlyArray<{ readonly item: string; readonly tone: string; readonly name: string }>
  /** Drawn symbols (devices, tanks, exchangers) drawing OpenBridge's alert frame. */
  readonly framedSymbols: number
  /** Drawn items outlined, not framed (R2, W2.3): "expected" (dashed: its active alerts are all expected after a
   * first-out), "abnormal" (a command not followed; it takes the place of the expected outline), "low-integrity". */
  readonly outlined: ReadonlyArray<{ readonly item: string; readonly kind: string; readonly name: string }>
  readonly values: ReadonlyArray<ValueBox>
  /** The drawing's and the frame's own text, for text checks (a trip line, "Rods on bottom"). */
  readonly text: string
  readonly popover: { readonly title: string; readonly ready: boolean } | null
}

const READER = `(scope) => {
  const lb = window.__lb
  const TOL = 0.5
  // A text box's height is its font's content area, which a tight line box may cut by a pixel or three without
  // touching a glyph: vertically only more than that counts.
  const TOL_Y = 3
  const docs = lb.documents().filter(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))
  // The display window's frame: the largest shown embed (a chat card or a dialog is smaller).
  const area = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }
  const shown = docs.sort((a, b) => area(b) - area(a))[0]
  const empty = { generation: 'none', frame: null, title: null, word: null, sim: null, worst: null, chips: [], leads: [], alerts: null, framed: [], framedSymbols: 0, outlined: [], values: [], text: '', popover: null }
  if (!shown) return empty
  const doc = shown.doc
  const win = doc.defaultView
  const frameRect = shown.frame.getBoundingClientRect()
  const text = el => (el ? (el.innerText ?? el.textContent ?? '') : '').replace(/\\s+/g, ' ').trim()
  const parentOf = n => n.assignedSlot ?? (n.parentNode instanceof win.ShadowRoot ? n.parentNode.host : n.parentNode)
  const describe = el => el.tagName.toLowerCase() + (el.classList && el.classList.length ? '.' + [...el.classList].filter(c => !c.startsWith('svelte-')).join('.') : '')
  // Every rendered text node under an element, through its shadow root and its light children; not a hidden width
  // spacer (OpenBridge's textbox reserves a value's width with invisible zeros) and not an SVG title.
  const hidden = el => { const s = win.getComputedStyle(el); return s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0 }
  const textNodes = root => {
    const out = []
    const walk = node => {
      if (!node) return
      if (node.nodeType === 3) { if (node.textContent.trim()) out.push(node); return }
      if (node.nodeType !== 1 && node.nodeType !== 11) return
      if (node.nodeType === 1 && (node.tagName.toLowerCase() === 'title' || hidden(node))) return
      if (node.nodeType === 1 && node.shadowRoot) walk(node.shadowRoot)
      for (const child of node.childNodes) walk(child)
    }
    walk(root)
    return out
  }
  const rectOf = node => { const range = doc.createRange(); range.selectNodeContents(node); const r = range.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null }
  const rank = { ok: 0, 'scrolled-y': 1, affordance: 1.5, 'scrolled-x': 2, overrun: 3, clipped: 4 }
  // The drawing's own scroller while it shows its affordance (R2 W4.3: an edge fade and "drawing continues ›" beside
  // it): a reading sideways in it is reachable by that scroll (lead ruling, 23 Oct). Column, band, trip line, alerts
  // and faceplates are never in it.
  const affordanceShown = el => !!el.parentElement && el.querySelector('.flow') !== null && [...el.parentElement.querySelectorAll(':scope > .continues, :scope > [data-continues]')].some(cue => !hidden(cue) && cue.getBoundingClientRect().width > 0)
  const deepText = el => textNodes(el).map(node => node.textContent).join(' ').replace(/\\s+/g, ' ').trim()
  // Where a text box stands against each ancestor that does not let overflow show. An ancestor that hides overflow
  // clips it; a scrolling one only hides it until scrolled, so outer ancestors then judge it as scrolled into view.
  // An absolutely placed box escapes the ancestors below its containing block, a fixed one all but the viewport.
  const contain = (node, start) => {
    let r = { left: start.left, right: start.right, top: start.top, bottom: start.bottom }
    let worst = { status: 'ok' }
    let escaping = null
    for (let el = parentOf(node); el && el.nodeType === 1; el = parentOf(el)) {
      const s = win.getComputedStyle(el)
      const root = el === doc.documentElement
      if (escaping === 'absolute' && s.position === 'static' && !root) continue
      if (escaping === 'fixed' && !root && s.transform === 'none' && s.filter === 'none') continue
      escaping = s.position === 'absolute' ? 'absolute' : s.position === 'fixed' ? 'fixed' : null
      if (s.display === 'contents') continue
      const box = el.getBoundingClientRect()
      const left = root ? 0 : box.left + el.clientLeft, top = root ? 0 : box.top + el.clientTop
      const right = root ? win.innerWidth : left + el.clientWidth, bottom = root ? win.innerHeight : top + el.clientHeight
      for (const [axis, overflow, lo, hi, a, b] of [['x', root ? 'auto' : s.overflowX, left, right, 'left', 'right'], ['y', root ? 'auto' : s.overflowY, top, bottom, 'top', 'bottom']]) {
        if (overflow === 'visible') continue
        const past = Math.max(lo - r[a], r[b] - hi)
        if (past <= (axis === 'y' ? TOL_Y : TOL)) continue
        if (overflow === 'hidden' || overflow === 'clip') return { status: 'clipped', by: describe(el), px: past }
        const status = axis === 'x' ? (affordanceShown(el) ? 'affordance' : 'scrolled-x') : 'scrolled-y'
        if (rank[status] > rank[worst.status]) worst = { status, by: describe(el), px: past }
        const size = Math.min(r[b] - r[a], hi - lo)
        r = { ...r, [a]: lo, [b]: lo + size }
      }
    }
    return worst
  }
  const valueBox = (el, where, label, reserved) => {
    let worst = { status: 'ok' }
    for (const node of textNodes(el)) {
      const r = rectOf(node)
      if (r === null) continue
      let found = contain(node, r)
      if (reserved) {
        const past = r.right - reserved.getBoundingClientRect().right
        if (past > TOL && rank.overrun > rank[found.status]) found = { status: 'overrun', by: describe(reserved), px: past }
      }
      if (rank[found.status] > rank[worst.status]) worst = found
    }
    return { where, label, text: deepText(el), status: worst.status, ...(worst.by ? { by: worst.by, px: Math.round(worst.px * 10) / 10 } : {}) }
  }
  const whereOf = el => el.closest('.popover, [role=dialog]') ? 'popover' : el.closest('.flow') ? 'drawing' : el.closest('.chips') ? 'chips' : el.closest('.legend') ? 'trend' : el.closest('.grouped') ? 'grouped' : el.closest('.column, .band') ? 'column' : 'section'

  if (doc.querySelector('article.vignette')) {
    const article = doc.querySelector('article.vignette')
    const footer = article.querySelector(':scope > footer')
    // The faceplate (R2's card) or the pop-over before it: the last opened dialog in the display.
    const pop = [...doc.querySelectorAll('.faceplate[role=dialog], .popover[role=dialog], [role=dialog]')].filter(el => lb.shown(el)).at(-1) ?? null
    const root = scope === 'popover' ? pop : article
    if (!root) return { ...empty, generation: 'vignette' }
    // A row's label as a person reads it: its visible (short, whole-word) label, else its full one (R3's readout-list
    // rows keep the full label visually hidden beside the short one).
    const labelOf = el => { const row = el.closest('.readout, .state, .values .row'); return text(row?.querySelector(':scope > .label')) || text(row?.querySelector(':scope > .full')) }
    const values = []
    for (const el of root.querySelectorAll('.readout > .reading, .state > obc-status-indicator, .state > .unknown, .values .row > obc-readout-list-item')) {
      if (scope === 'window' && el.closest('.popover, [role=dialog]')) continue
      values.push(valueBox(el, whereOf(el), labelOf(el)))
    }
    for (const el of root.querySelectorAll('.legend .now')) values.push(valueBox(el, 'trend', text(el.parentElement?.querySelector('.name'))))
    for (const el of root.querySelectorAll('.flow .text > span.reading, .flow .text > span.word, .flow .text > span.command')) {
      const box = el.closest('.text')
      values.push(valueBox(el, 'drawing', text(box.firstElementChild), box))
    }
    const sections = [...article.querySelectorAll('.section')].filter(s => !s.closest('.popover, [role=dialog]'))
    // Lead rows: a values section's rows, directly in it (R1) or in its .values block (R2's frame).
    // R3's column: obc-readout-list rows (.row) in the .values block.
    const ROWS = ':scope > .readout, :scope > .state, :scope > .values > .readout, :scope > .values > .state, :scope > .values > obc-readout-list > .row'
    const leadSection = sections.find(s => s.querySelector(ROWS))
    const leads = leadSection ? [...leadSection.querySelectorAll(ROWS)].map(row => ({ label: text(row.querySelector(':scope > .label')) || text(row.querySelector(':scope > .full')) || text(row).slice(0, 60), value: deepText(row.querySelector(':scope > .reading, :scope > obc-status-indicator, :scope > .unknown, :scope > obc-readout-list-item') ?? row.querySelector('obc-readout-list-item, obc-status-indicator, .reading') ?? doc.createElement('i')) })) : []
    const alertsSection = [...article.querySelectorAll('section.alerts')].find(s => !s.closest('.popover, [role=dialog]'))
    const framed = [...article.querySelectorAll('.flow .text')].filter(t => ['caution', 'warning', 'alarm', 'critical'].some(c => t.classList.contains(c)))
      .map(t => ({ item: t.dataset.item, tone: ['critical', 'alarm', 'warning', 'caution'].find(c => t.classList.contains(c)), name: text(t.firstElementChild) }))
    const framedSymbols = [...article.querySelectorAll('.flow obc-automation-button, .flow obc-automation-tank, .flow obc-heat-exchanger')].filter(el => el.alert === true).length
    // An item's outline is drawn right after its text block (FlowTopology): the block names the item.
    const outlined = [...article.querySelectorAll('.flow div.outline')].map(outline => {
      const block = outline.previousElementSibling
      if (!block || !block.matches('.text[data-item]')) return null
      return { item: block.dataset.item, kind: ['expected', 'abnormal', 'low-integrity'].find(c => outline.classList.contains(c)) || 'other', name: text(block.firstElementChild) }
    }).filter(Boolean)
    const clock = footer?.querySelector('.clock')
    const sim = [...(footer?.querySelectorAll(':scope > span') ?? [])].map(text).find(t => /^(sim|wall) /.test(t)) ?? null
    return {
      generation: 'vignette',
      frame: { width: Math.round(frameRect.width), height: Math.round(frameRect.height) },
      title: text(article.querySelector(':scope > header h1')),
      word: clock ? text(clock) : null,
      sim,
      // The worst chip: the header's chip that names no state (own-state chips carry an aria-label "name: state"). R2
      // draws it as a button (it opens every alert, by category) inside a listitem of .states; a frame with no alert
      // press draws it as a span.
      worst: text(article.querySelector(':scope > header .chip:not([aria-label])')) || null,
      chips: [
        ...[...article.querySelectorAll(':scope > .chips > .state')].map(chip => ({ label: text(chip.querySelector('.label')), value: deepText(chip.querySelector('obc-status-indicator, .unknown') ?? doc.createElement('i')) })),
        ...[...article.querySelectorAll(':scope > header .chip[aria-label]')].map(chip => ({ label: (chip.getAttribute('aria-label') || '').split(':')[0].trim(), value: text(chip) })),
      ],
      leads,
      alerts: alertsSection ? { heading: text(alertsSection.querySelector('h2')), rows: [...alertsSection.querySelectorAll('li')].map(text), more: text(alertsSection.querySelector('.more')) || null } : null,
      framed, framedSymbols, outlined,
      values,
      text: text(article),
      popover: pop ? { title: pop.getAttribute('aria-label') || '', ready: pop.querySelector('.section') !== null } : null,
    }
  }

  if (doc.querySelector('article.card')) {
    // The pre-swap composed display (OLD): its banner, state chip, lead column, alarm list, mimic and quick looks.
    const card = doc.querySelector('article.card')
    const look = doc.querySelector('.popover[aria-label]')
    const root = scope === 'popover' ? look : card
    if (!root) return { ...empty, generation: 'old' }
    const values = []
    // Lead readouts, the mimic's value and state rows, a quick look's values (ul.rows) and a faceplate's cells.
    for (const el of root.querySelectorAll('ul.readouts .reading, ul.readouts .state, .value-row, .state-row, ul.rows .value, li.line .reading, li.line obc-status-indicator')) {
      if (scope === 'window' && el.closest('.popover, [role=dialog]')) continue
      const where = el.closest('.popover, [role=dialog]') ? 'popover' : el.closest('.mimic-panel') ? 'drawing' : el.closest('ul.readouts') ? 'column' : 'card'
      const label = text(el.closest('li')?.querySelector('.head .name, :scope > .name, .tag') ?? el.closest('.stack')?.querySelector('.tag'))
      values.push(valueBox(el, where, label, where === 'drawing' ? el.closest('.stack') : undefined))
    }
    const leads = [...card.querySelectorAll('section[aria-label="Lead values"] ul.readouts > li')].map(li => ({ label: text(li.querySelector('.head .name')), value: deepText(li.querySelector('.reading, .state') ?? doc.createElement('i')) }))
    const alarms = card.querySelector('section.alarms')
    const banner = card.querySelector('.banner')
    const framed = [...card.querySelectorAll('.mimic-panel .item')].filter(item => item.querySelector('.frame-box')).map((item, index) => ({ item: String(index), tone: (item.querySelector('.flap-line')?.className ?? '').replace('flap-line', '').trim() || 'alert', name: text(item.querySelector('.stack .tag')) }))
    return {
      generation: 'old',
      frame: { width: Math.round(frameRect.width), height: Math.round(frameRect.height) },
      title: text(card.querySelector('.unit, h1')),
      word: text(card.querySelector('.chip')).toUpperCase() || null,
      sim: text(card.querySelector('.clock')) || null,
      worst: banner && banner.classList.contains('trip') ? text(banner) : null,
      chips: [...card.querySelectorAll('.csf')].map(chip => ({ label: chip.getAttribute('aria-label') || '', value: text(chip) })),
      leads,
      alerts: alarms ? { heading: text(alarms.querySelector('h2')) || text(alarms.querySelector('.empty')), rows: [...alarms.querySelectorAll('li')].map(text), more: text(alarms.querySelector('.more')) || null } : null,
      framed, framedSymbols: framed.length, outlined: [],
      values,
      text: text(card),
      popover: look ? { title: look.getAttribute('aria-label') || '', ready: look.querySelector('section') !== null } : null,
    }
  }
  return empty
}`

// ---------- What is on screen: markup-agnostic readers for the task scripts (plan v5 §5.2–§5.5) ----------
//
// The R2 lanes change the markup (faceplate card, trip line, aggregate row, chips on the title row, buttons on
// stops), so these readers lean on what any generation must show: visible text, its place on screen, and the
// controls a person can press (buttons and their accessible names). A line is "on screen" when every one of its text
// boxes lies inside the browser viewport, inside the display frame's visible part, and inside every ancestor that
// clips or scrolls it (a column scrolled out of a 1046 px window, a faceplate body scrolled down are not on screen).

/** In-page helpers shared by the screen readers below: the shown display frame, a node's page offset through the
 * frames, and whether a page rectangle is visible through every clipping ancestor. */
const SCREEN_HELPERS = String.raw`
  const lb = window.__lb
  // A frame that is loading has no body yet: not a display to read.
  const embedDocs = () => lb.documents().filter(d => d.frame && d.doc && d.doc.body && /\/world\/embed\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))
  const areaOf = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }
  // The display window's frame: the largest shown embed that is not inside a dialog (a tag dialog or a chat card is smaller).
  const windowDoc = () => embedDocs().sort((a, b) => areaOf(b) - areaOf(a))[0] || null
  // A frame's document on the top page: top x = ox + s * (its viewport x), s its frames' scales (a zoomed display
  // window scales its frame with transform: scale), and the part of the top viewport it shows (up the frame chain).
  const frameBox = frame => {
    let ox = 0, oy = 0, sc = 1
    let vis = { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight }
    const chain = []
    for (let f = frame; f; f = f.ownerDocument.defaultView.frameElement) chain.unshift(f)
    for (const f of chain) {
      // The boxes in the frame's own document that clip it (a window body that scrolls): what they hide is not shown.
      const fwin = f.ownerDocument.defaultView
      for (let a = f.parentElement; a && a !== f.ownerDocument.documentElement; a = a.parentElement) {
        const s = fwin.getComputedStyle(a)
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
        const q = a.getBoundingClientRect()
        const as = a.offsetWidth > 0 ? q.width / a.offsetWidth : 1
        const al = ox + sc * (q.left + a.clientLeft * as), at = oy + sc * (q.top + a.clientTop * as)
        if (s.overflowX !== 'visible') vis = { ...vis, l: Math.max(vis.l, al), r: Math.min(vis.r, al + sc * as * a.clientWidth) }
        if (s.overflowY !== 'visible') vis = { ...vis, t: Math.max(vis.t, at), b: Math.min(vis.b, at + sc * as * a.clientHeight) }
      }
      const r = f.getBoundingClientRect()
      const fs = lb.scaleOf(f)
      const l = ox + sc * (r.left + f.clientLeft * fs), t = oy + sc * (r.top + f.clientTop * fs)
      sc *= fs
      vis = { l: Math.max(vis.l, l), t: Math.max(vis.t, t), r: Math.min(vis.r, l + sc * f.clientWidth), b: Math.min(vis.b, t + sc * f.clientHeight) }
      ox = l; oy = t
    }
    return { ox, oy, s: sc, vis }
  }
  // What a press at a point of the top page lands on, through the frames (a window toolbar or a page dialog over the
  // display takes the press, not the display under it).
  const deepHit = (x, y) => {
    let doc = document, px = x, py = y, hit = doc.elementFromPoint(px, py)
    while (hit && hit.tagName === 'IFRAME' && hit.contentDocument) {
      const r = hit.getBoundingClientRect()
      const fs = lb.scaleOf(hit)
      px = (px - r.left) / fs - hit.clientLeft; py = (py - r.top) / fs - hit.clientTop
      doc = hit.contentDocument
      hit = doc.elementFromPoint(px, py)
    }
    return hit
  }
  const parentOf = (n, win) => n.assignedSlot || (n.parentNode instanceof win.ShadowRoot ? n.parentNode.host : n.parentNode)
  // The visible part of a rectangle (page coordinates) through the ancestors of node that clip or scroll it, as CSS
  // clips it: an absolutely placed box escapes the ancestors below its containing block, a fixed one all but the root.
  const visiblePart = (node, rect, box, win) => {
    let v = { l: Math.max(rect.l, box.vis.l), t: Math.max(rect.t, box.vis.t), r: Math.min(rect.r, box.vis.r), b: Math.min(rect.b, box.vis.b) }
    let escaping = null
    for (let el = parentOf(node, win); el && el.nodeType === 1; el = parentOf(el, win)) {
      const s = win.getComputedStyle(el)
      const root = el === el.ownerDocument.documentElement
      if (escaping === 'absolute' && s.position === 'static' && !root) continue
      if (escaping === 'fixed' && !root && s.transform === 'none' && s.filter === 'none') continue
      escaping = s.position === 'absolute' ? 'absolute' : s.position === 'fixed' ? 'fixed' : null
      if (s.display === 'contents' || root) continue
      const r = el.getBoundingClientRect()
      const es = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1
      const l = box.ox + box.s * (r.left + el.clientLeft * es), t = box.oy + box.s * (r.top + el.clientTop * es)
      if (s.overflowX !== 'visible') v = { ...v, l: Math.max(v.l, l), r: Math.min(v.r, l + box.s * es * el.clientWidth) }
      if (s.overflowY !== 'visible') v = { ...v, t: Math.max(v.t, t), b: Math.min(v.b, t + box.s * es * el.clientHeight) }
    }
    return v
  }
  // Whether the whole rectangle shows: 0.5 px across, 3 px up and down (a text box's content area overflows a tight line box).
  const whole = (rect, v) => v.l <= rect.l + 0.5 && v.r >= rect.r - 0.5 && v.t <= rect.t + 3 && v.b >= rect.b - 3 && v.r > v.l && v.b > v.t
  // Hidden, or there only for assistive technology (a visually hidden copy of a message: a 1 px box clipped away).
  const hiddenEl = (el, win) => {
    const s = win.getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return true
    if (s.position !== 'absolute' && s.position !== 'fixed') return false
    const r = el.getBoundingClientRect()
    return (r.width <= 1 && r.height <= 1) || /inset\(50%/.test(s.clipPath) || /^rect\(0/.test(s.clip)
  }
  // Every rendered text node under root (through shadow roots), not an SVG title or a hidden spacer.
  const textNodesOf = (root, win) => {
    const out = []
    const walk = node => {
      if (!node) return
      if (node.nodeType === 3) { if (node.textContent.trim()) out.push(node); return }
      if (node.nodeType !== 1 && node.nodeType !== 11) return
      if (node.nodeType === 1 && (node.tagName.toLowerCase() === 'title' || node.tagName.toLowerCase() === 'style' || node.tagName.toLowerCase() === 'script' || hiddenEl(node, win))) return
      if (node.nodeType === 1 && node.shadowRoot) walk(node.shadowRoot)
      for (const child of node.childNodes) walk(child)
    }
    walk(root)
    return out
  }
  const nodeRect = (node, box) => {
    const range = node.ownerDocument.createRange()
    range.selectNodeContents(node)
    const r = range.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? { l: box.ox + box.s * r.left, t: box.oy + box.s * r.top, r: box.ox + box.s * r.right, b: box.oy + box.s * r.bottom } : null
  }
  const closestUp = (el, sel, win) => { for (let n = el; n && n.nodeType === 1; n = parentOf(n, win)) { if (n.matches && n.matches(sel)) return n } return null }
  const ROW = 'li, tr, dt, dd, h1, h2, h3, h4, p, button, a, label, figcaption, summary, [role=button], [role=row], [role=listitem], [role=option], [role=menuitem], [role=status], [role=heading], .readout, .state, .text, .row, .line, .chip'
  const DIALOG = '[role=dialog], .popover, .faceplate, .overlay'
  const regionOf = (el, win) => {
    if (closestUp(el, DIALOG, win)) return 'faceplate'
    if (closestUp(el, '.trip, .trip-line, .tripline, [data-region=trip]', win)) return 'trip'
    if (closestUp(el, '.chips, [data-region=chips]', win)) return 'chips'
    if (closestUp(el, 'section.alerts, .alerts, [data-region=alerts]', win)) return 'alerts'
    if (closestUp(el, '.flow, .drawing, .network, [data-region=drawing]', win)) return 'drawing'
    if (closestUp(el, '.column, .band, [data-region=column]', win)) return 'column'
    if (closestUp(el, 'header', win)) return 'header'
    if (closestUp(el, 'footer', win)) return 'footer'
    return 'body'
  }
  // The drawing's own scroller showing its affordance ("drawing continues ›", R2 W4.3) that holds a node, if any.
  const affordanceScroller = (node, win) => {
    for (let el = parentOf(node, win); el && el.nodeType === 1; el = parentOf(el, win)) {
      const s = win.getComputedStyle(el)
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.querySelector('.flow') && el.parentElement
        && [...el.parentElement.querySelectorAll(':scope > .continues, :scope > [data-continues]')].some(cue => !hiddenEl(cue, win) && cue.getBoundingClientRect().width > 0)) return el
    }
    return null
  }
  // The text lines of a document as a person reads them: each row element's rendered text, with its place and
  // whether all of it is on screen.
  const linesOf = (doc, frame) => {
    const win = doc.defaultView
    const box = frame ? frameBox(frame) : { ox: 0, oy: 0, s: 1, vis: { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight } }
    const rows = new Map()
    for (const node of textNodesOf(doc.body || doc.documentElement, win)) {
      const rect = nodeRect(node, box)
      if (rect === null) continue
      const parent = parentOf(node, win)
      // The trip line under the title row reads as one line; its labels and messages are its parts.
      const row = closestUp(parent, '.trip, .trip-line', win) || closestUp(parent, ROW, win) || parent
      let entry = rows.get(row)
      if (!entry) { entry = { row, parts: [], on: true, valueOn: true, cut: 0, behind: 0, l: Infinity, t: Infinity, r: -Infinity, b: -Infinity }; rows.set(row, entry) }
      entry.parts.push(node.textContent)
      const v = visiblePart(node, rect, box, win)
      // A label cut by its ellipsis is not whole; the value (a node with a digit or a state word) must be.
      const cut = !whole(rect, v) || (node.parentElement && node.parentElement.scrollWidth > node.parentElement.clientWidth + 1 && win.getComputedStyle(node.parentElement).textOverflow === 'ellipsis')
      if (cut) {
        entry.on = false
        entry.cut += 1
        // Sideways only, in the drawing's scroller while its affordance shows: reachable by that scroll.
        const scroller = affordanceScroller(node, win)
        if (scroller) { const sr = scroller.getBoundingClientRect(); const top = box.oy + box.s * sr.top, bottom = top + box.s * scroller.clientHeight; if (rect.t >= top - 3 && rect.b <= bottom + 3) entry.behind += 1 }
      }
      // A value: a number, or a state word in capitals ("OPEN", "STOP · CMD RUN"), not a label that holds an acronym.
      if (cut && (/\d/.test(node.textContent) || /^[A-Z][A-Z0-9 .·\/%-]{1,30}$/.test(node.textContent.trim()))) entry.valueOn = false
      entry.l = Math.min(entry.l, rect.l); entry.t = Math.min(entry.t, rect.t); entry.r = Math.max(entry.r, rect.r); entry.b = Math.max(entry.b, rect.b)
    }
    return [...rows.values()].map(e => ({
      text: e.parts.join(' ').replace(/\s+/g, ' ').trim(), region: regionOf(e.row, win), on: e.on, valueOn: e.valueOn, behind: e.cut > 0 && e.behind === e.cut,
      x: Math.round(e.l), y: Math.round(e.t), w: Math.round(e.r - e.l), h: Math.round(e.b - e.t),
    })).filter(line => line.text.length > 0)
  }
  // A control's page rectangle and whether a press at its centre reaches it (nothing on top of it, on screen).
  const pointOf = (el, frame) => {
    const box = frame ? frameBox(frame) : { ox: 0, oy: 0, s: 1, vis: { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight } }
    const r = el.getBoundingClientRect()
    const rect = { l: box.ox + box.s * r.left, t: box.oy + box.s * r.top, r: box.ox + box.s * r.right, b: box.oy + box.s * r.bottom }
    const v = visiblePart(el, rect, box, el.ownerDocument.defaultView)
    const cx = (Math.max(rect.l, v.l) + Math.min(rect.r, v.r)) / 2, cy = (Math.max(rect.t, v.t) + Math.min(rect.b, v.b)) / 2
    const visible = v.r - v.l > 2 && v.b - v.t > 2
    let reaches = false
    if (visible) {
      const hit = deepHit(cx, cy)
      for (let n = hit; n; n = n.parentNode instanceof el.ownerDocument.defaultView.ShadowRoot ? n.parentNode.host : n.parentNode) { if (n === el) { reaches = true; break } }
      if (!reaches && hit && el.contains && el.contains(hit)) reaches = true
      if (!reaches && hit && hit.shadowRoot && el.getRootNode && el.getRootNode() === hit.shadowRoot) reaches = true
    }
    return { x: cx, y: cy, w: box.s * r.width, h: box.s * r.height, visible, reaches, whole: whole(rect, v) }
  }
  const nameOf = el => ((el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim()
  const PRESSABLE = 'button, a[href], [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=option], [role=tab], [role=switch], summary, obc-button, obc-toggle-button-option, obc-icon-button, obc-automation-button, [tabindex="0"]'
`

export interface ScreenLine {
  readonly text: string
  readonly region: string
  /** Every text box of the line shows whole (a label cut by its ellipsis does not). */
  readonly on: boolean
  /** Its values show whole (each text box with a digit or a capitalised state word); the label may have given way. */
  readonly valueOn: boolean
  /** Not whole only because it stands sideways in the drawing's scroller while that shows its affordance ("drawing
   * continues ›"): reachable by that scroll (lead ruling, 23 Oct), counted apart. */
  readonly behind?: boolean
  readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface Screen {
  /** The shown display's frame (page coordinates) and its visible part; null when no display shows. */
  readonly frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly visibleW: number; readonly visibleH: number } | null
  /** The display window's header (Host side): its position word ("1 / 5"), title and whether a Back control shows. */
  readonly window: { readonly position: string | null; readonly title: string | null; readonly back: boolean; readonly src: string | null } | null
  /** Text lines of the shown display, the faceplates and choosers inside it, in reading order. */
  readonly lines: ReadonlyArray<ScreenLine>
  /** Dialogs shown over the display (a faceplate, a chooser, a tag dialog), with their own lines. */
  readonly dialogs: ReadonlyArray<{ readonly label: string; readonly where: 'display' | 'page'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly pinned: boolean; readonly arrow?: boolean; readonly arrowParts?: ReadonlyArray<string> }>
}

/** An expression for `Page.eval`: what the display window shows on screen now (see Screen). */
export const readScreen = (): string => `((() => {${SCREEN_HELPERS}
  const shown = windowDoc()
  const header = lb.everything().map(([el]) => el).find(el => el.className && typeof el.className === 'string' && /(^|\\s)display-window-header(\\s|$)/.test(el.className) && lb.shown(el))
  const position = header && header.querySelector('.display-window-position')
  const title = header && header.querySelector('.display-window-title')
  const back = !!(header && [...header.querySelectorAll('button, [role=button]')].some(b => lb.shown(b) && /^back\\b|go back|‹ /i.test((b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').trim())))
  const windowState = header ? { position: position ? (position.innerText || '').replace(/\\s+/g, ' ').trim() : null, title: title ? (title.innerText || '').replace(/\\s+/g, ' ').trim() : null, back, src: shown ? (shown.frame.getAttribute('src') || '').slice(0, 400) : null } : null
  if (!shown) return { frame: null, window: windowState, lines: [], dialogs: [] }
  const box = frameBox(shown.frame)
  const fr = shown.frame.getBoundingClientRect()
  const lines = linesOf(shown.doc, shown.frame)
  // Dialogs: inside the display (faceplates, choosers) and on the Run page over it (a tag dialog, the procedures).
  const dialogs = []
  for (const el of shown.doc.querySelectorAll('[role=dialog], [role=menu], [role=listbox], .popover, .faceplate')) {
    if (!lb.shown(el) || dialogs.some(d => d.el.contains(el))) continue
    const r = el.getBoundingClientRect()
    // An arrow pointing at its opener: a small part named so (through shadow roots), drawn at the card's edge (touching
    // or past it). A rate arrow or a fold caret inside the card is no pointer; every named part is listed as evidence.
    const parts = []
    const walk = root => { for (const n of root.querySelectorAll('*')) { const cls = ((n.getAttribute('class') || '') + ' ' + (n.getAttribute('part') || '')).trim(); if (/arrow|caret|beak/i.test(cls) && lb.shown(n)) { const q = n.getBoundingClientRect(); const edge = q.width <= 32 && q.height <= 32 && (q.left < r.left + 2 || q.right > r.right - 2 || q.top < r.top + 2 || q.bottom > r.bottom - 2); parts.push((n.tagName.toLowerCase() + '.' + cls.split(/\\s+/).filter(c => !/^svelte-/.test(c)).join('.')).slice(0, 60) + (edge ? ' (at the edge)' : '')) } if (n.shadowRoot) walk(n.shadowRoot) } }
    walk(el); if (el.shadowRoot) walk(el.shadowRoot)
    const arrow = parts.some(part => part.endsWith('(at the edge)'))
    dialogs.push({ el, label: nameOf(el).slice(0, 120), where: 'display', x: Math.round(box.ox + box.s * r.left), y: Math.round(box.oy + box.s * r.top), w: Math.round(box.s * r.width), h: Math.round(box.s * r.height), pinned: !!el.closest('[data-pinned], .pinned') || /pinned/i.test(el.className + '') || !!el.querySelector('[aria-pressed=true][aria-label*="pin" i], [aria-pressed=true][title*="pin" i]'), arrow, arrowParts: [...new Set(parts)].slice(0, 6) })
  }
  return { frame: { x: Math.round(box.ox), y: Math.round(box.oy), w: Math.round(fr.width), h: Math.round(fr.height), visibleW: Math.round(box.vis.r - box.vis.l), visibleH: Math.round(box.vis.b - box.vis.t) }, window: windowState, lines, dialogs: dialogs.map(({ el, ...d }) => d) }
})())`

/** Lines whose values show on screen, or stand behind the drawing's scroll affordance, and whose text matches, in the
 * regions given (all when none). */
export const onScreen = (screen: Screen, pattern: RegExp, regions?: ReadonlyArray<string>): ReadonlyArray<ScreenLine> =>
  screen.lines.filter(line => (line.valueOn || line.behind === true) && pattern.test(line.text) && (regions === undefined || regions.includes(line.region)))
/** Of these lines, the ones that need the drawing's scroll (behind its affordance), for evidence. */
export const behindAffordance = (lines: ReadonlyArray<ScreenLine>): ReadonlyArray<ScreenLine> => lines.filter(line => !line.valueOn && line.behind === true)

export interface PressTarget {
  /** A stable key within one view: kind and name, with an index for duplicates. */
  readonly key: string
  readonly kind: 'item' | 'label' | 'magnifier' | 'chip' | 'row' | 'more' | 'control' | 'window'
  readonly name: string
  /** The drawn item it belongs to (data-item), when it belongs to one. */
  readonly item: string | null
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** A press at its centre reaches it (on screen and nothing on top). */
  readonly reaches: boolean
  /** Some of it shows on screen; one scrolled out of view is pressed after scrolling it in (reveal). */
  readonly visible: boolean
  /** It is a control itself (a button, a link, a role=button…), not text a person presses anyway. */
  readonly pressable: boolean
}

/** An expression for `Page.eval`: scrolls the target (by kind and name, as readTargets lists it) into the middle of its
 * scrolling boxes, as a person scrolls to it before pressing. */
export const revealTarget = (target: Pick<PressTarget, 'kind' | 'name'>): string => `((() => {${SCREEN_HELPERS}
  const shown = windowDoc()
  if (!shown) return false
  const name = ${JSON.stringify(target.name)}
  const all = [...shown.doc.querySelectorAll(PRESSABLE + ', .flow .text > :first-child, [data-item] .text > :first-child, section.alerts li, .alerts li, .chips .state, header .state')]
  const bare = text => text.replace(/^(Open|Faceplate:|Quick look:?)\\s+/i, '')
  const el = all.find(candidate => nameOf(candidate).slice(0, 120) === name || bare(nameOf(candidate)).slice(0, 120) === name || ((candidate.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 120) === name)
  if (!el) return false
  el.scrollIntoView({ block: 'center', inline: 'center' })
  return true
})())`

/** An expression for `Page.eval`: what a person can press in the shown display, on screen now: each drawn item's
 * body and its label (the text beside the symbol; a press there is one on the item only where the label is part of
 * its target), a magnifier, the chips, alert rows, "+N more", and the display's other controls. Items' labels are
 * listed even where they are not buttons, so a script can record that a press there opens nothing. */
export const readTargets = (): string => `((() => {${SCREEN_HELPERS}
  const shown = windowDoc()
  if (!shown) return []
  const doc = shown.doc, win = doc.defaultView
  const out = []
  const seen = new Set()
  const add = (el, kind, name, item, pressable = false) => {
    if (seen.has(el)) return
    seen.add(el)
    const p = pointOf(el, shown.frame)
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    out.push({ kind, name: name.slice(0, 120), item, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h), reaches: p.reaches, visible: p.visible, pressable })
  }
  // The drawn item a control belongs to: its own data-item or data-magnifier, else (a symbol's body, R2) the text block
  // that stands just right of it on its rows.
  const blocks = [...doc.querySelectorAll('.flow .text[data-item], [data-item].text')].map(el => ({ el, r: el.getBoundingClientRect(), id: el.getAttribute('data-item') }))
  const itemOf = el => {
    if (el.getAttribute('data-magnifier')) return el.getAttribute('data-magnifier')
    const host = closestUp(el, '[data-item]', win)
    if (host) return host.getAttribute('data-item')
    if (regionOf(el, win) !== 'drawing') return null
    const r = el.getBoundingClientRect()
    const near = blocks.filter(b => b.r.left >= r.left + r.width * 0.5 - 2 && b.r.left <= r.right + 32 && b.r.top < r.bottom && b.r.bottom > r.top - 8)
      .sort((a, b) => (a.r.left - r.right) - (b.r.left - r.right))[0]
    return near ? near.id : null
  }
  // Written \\s: this template is not raw, and a lone \s would reach the page as "s".
  const bare = name => name.replace(/^(Open|Faceplate:|Quick look:?)\\s+/i, '')
  const small = el => { const r = el.getBoundingClientRect(); return r.width <= 44 && r.height <= 44 }
  for (const el of doc.querySelectorAll(PRESSABLE)) {
    if (!lb.shown(el) || el.closest('[aria-hidden=true]') || el.matches('[disabled], [aria-disabled=true]')) continue
    const name = nameOf(el)
    if (!name) continue
    const region = regionOf(el, win)
    let kind = 'control'
    if (region === 'drawing') kind = (el.hasAttribute('data-magnifier') || (small(el) && /faceplate|quick look|magnif|details? of|inspect/i.test(name))) ? 'magnifier' : 'item'
    else if (region === 'chips' || (region === 'header' && closestUp(el, '.state, .chip', win))) kind = 'chip'
    else if (region === 'alerts' && /^\\+\\s*\\d+|more\\b/i.test(name)) kind = 'more'
    else if (region === 'alerts' || region === 'trip') kind = 'row'
    else if (region === 'faceplate') kind = 'control'
    add(el, kind, kind === 'item' || kind === 'magnifier' ? bare(name) : name, itemOf(el), true)
  }
  // Drawn items' text blocks: a person presses the label too.
  for (const el of doc.querySelectorAll('.flow .text, [data-item] .text, [data-item] .label')) {
    if (!lb.shown(el) || seen.has(el)) continue
    const first = el.firstElementChild || el
    const name = (first.innerText || first.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!name) continue
    add(first, 'label', name, itemOf(el) || el.getAttribute('data-item'))
  }
  // Alert rows and "+N more" that are not buttons (a person presses them anyway).
  for (const el of doc.querySelectorAll('section.alerts li, .alerts li, section.alerts .more, .alerts .more')) {
    if (!lb.shown(el) || seen.has(el) || [...seen].some(s => el.contains(s))) continue
    const name = (el.innerText || '').replace(/\\s+/g, ' ').trim()
    if (!name) continue
    add(el, /^\\+\\s*\\d+|more\\b/i.test(name) ? 'more' : 'row', name, null)
  }
  // Chips that are not buttons (a person presses them anyway).
  for (const el of doc.querySelectorAll('.chips .state, header .state, header .chip')) {
    if (!lb.shown(el) || seen.has(el) || [...seen].some(s => el.contains(s) || s.contains(el))) continue
    add(el, 'chip', (el.innerText || '').replace(/\\s+/g, ' ').trim(), null)
  }
  const counts = new Map()
  return out.map(t => { const base = t.kind + ':' + t.name; const n = counts.get(base) || 0; counts.set(base, n + 1); return { key: n === 0 ? base : base + '#' + n, ...t } })
})())`

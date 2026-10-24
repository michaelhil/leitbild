/** Chat answers' display cards as a person reads them (plan v5 §5.5 "Chat card at 480 px: values visible, toggle
 * ≤ 32 px"; §5.4 T7 "every cited key resolves"; W7.1). Reads the answers a probe run recorded (probe.ts rows and its
 * seed.json: the Workspace and each answer's room), opens each room (/workspaces/<ws>?agents=<room>) at 480 px wide, and judges:
 *   card-480   each frozen card ([data-live-card]): its shown lines' labels and values whole inside the card, none cut;
 *              the Inline toggle ([data-inline]) at most 32 × 32 px
 *   T7         each key the answer cites ([data-cites]) is a button that opens its card at its line: the line
 *              ([data-card-keys~=key]) shows within a second (a key on no card, "k7?", resolves nothing)
 * and shoots each room (<out>/<label>-card-480-<n>.png; the first with a card also as <label>-card-480.png for the
 * gallery). Reads only; no model is called.
 *
 *   bun scripts/display-eval/chat-cards.ts --origin=http://127.0.0.1:<port> --runs=<probe output dir> --out=<dir>
 *       [--label=<stack>] [--width=480] [--height=900] [--port=<CDP port>] [--limit=<rooms>] [--window]
 * --window: also opens each answer's display in the window at 1920 × 1080 and shoots it (<label>-answer-<n>-window.png).
 */
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { ensureChrome, loopbackOrigin, openPage, options, sleep } from './browser.ts'
import { waitForContent } from './display-press.ts'

interface CardRead {
  readonly cards: ReadonlyArray<{
    readonly title: string
    readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
    readonly lines: ReadonlyArray<{ readonly keys: string; readonly label: string; readonly value: string; readonly shown: boolean; readonly cut: ReadonlyArray<string> }>
    readonly toggle: { readonly w: number; readonly h: number } | null
    readonly more: string | null
  }>
  readonly keys: ReadonlyArray<{ readonly key: string; readonly button: boolean; readonly title: string }>
}

/** Every card and cited key in the chat's documents (the Agents app may sit in a frame of the Host page). */
const READ = String.raw`(() => {
  const out = { cards: [], keys: [] }
  for (const { doc } of lb.documents()) {
    if (!doc || !doc.body) continue
    const win = doc.defaultView
    const cutOf = (el, card) => {
      const r = el.getBoundingClientRect(), c = card.getBoundingClientRect()
      const reasons = []
      if (el.scrollWidth > el.clientWidth + 1 && win.getComputedStyle(el).display !== 'inline') reasons.push('overflows its box')
      if (r.left < c.left - 0.5 || r.right > c.right + 0.5) reasons.push('outside the card')
      if (/…$/.test((el.textContent || '').trim())) reasons.push('ellipsis')
      return reasons
    }
    for (const card of doc.querySelectorAll('[data-live-card]')) {
      const box = lb.toTop(card)
      const lines = [...card.querySelectorAll('[data-card-keys]')].map(row => {
        const spans = [...row.children]
        const label = spans.length > 2 ? spans[0] : null, value = spans.length > 2 ? spans[1] : spans[0]
        const shown = !row.hidden && !row.closest('[hidden]') && row.getBoundingClientRect().height > 0
        return { keys: row.dataset.cardKeys || '', label: label ? label.textContent.trim() : '', value: value ? value.textContent.trim() : '', shown, cut: shown ? [...(label ? cutOf(label, card).map(r => 'label ' + r) : []), ...(value ? cutOf(value, card).map(r => 'value ' + r) : [])] : [] }
      })
      const toggle = card.querySelector('[data-inline]')
      const t = toggle ? toggle.getBoundingClientRect() : null
      const more = card.querySelector('[data-more]')
      out.cards.push({ title: (card.getAttribute('aria-label') || '').replace(/^AI-composed display: /, ''), box, lines, toggle: t ? { w: Math.round(t.width), h: Math.round(t.height) } : null, more: more && !more.hidden ? more.textContent.trim() : null })
    }
    for (const chip of doc.querySelectorAll('[data-cites]')) out.keys.push({ key: chip.dataset.cites, button: chip.tagName === 'BUTTON', title: chip.title || '' })
  }
  return out
})()`

/** Brings a cited key's chip into view and says where a press lands on it: its chip scrolled to the middle of the
 * chat's own scroller (the chat keeps to its bottom while it settles, so this is read again before the press), and the
 * element a press at that point reaches through the frames, so a chip under the room's header is never pressed blind. */
const PRESS_KEY = (key: string, index: number) => String.raw`(() => {
  for (const { doc } of lb.documents()) {
    const chips = doc && doc.body ? [...doc.querySelectorAll('[data-cites="' + ${JSON.stringify(key)} + '"]')] : []
    const chip = chips[${index}] || chips[0]
    if (!chip) continue
    if (chip.tagName !== 'BUTTON') return { pressed: false, reason: 'not a button' }
    // The chat's scroller: the nearest ancestor that scrolls.
    let scroller = chip.parentElement
    while (scroller && scroller !== doc.documentElement) { const st = doc.defaultView.getComputedStyle(scroller); if (/(auto|scroll)/.test(st.overflowY) && scroller.scrollHeight > scroller.clientHeight) break; scroller = scroller.parentElement }
    if (scroller && scroller !== doc.documentElement) { const sr = scroller.getBoundingClientRect(), cr = chip.getBoundingClientRect(); scroller.scrollTop += (cr.top + cr.height / 2) - (sr.top + scroller.clientHeight / 2) } else chip.scrollIntoView({ block: 'center' })
    const r = lb.toTop(chip)
    const x = r.x + r.w / 2, y = r.y + r.h / 2
    let hitDoc = document, px = x, py = y, hit = hitDoc.elementFromPoint(px, py)
    while (hit && hit.tagName === 'IFRAME' && hit.contentDocument) { const fr = hit.getBoundingClientRect(), fs = lb.scaleOf(hit); px = (px - fr.left) / fs - hit.clientLeft; py = (py - fr.top) / fs - hit.clientTop; hitDoc = hit.contentDocument; hit = hitDoc.elementFromPoint(px, py) }
    const reaches = !!hit && (hit === chip || chip.contains(hit))
    return { pressed: true, x, y, reaches, over: reaches || !hit ? null : hit.tagName.toLowerCase() + '.' + String(hit.className || '').split(' ')[0] }
  }
  return { pressed: false, reason: 'no chip' }
})()`
/** A dashboard board the display window shows now, and the section it marks (aria-current or .focused), if any. */
const BOARD_OPENED = String.raw`(() => {
  for (const { doc, frame } of lb.documents()) {
    const main = doc && doc.querySelector && doc.querySelector('main.dashboard')
    if (!main || (frame && !lb.shown(frame))) continue
    const marked = main.querySelector('section.section[aria-current], section.section.focused')
    return { title: main.getAttribute('aria-label') || '', section: marked ? marked.getAttribute('aria-label') : null }
  }
  return null
})()`
const LINE_SHOWN = (key: string) => String.raw`(() => {
  for (const { doc } of lb.documents()) {
    // R3 marks a card line with all its keys (data-card-keys); R1 and R2 with one (data-card-key).
    const line = doc && doc.body ? doc.querySelector('[data-card-keys~="' + ${JSON.stringify(key)} + '"], [data-card-key="' + ${JSON.stringify(key)} + '"]') : null
    if (!line) continue
    const r = lb.toTop(line)
    // On screen: inside the window and every scroller around it (the chat's message list clips what it scrolls).
    let clipped = false
    for (let a = line.parentElement; a && a !== doc.documentElement; a = a.parentElement) {
      const st = doc.defaultView.getComputedStyle(a)
      if (st.overflowY === 'visible') continue
      const q = lb.toTop(a)
      if (r.y < q.y - 1 || r.y + r.h > q.y + q.h + 1) { clipped = true; break }
    }
    return { found: true, shown: !line.hidden && !line.closest('[hidden]') && r.h > 0 && r.y >= 0 && r.y + r.h <= innerHeight && !clipped, marked: line.classList.contains('bg-surface-strong') }
  }
  return { found: false, shown: false, marked: false }
})()`

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const origin = loopbackOrigin(argv.get('origin'))
  const runs = argv.get('runs'), out = argv.get('out')
  if (runs === undefined || out === undefined) throw new Error('usage: chat-cards.ts --origin=… --runs=<probe output dir> --out=<dir> (see the header)')
  const label = argv.get('label') ?? new URL(origin).port
  const width = Number(argv.get('width') ?? 480), height = Number(argv.get('height') ?? 900)
  const port = Number(argv.get('port') ?? 44325)
  const seed = JSON.parse(await Bun.file(join(runs, 'seed.json')).text())
  const workspaceId: string = seed.workspaceId ?? seed.workspace?.id
  const rows: any[] = []
  for (const name of readdirSync(runs).filter(file => file.endsWith('-rows.jsonl'))) for (const line of (await Bun.file(join(runs, name)).text()).split('\n')) if (line.trim()) rows.push({ ...JSON.parse(line), stage: name.replace(/-rows\.jsonl$/, '') })
  const only = argv.get('only')?.split(',') ?? null
  const rooms = rows.filter(row => typeof row.roomId === 'string' && (only === null || only.includes(row.roomId))).slice(0, Number(argv.get('limit') ?? 1_000))
  const chrome = await ensureChrome({ port, profile: join(out, `chrome-${port}`) })
  const page = await openPage(port, width, height)
  const results: Array<Record<string, unknown>> = []
  let galleryShot = false
  try {
    for (const [index, row] of rooms.entries()) {
      await page.goto(`${origin}/workspaces/${workspaceId}?agents=${encodeURIComponent(row.roomId)}`)
      await page.until('lb.documents().some(d => d.doc && d.doc.querySelector && d.doc.querySelector("[data-live-view], [data-cites]"))', 60_000).catch(() => undefined)
      await sleep(2_500)
      const read = await page.eval<CardRead>(READ)
      // T7: every cited key opens its card at its line.
      const keys: Array<{ key: string; resolves: boolean; why: string }> = []
      const seen = new Map<string, number>()
      for (const entry of read.keys) {
        const n = seen.get(entry.key) ?? 0
        seen.set(entry.key, n + 1)
        if (!entry.button) { keys.push({ key: entry.key, resolves: false, why: entry.title || 'not a button' }); continue }
        // Scroll it into the chat's view, let the chat settle, and press only where the press reaches the chip.
        type At = { pressed: boolean; x?: number; y?: number; reaches?: boolean; over?: string | null; reason?: string }
        let at: At = { pressed: false, reason: 'no chip' }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          at = await page.eval<At>(PRESS_KEY(entry.key, n))
          if (!at.pressed) break
          await sleep(400)
          at = await page.eval<At>(PRESS_KEY(entry.key, n))
          if (at.reaches) break
        }
        if (!at.pressed) { keys.push({ key: entry.key, resolves: false, why: at.reason ?? '?' }); continue }
        if (!at.reaches) { keys.push({ key: entry.key, resolves: false, why: `chip covered by ${at.over ?? '?'} after scrolling it into the chat's view` }); continue }
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
        await sleep(600)
        const line = await page.eval<{ found: boolean; shown: boolean; marked: boolean }>(LINE_SHOWN(entry.key))
        // A key from a dashboard's card (chat2) also opens its board in the window at the line's section, marked.
        const board = await page.eval<{ title: string; section: string | null } | null>(BOARD_OPENED)
        keys.push({ key: entry.key, resolves: line.found && line.shown, why: line.found ? (line.shown ? (line.marked ? 'line shown and marked' : 'line shown') : 'line not on screen') : 'no line holds it', ...(board === null ? {} : { board }) })
      }
      const shot = join(out, `${label}-card-480-${String(index).padStart(2, '0')}.png`)
      await page.shot(shot)
      if (!galleryShot && read.cards.length > 0) { await page.shot(join(out, `${label}-card-480.png`)); galleryShot = true }
      // The first display card at twice the pixels, cropped (the gallery's chat-card defect): R3's frozen card, or the
      // chip that stands for a display before it.
      const box = await page.eval<{ x: number; y: number; w: number; h: number } | null>(String.raw`(() => { for (const { doc } of lb.documents()) { const el = doc && doc.body ? [...doc.querySelectorAll('[data-live-card], [data-live-view]')].find(e => lb.shown(e)) : null; if (el) { el.scrollIntoView({ block: 'center' }); return lb.toTop(el) } } return null })()`)
      if (box !== null && box.w > 0 && box.h > 0) {
        await sleep(400)
        const fresh = await page.eval<{ x: number; y: number; w: number; h: number } | null>(String.raw`(() => { for (const { doc } of lb.documents()) { const el = doc && doc.body ? [...doc.querySelectorAll('[data-live-card], [data-live-view]')].find(e => lb.shown(e)) : null; if (el) return lb.toTop(el) } return null })()`) ?? box
        const clip = { x: Math.max(0, fresh.x - 4), y: Math.max(0, fresh.y - 4), width: Math.min(fresh.w + 8, width), height: Math.min(fresh.h + 8, height), scale: 2 }
        const crop = await page.send('Page.captureScreenshot', { format: 'png', clip })
        const file = join(out, `${label}-card-crop-${String(index).padStart(2, '0')}.png`)
        await Bun.write(file, Buffer.from(crop.data, 'base64'))
        if (!(await Bun.file(join(out, `${label}-card-crop.png`)).exists())) await Bun.write(join(out, `${label}-card-crop.png`), Buffer.from(crop.data, 'base64'))
      }
      const cut = read.cards.flatMap(card => card.lines.filter(line => line.cut.length > 0).map(line => `"${line.label}" | "${line.value}": ${line.cut.join(', ')}`))
      const toggles = read.cards.filter(card => card.toggle !== null && (card.toggle.w > 32 || card.toggle.h > 32)).map(card => `${card.title}: ${card.toggle!.w} × ${card.toggle!.h}`)
      const result = {
        id: row.id, stage: row.stage, roomId: row.roomId, shot,
        cards: read.cards.length, lines: read.cards.reduce((n, card) => n + card.lines.filter(line => line.shown).length, 0),
        card480: { pass: read.cards.length === 0 ? null : cut.length === 0 && toggles.length === 0 && read.cards.every(card => card.toggle !== null), cut, toggles, noToggle: read.cards.filter(card => card.toggle === null).map(card => card.title) },
        t7: { pass: keys.length === 0 ? null : keys.every(key => key.resolves), keys },
      }
      // The answer's display opened in the window at 1920 × 1080 (for the HMI rubric's AI displays and the gallery).
      if (argv.has('window') && read.cards.length + read.keys.length > 0) {
        await page.size(1920, 1080)
        await sleep(1_500)
        const open = await page.find({ sel: 'button', text: 'Open live display in the display window' })
        if (open !== null) {
          await page.click(open)
          // Its Run may be unloaded (a fresh stack): wait for the window's display to draw, not for a fixed time.
          await sleep(2_000)
          await waitForContent(page, 60_000)
          await sleep(1_500)
          await page.shot(join(out, `${label}-answer-${String(index).padStart(2, '0')}-window.png`))
        }
        await page.size(width, height)
      }
      results.push(result)
      const boards = (keys as ReadonlyArray<{ key: string; board?: { title: string; section: string | null } }>).flatMap(key => key.board === undefined ? [] : [{ key: key.key, board: key.board }])
      console.log(`${label} ${row.stage} ${row.id}: ${read.cards.length} cards, ${result.lines} lines shown; card-480 ${result.card480.pass === null ? 'n/a' : result.card480.pass ? 'PASS' : 'FAIL'}${cut.length + toggles.length > 0 ? ` (${[...cut, ...toggles].slice(0, 3).join('; ')})` : ''}; T7 ${result.t7.pass === null ? 'n/a (no key cited)' : result.t7.pass ? 'PASS' : 'FAIL'} ${keys.filter(key => key.resolves).length}/${keys.length}${keys.some(key => !key.resolves) ? ` (${keys.filter(key => !key.resolves).slice(0, 4).map(key => `${key.key}: ${key.why}`).join('; ')})` : ''}${boards.length > 0 ? `; board opened by ${boards.length} key${boards.length === 1 ? '' : 's'} (${boards.slice(0, 3).map(entry => `${entry.key} → "${entry.board.title}"${entry.board.section === null ? ', no section marked' : ` at "${entry.board.section}"`}`).join('; ')})` : ''}`)
      await Bun.write(join(out, `${label}-chat-cards.json`), JSON.stringify({ label, origin, runs, width, results }, null, 2))
    }
  } finally {
    await page.close()
    if (chrome.started) await chrome.stop()
  }
  const judged = (key: 'card480' | 't7') => results.map(result => (result[key] as { pass: boolean | null }).pass).filter((pass): pass is boolean => pass !== null)
  console.log(`\n${label}: card-480 ${judged('card480').filter(Boolean).length}/${judged('card480').length} rooms pass; T7 ${judged('t7').filter(Boolean).length}/${judged('t7').length} rooms with every cited key resolving`)
}

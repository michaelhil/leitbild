/** What the shown display draws, read in the page for the rendering matrix (plan v5 §5.5, R3 rows): the flow
 * drawing's text lines and vessel silhouettes in the drawing's own coordinates (for overlap, stubs and vessel gaps,
 * judged in drawing-geometry.ts against the drawing World's sample makes), the fonts, the trend strips, the lead
 * rows' sparklines and the theme's alert colours. Markup-agnostic where it can be: each reader names what it found
 * and says plainly where a part it looks for is absent.
 *
 * Every export is an expression for `Page.eval` (browser.ts defines `lb`). Written with String.raw: no escape here
 * is lost on the way into the page. */

/** The display window's frame and document, as display-dom.ts picks it: the largest shown embed. */
const SHOWN = String.raw`
  const embeds = lb.documents().filter(d => d.frame && d.doc && d.doc.body && /\/world\/embed\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))
  const areaOf = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }
  const shown = embeds.sort((a, b) => areaOf(b) - areaOf(a))[0] || null
  const clean = el => [...(el.classList || [])].filter(c => !/^svelte-/.test(c)).join('.')
  const textOf = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim()
  // The union of an element's text nodes' boxes (what the glyphs take), in its document's viewport.
  const textRect = el => {
    const rects = []
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue
      const range = el.ownerDocument.createRange()
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r)
    }
    if (rects.length === 0) return null
    return { l: Math.min(...rects.map(r => r.left)), t: Math.min(...rects.map(r => r.top)), r: Math.max(...rects.map(r => r.right)), b: Math.max(...rects.map(r => r.bottom)) }
  }
`

export interface RenderedLine { readonly item: string; readonly line: number; readonly kind: string; readonly text: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface RenderedDrawing {
  readonly found: boolean
  /** The drawing's scale on screen (a drawing fitted to its room is scaled). */
  readonly scale: number
  readonly width: number
  readonly height: number
  /** Each text line of each drawn item, its glyphs' box in the drawing's own coordinates. */
  readonly lines: ReadonlyArray<RenderedLine>
  /** Each drawn vessel, tank or exchanger: the box of what it draws (its silhouette's shapes), in drawing coordinates. */
  readonly silhouettes: ReadonlyArray<{ readonly tag: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }>
  /** The drawing's text size as rendered: the computed font of its first name and first reading. */
  readonly font: { readonly name: string | null; readonly reading: string | null }
  /** Vessel traces as drawn (W6.6): a text block's trace line (span.trace) or an exchanger tile's (.tile-trace), each
   * with whether its sparkline draws a line, and where (drawing coordinates). */
  readonly traces: ReadonlyArray<{ readonly where: 'text' | 'tile'; readonly item: string | null; readonly drawn: boolean; readonly label: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }>
}

/** The first flow drawing of the shown display (a vignette draws one per topology section; the first is the one a
 * unit overview and an element default draw). */
export const readDrawing = (): string => String.raw`((() => {${SHOWN}
  const none = { found: false, scale: 1, width: 0, height: 0, lines: [], silhouettes: [], traces: [], font: { name: null, reading: null } }
  if (!shown) return none
  const doc = shown.doc, win = doc.defaultView
  const flow = doc.querySelector('.flow')
  const drawing = flow && (flow.querySelector('.drawing') || flow)
  if (!drawing) return none
  const dr = drawing.getBoundingClientRect()
  const scale = drawing.offsetWidth > 0 ? dr.width / drawing.offsetWidth : 1
  const toDrawing = r => ({ x: (r.l - dr.left) / scale, y: (r.t - dr.top) / scale, w: (r.r - r.l) / scale, h: (r.b - r.t) / scale })
  const lines = []
  for (const block of drawing.querySelectorAll('.text[data-item]')) {
    const spans = [...block.children].filter(child => child.tagName === 'SPAN')
    spans.forEach((span, index) => {
      const r = textRect(span)
      if (!r || win.getComputedStyle(span).visibility === 'hidden') return
      lines.push({ item: block.getAttribute('data-item'), line: index, kind: clean(span) || 'line', text: textOf(span), ...toDrawing(r) })
    })
  }
  // What a vessel, tank or exchanger draws: the union of its visible shapes (through its shadow root), not its box.
  // A shape filled with the drawing's own background and no stroke (a halo, a disc behind the symbol) is not part
  // of what a person sees as the vessel: left out, so a pipe ending on a halo shows as a gap.
  const rgb = c => (String(c).match(/[\d.]+/g) || []).slice(0, 3).map(Number)
  const bgOf = el => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = win.getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return rgb(c) } return [255, 255, 255] }
  const bg = bgOf(drawing)
  const near = (a, b) => a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= 16)
  const shapesOf = root => {
    const out = []
    // An HTML part that draws (a bordered or filled box in the symbol's shadow tree: OpenBridge draws a tile's outline so).
    const drawsBox = el => { if (el instanceof win.SVGElement) return false; const s = win.getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; const bordered = ['Top', 'Right', 'Bottom', 'Left'].some(side => Number.parseFloat(s['border' + side + 'Width']) > 0 && s['border' + side + 'Style'] !== 'none' && !clear(s['border' + side + 'Color'])); const filled = !clear(s.backgroundColor) && !near(rgb(s.backgroundColor), bg); return bordered || filled }
    const clear = c => !c || c === 'none' || c === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(c)
    const walk = node => { for (const el of node.querySelectorAll('*')) { if (el.tagName && !/^(path|rect|circle|ellipse|polygon|polyline|line|svg|g|title|defs|pattern|style|slot)$/i.test(el.tagName) && drawsBox(el)) { const q = el.getBoundingClientRect(); if (q.width > 0 && q.height > 0) out.push(q) } }
      for (const el of node.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line')) { const s = win.getComputedStyle(el); const unstroked = clear(s.stroke) || Number.parseFloat(s.strokeWidth) === 0 || Number(s.strokeOpacity) === 0; const unfilled = clear(s.fill) || Number(s.fillOpacity) === 0; if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || (unfilled && unstroked) || (unstroked && near(rgb(s.fill), bg))) continue; const q = el.getBoundingClientRect(); if (q.width > 0 || q.height > 0) out.push(q) } for (const el of node.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot) }
    walk(root); if (root.shadowRoot) walk(root.shadowRoot)
    return out
  }
  const silhouettes = []
  for (const el of drawing.querySelectorAll('svg.vessel, obc-automation-tank, obc-heat-exchanger, obc-tank, obc-vessel')) {
    const shapes = shapesOf(el)
    if (shapes.length === 0) continue
    const box = { l: Math.min(...shapes.map(q => q.left)), t: Math.min(...shapes.map(q => q.top)), r: Math.max(...shapes.map(q => q.right)), b: Math.max(...shapes.map(q => q.bottom)) }
    silhouettes.push({ tag: el.tagName.toLowerCase() + (clean(el) ? '.' + clean(el) : ''), ...toDrawing(box) })
  }
  const fontOf = el => { if (!el) return null; const s = win.getComputedStyle(el); return s.fontSize + ' ' + s.fontWeight + ' ' + s.fontFamily }
  const drawnSpark = el => { const svg = el.querySelector('svg.spark, svg'); const line = svg && svg.querySelector('path.line, path:not(.frame)'); return !!line && ((line.getAttribute('d') || '').match(/[LHVCSQT]/gi) || []).length >= 1 }
  const traces = [
    ...[...drawing.querySelectorAll('.text[data-item] span.trace')].map(el => ({ where: 'text', item: el.closest('.text[data-item]').getAttribute('data-item'), el })),
    ...[...drawing.querySelectorAll('.tile-trace')].map(el => ({ where: 'tile', item: (el.closest('[data-item]') || { getAttribute: () => null }).getAttribute('data-item'), el })),
  ].map(({ where, item, el }) => { const r = el.getBoundingClientRect(); const svg = el.querySelector('svg'); return { where, item, drawn: drawnSpark(el), label: svg ? (svg.getAttribute('aria-label') || '').slice(0, 90) : '', ...toDrawing({ l: r.left, t: r.top, r: r.right, b: r.bottom }) } })
  return { found: true, scale, width: drawing.offsetWidth, height: drawing.offsetHeight, lines, silhouettes, traces, font: { name: fontOf(drawing.querySelector('.text[data-item] .name')), reading: fontOf(drawing.querySelector('.text[data-item] .reading')) } }
})())`

export interface FontsRead {
  readonly faces: ReadonlyArray<{ readonly family: string; readonly status: string; readonly weight: string }>
  /** document.fonts.check for Noto Sans at the drawing's two sizes. */
  readonly noto: { readonly name12: boolean; readonly reading14: boolean }
  /** The family each part renders in (its computed font-family's first entry). */
  readonly families: Readonly<Record<string, string | null>>
  /** Each drawn item's first line: its rendered width (unscaled px), size and text, for the composer's width oracle. */
  readonly widths: ReadonlyArray<{ readonly text: string; readonly kind: string; readonly px: number; readonly size: number; readonly weight: number }>
}

/** Fonts (§5.5 "Font"): which faces the display document loaded, whether Noto Sans is what its text renders in, and
 * the rendered width of each drawn text line, measured on an unscaled copy (a canvas measure in the line's own font). */
export const readFonts = (): string => String.raw`((async () => {${SHOWN}
  if (!shown) return null
  const doc = shown.doc, win = doc.defaultView
  await doc.fonts.ready
  const faces = [...doc.fonts].map(f => ({ family: f.family.replace(/["']/g, ''), status: f.status, weight: String(f.weight) }))
  const first = s => (s || '').split(',')[0].replace(/["']/g, '').trim() || null
  const famOf = sel => { const el = doc.querySelector(sel); return el ? first(win.getComputedStyle(el).fontFamily) : null }
  const families = { drawingName: famOf('.flow .text[data-item] .name'), drawingReading: famOf('.flow .text[data-item] .reading'), title: famOf('article > header h1'), column: famOf('.values .label, .readout .label, .band .label'), alerts: famOf('section.alerts .message, section.alerts li, .alerts .row') }
  const canvas = doc.createElement('canvas').getContext('2d')
  const widths = []
  for (const span of doc.querySelectorAll('.flow .text[data-item] > span')) {
    const s = win.getComputedStyle(span)
    const text = (span.textContent || '').trim()
    if (!text) continue
    canvas.font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily
    widths.push({ text, kind: [...span.classList].filter(c => !/^svelte-/.test(c)).join('.'), px: Math.round(canvas.measureText(text).width * 10) / 10, size: Number.parseFloat(s.fontSize), weight: Number.parseFloat(s.fontWeight) || 400 })
  }
  return { faces, noto: { name12: doc.fonts.check('12px "Noto Sans"'), reading14: doc.fonts.check('14px "Noto Sans"') }, families, widths }
})())`

export interface TrendsRead {
  readonly strips: ReadonlyArray<{
    readonly index: number
    readonly width: number
    readonly height: number
    readonly pens: ReadonlyArray<{ readonly cls: string; readonly pieces: number; readonly dash: string | null }>
    /** Every text drawn in the plot (value ticks, limit names, beyond marks), its box relative to the plot. */
    readonly texts: ReadonlyArray<{ readonly text: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly anchor: string }>
    readonly limits: ReadonlyArray<{ readonly cls: string; readonly y: number; readonly stroke: string; readonly dash: string; readonly title: string }>
    /** Legend entries: name, whether its name is cut (an ellipsis, or text wider than its box), and its value. */
    readonly legend: ReadonlyArray<{ readonly name: string; readonly cut: boolean; readonly now: string }>
    readonly empty: string | null
  }>
}

/** The trend strips of the shown display (W5.2–W5.4): each pen's path pieces (its "M" moves), the plot's texts with
 * their boxes, the limit lines with their colour, and the legend. */
export const readTrends = (): string => String.raw`((() => {${SHOWN}
  if (!shown) return { strips: [] }
  const doc = shown.doc, win = doc.defaultView
  const strips = [...doc.querySelectorAll('.strip')].filter(el => !el.closest('.popover, [role=dialog]')).map((strip, index) => {
    const svg = strip.querySelector('.plot svg')
    const box = svg ? svg.getBoundingClientRect() : strip.getBoundingClientRect()
    const pens = svg ? [...svg.querySelectorAll('path.pen')].map(p => ({ cls: [...p.classList].filter(c => !/^svelte-/.test(c)).join('.'), pieces: ((p.getAttribute('d') || '').match(/M/gi) || []).length, dash: p.getAttribute('stroke-dasharray') })) : []
    const texts = svg ? [...svg.querySelectorAll('text')].map(t => { const r = t.getBoundingClientRect(); return { text: (t.textContent || '').trim(), x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height, anchor: t.getAttribute('text-anchor') || 'start' } }) : []
    const limits = svg ? [...svg.querySelectorAll('line.limit')].map(l => ({ cls: [...l.classList].filter(c => !/^svelte-/.test(c)).join('.'), y: Number(l.getAttribute('y1')), stroke: win.getComputedStyle(l).stroke, dash: win.getComputedStyle(l).strokeDasharray, title: ((l.querySelector('title') || {}).textContent || '').trim() })) : []
    // Cut: an ellipsis written, or a box (not an inline span, whose client width is 0) narrower than its text.
    const legend = [...strip.querySelectorAll('.legend li')].map(li => { const name = li.querySelector('.name') || li; const inline = win.getComputedStyle(name).display === 'inline'; return { name: textOf(name), cut: (!inline && name.scrollWidth > name.clientWidth + 1) || /…$/.test(textOf(name)), now: textOf(li.querySelector('.now')) } })
    return { index, width: Math.round(box.width), height: Math.round(box.height), pens, texts, limits, legend, empty: textOf(strip.querySelector('.empty')) || null }
  })
  return { strips }
})())`

export interface ColumnRead {
  /** Each lead row: its label, whether it draws a sparkline (an svg or canvas drawn in the row, with a path or pixels),
   * and the row's text. */
  readonly rows: ReadonlyArray<{ readonly label: string; readonly full: string; readonly text: string; readonly spark: { readonly tag: string; readonly w: number; readonly h: number; readonly pieces: number } | null }>
  /** Lines anywhere in the display that read as a margin to a limit ("0.66 above LO 14.8 MPa"). */
  readonly margins: ReadonlyArray<string>
}

/** The lead rows of the shown display's first values section (W4.2): a sparkline in each, and the margin lines. The
 * rows are the section's direct rows, R1's .readout/.state, R2's .values block or R3's readout-list items. */
export const readColumn = (): string => String.raw`((() => {${SHOWN}
  if (!shown) return { rows: [], margins: [] }
  const doc = shown.doc
  const ROWS = ':scope > .readout, :scope > .state, :scope > .values > .readout, :scope > .values > .state, :scope > .values > obc-readout-list > .row:not(.head)'
  const section = [...doc.querySelectorAll('.section')].find(s => !s.closest('.popover, [role=dialog]') && s.querySelector(ROWS))
  const rows = section ? [...section.querySelectorAll(ROWS)] : []
  const sparkOf = row => {
    const candidates = [...row.querySelectorAll('svg, canvas')].concat(row.shadowRoot ? [...row.shadowRoot.querySelectorAll('svg, canvas')] : [])
    for (const el of candidates) {
      const r = el.getBoundingClientRect()
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('class') || '')
      // A limit or span bar (hatched, or OpenBridge's bar) is not a trace over time.
      const bar = (/bar|limit|span|indicator/i.test(label) && !/spark|min/i.test(label)) || el.closest('obc-bar-horizontal, obc-bar-vertical, .bar, .span')
      if (bar || r.width < 24 || r.height < 6) continue
      if (el.tagName === 'CANVAS') return { tag: 'canvas', w: Math.round(r.width), h: Math.round(r.height), pieces: 1 }
      // The registered sparkline (R3: svg.spark, its trace path.line): one, drawn where its path holds points.
      if (el.classList.contains('spark')) {
        const line = el.querySelector('path.line, path:not(.frame)')
        const d = line ? line.getAttribute('d') || '' : ''
        if ((d.match(/[LHVCSQT]/gi) || []).length >= 1) return { tag: 'svg.spark', w: Math.round(r.width), h: Math.round(r.height), pieces: (d.match(/M/gi) || []).length }
        continue
      }
      // A trace: a path of a few pieces that draws onward (two or more line commands), not a hatch of many strokes.
      const paths = [...el.querySelectorAll('path, polyline')].filter(p => !p.closest('pattern, defs')).filter(p => {
        const d = p.getAttribute('d') || ''
        if (p.tagName.toLowerCase() === 'polyline') return (p.getAttribute('points') || '').trim().split(/\s+/).length >= 3
        return (d.match(/M/gi) || []).length <= 8 && (d.match(/[LHVCSQT]/gi) || []).length >= 2
      })
      if (paths.length === 0) continue
      return { tag: 'svg' + (el.getAttribute('class') ? '.' + el.getAttribute('class').split(' ').filter(c => !/^svelte-/.test(c)).join('.') : ''), w: Math.round(r.width), h: Math.round(r.height), pieces: paths.reduce((n, p) => n + (((p.getAttribute('d') || '').match(/M/gi) || []).length || 1), 0) }
    }
    return null
  }
  const out = rows.map(row => ({ label: (textOf(row.querySelector(':scope > .label, :scope > .name > .label')) || textOf(row.querySelector(':scope > .full, .label, [slot=label], .name') || row)).slice(0, 80), full: textOf(row.querySelector(':scope > .full')).slice(0, 120), text: textOf(row).slice(0, 120), spark: sparkOf(row) }))
  // Margin lines: R3's .margin paragraphs (who, and what in words), else any short line that reads as a margin to a limit.
  const marginEls = [...doc.querySelectorAll('p.margin')].filter(el => !el.closest('.popover, [role=dialog]'))
  const margins = marginEls.length > 0 ? marginEls.map(el => { const what = el.querySelector('.what'); return (textOf(el.querySelector('.who')) + ' ' + (what ? what.getAttribute('aria-label') || textOf(what) : '')).trim() }) : [...doc.querySelectorAll('p, span, div, li')].filter(el => el.children.length === 0 || [...el.children].every(c => c.tagName === 'SPAN')).map(textOf).filter(t => /\b\d[\d.,]*\s*(\S+\s+)?(above|below|from|to)\s+(LO-LO|HI-HI|LO|HI|LOW|HIGH|TRIP)\b/i.test(t) && t.length < 160)
  return { rows: out, margins: [...new Set(margins)].slice(0, 20) }
})())`

export interface ThemeRead {
  readonly theme: string | null
  /** The alert colours the display's theme defines, as rgb(…) strings. */
  readonly colours: Readonly<Record<string, string>>
  /** The display frame's box on the page (where to scan a screenshot). */
  readonly frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null
  readonly background: string | null
}

/** The shown display's theme (data-obc-theme), its alert colours resolved by the browser, and its frame's box. */
export const readTheme = (): string => String.raw`((() => {${SHOWN}
  if (!shown) return { theme: null, colours: {}, frame: null, background: null }
  const doc = shown.doc, win = doc.defaultView
  const probe = doc.createElement('i')
  doc.body.appendChild(probe)
  const colours = {}
  for (const name of ['alert-alarm-color', 'alert-warning-color', 'alert-caution-color', 'alert-critical-color']) {
    probe.style.color = 'var(--' + name + ')'
    const value = win.getComputedStyle(probe).color
    if (value && value !== 'rgba(0, 0, 0, 0)') colours[name] = value
  }
  probe.remove()
  const fr = lb.toTop(shown.frame)
  return { theme: doc.documentElement.dataset.obcTheme || null, colours, frame: { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.w), h: Math.round(fr.h) }, background: win.getComputedStyle(doc.body).backgroundColor }
})())`

/** Text of every part of the shown display a person reads, for word checks ("LIVE", "DEAD", "<0 %", "WR 24 %"). */
export const readWords = (): string => String.raw`((() => {${SHOWN}
  if (!shown) return []
  const out = []
  for (const el of shown.doc.querySelectorAll('.flow .text[data-item], .readout, .state, obc-readout-list-item, .values li, .band li, .grouped td, .grouped th, .faceplate li')) {
    const t = textOf(el)
    if (t) out.push({ where: el.closest('.flow') ? 'drawing' : el.closest('.faceplate, [role=dialog]') ? 'faceplate' : 'column', text: t.slice(0, 160), lowIntegrity: /low-integrity|doubtful/.test(el.className + ' ' + [...el.querySelectorAll('*')].map(c => c.getAttribute('class') || '').join(' ')) })
  }
  return out
})())`

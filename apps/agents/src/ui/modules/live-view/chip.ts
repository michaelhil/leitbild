// The display chip that stands in place of a ```leitbild-view fence in a posted
// answer. Its Open action opens the display in the Workspace's one process
// display window; its 32 px Inline toggle shows the same live display in the
// answer too, below the chip, until the reader hides it. A vignette's chip is
// its frozen card (W7.1): one meta line, the lines the answer cites first as
// label | value with their keys, at most three before "N more lines", and the
// card's lines fold away while the live display is shown inline. Each ⟦k⟧ in
// the answer becomes a chip that opens the card at its line. In an answer
// that proposed an operation, reviewing the proposal is the primary action
// (proposal card) and Open live is secondary. Neutral and accent colours
// only; a refusal is not a process alarm.
import type { EmbeddedViewListing } from '@leitbild/contracts'
import { icon, type IconName } from '../icon.ts'
import { hideInline, showInline } from './inline.ts'
import { cardLineText, itemOf, type CardLine, type FrozenCard, type TurnCardsRead } from './cards.ts'

/** What a chip shows of its vignette's card: the frozen card, or why it cannot. */
export type ChipCard = FrozenCard | { readonly refused: string }

/** How a chip's answer frames it: an answer that proposed an operation reviews it first (its proposal card). */
export interface ChipContext {
  readonly proposal: boolean
}

type ChipState = 'preparing' | 'available' | 'refused' | 'unhosted'

const ROW = 'flex items-start gap-2 w-full max-w-[520px]'
const CHIP = 'flex items-center gap-3 flex-1 min-w-0 min-h-[44px] px-3 py-1.5 rounded-md border border-border bg-surface text-left no-underline'
const INTERACTIVE = 'interactive cursor-pointer hover:bg-surface-strong hover:border-accent'
const CARD = 'flex flex-col gap-1 w-full max-w-[520px] px-3 py-2 rounded-md border border-border bg-surface'
const TOGGLE = 'shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md border border-border bg-surface text-text-muted interactive cursor-pointer hover:bg-surface-strong hover:border-accent hover:text-accent'
const PRIMARY = 'inline-flex items-center gap-1 h-8 px-3 rounded-md text-xs font-medium bg-accent text-white no-underline interactive cursor-pointer hover:bg-accent-hover'
const SECONDARY = 'inline-flex items-center gap-1 h-8 px-3 rounded-md border border-border bg-surface text-xs font-medium text-text-muted no-underline interactive cursor-pointer hover:bg-surface-strong hover:border-accent hover:text-accent'
const SUBTITLE = 'Live process display · AI-composed'

/** What a chip that offers its display does when the reader asks. */
export interface ChipActions {
  readonly open: (listing: EmbeddedViewListing) => void
  /** Whether the reader asked to see this display inline; kept across re-renders of the answer. */
  readonly inlineShown: (key: string) => boolean
  readonly setInlineShown: (key: string, shown: boolean) => void
}

// A shown chip's listing, card and framing, so chips rendered before the Host announced itself can become Open
// buttons when it does.
const chipListings = new WeakMap<HTMLElement, EmbeddedViewListing>()
const chipCards = new WeakMap<HTMLElement, ChipCard>()
const chipContexts = new WeakMap<HTMLElement, ChipContext>()
// The element below a chip that holds its inline display, made on first use.
const inlineSlots = new WeakMap<HTMLElement, HTMLElement>()
// A frozen card's lines: whether all show ("N more lines" pressed, or a key chip opened one), and its repaint.
const cardViews = new WeakMap<HTMLElement, { expanded: boolean; paint: () => void }>()
let inlineSlotSequence = 0
let cardSequence = 0

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag)
  made.className = className
  if (text !== undefined) made.textContent = text
  return made
}

/** A chip with no frozen card: its title and one line under it (preparing, refused, a Pack's own display). */
const lines = (title: string, subtitle: string, options: { readonly titleTooltip: boolean; readonly wrapSubtitle: boolean }): HTMLElement => {
  const text = element('span', 'flex-1 min-w-0 flex flex-col leading-tight')
  const first = element('span', 'block truncate text-[13px] font-semibold text-text-strong', title)
  if (options.titleTooltip) first.title = title
  text.append(first, element('span', `block text-[11.5px] text-text-subtle${options.wrapSubtitle ? ' break-words' : ' truncate'}`, subtitle))
  return text
}

const leadingIcon = (name: IconName, className: string): SVGSVGElement => {
  const glyph = icon(name, { size: 18, className: `shrink-0 ${className}` })
  glyph.setAttribute('aria-hidden', 'true')
  return glyph
}

// Only the chip's row is replaced when its state changes: the inline slot
// below it stays in place, because moving a frame in the DOM reloads it.
const show = (host: HTMLElement, state: ChipState, row: HTMLElement): void => {
  host.dataset.liveView = state
  const current = host.firstElementChild
  if (current !== null && current !== inlineSlots.get(host)) current.replaceWith(row)
  else host.prepend(row)
}

const inlineSlotOf = (host: HTMLElement): HTMLElement => {
  const existing = inlineSlots.get(host)
  if (existing !== undefined) return existing
  const slot = document.createElement('div')
  inlineSlotSequence += 1
  slot.id = `live-view-inline-${inlineSlotSequence}`
  slot.className = 'mt-2 w-full rounded-md border border-border overflow-hidden'
  inlineSlots.set(host, slot)
  return slot
}

const applyInline = (host: HTMLElement, listing: EmbeddedViewListing, shown: boolean): void => {
  const slot = inlineSlotOf(host)
  if (shown) {
    if (slot.parentElement !== host) host.append(slot)
    showInline(slot, listing.envelope)
    return
  }
  hideInline(slot)
  slot.remove()
}

const dropInline = (host: HTMLElement): void => {
  const slot = inlineSlots.get(host)
  if (slot === undefined) return
  hideInline(slot)
  slot.remove()
}

/** The 32 px toggle that shows the live display in the answer, below the chip, and hides it again. */
const inlineToggle = (host: HTMLElement, listing: EmbeddedViewListing, actions: ChipActions, changed: () => void): HTMLButtonElement => {
  const title = listing.envelope.title
  const button = element('button', TOGGLE)
  button.type = 'button'
  button.dataset.inline = ''
  const paint = (): void => {
    const shown = actions.inlineShown(listing.key)
    button.setAttribute('aria-expanded', String(shown))
    // It controls the inline display only while that is in the answer.
    if (shown) button.setAttribute('aria-controls', inlineSlotOf(host).id)
    else button.removeAttribute('aria-controls')
    button.setAttribute('aria-label', `${shown ? 'Hide' : 'Show'} the live display in this answer: ${title}`)
    button.title = shown ? 'Hide the live display here' : 'Show the live display here'
    const glyph = icon(shown ? 'eye-off' : 'eye', { size: 16 })
    glyph.setAttribute('aria-hidden', 'true')
    button.replaceChildren(glyph)
  }
  button.onclick = event => {
    event.stopPropagation()
    const shown = !actions.inlineShown(listing.key)
    actions.setInlineShown(listing.key, shown)
    applyInline(host, listing, shown)
    paint()
    changed()
  }
  paint()
  return button
}

/** A card line: label | value, never cut (the label wraps first), and its keys, small. */
const lineRow = (line: CardLine): HTMLElement => {
  const row = element('div', 'flex items-baseline gap-2 px-1 -mx-1 rounded text-[12px] leading-snug transition-colors')
  row.setAttribute('role', 'listitem')
  row.dataset.cardKeys = line.keys.join(' ')
  row.setAttribute('aria-label', cardLineText(line))
  if (line.label !== '') row.append(element('span', 'flex-1 min-w-[30%] text-text-muted break-words', line.label))
  row.append(element('span', `${line.label === '' ? 'flex-1' : 'max-w-[70%] text-right'} text-text-strong font-medium break-words tabular-nums`, line.value))
  row.append(element('span', 'shrink-0 text-[10px] font-mono text-text-subtle whitespace-nowrap', line.keys.join(' ')))
  return row
}

/**
 * A vignette's frozen card: its title with the inline toggle, one meta line, its lines (the cited first, three before
 * "N more lines"), what only the live display shows, and its actions; the lines fold while the display is inline.
 */
const frozenElement = (host: HTMLElement, listing: EmbeddedViewListing, actions: ChipActions, frozen: FrozenCard, open: HTMLElement): HTMLElement => {
  const title = listing.envelope.title
  const card = element('div', CARD)
  card.dataset.liveCard = ''
  card.setAttribute('role', 'group')
  card.setAttribute('aria-label', `AI-composed display: ${title}`)
  // Kept across a re-render of the chip (the Host announcing itself): a card the reader opened stays open.
  const view = { expanded: cardViews.get(host)?.expanded ?? false, paint: (): void => {} }
  cardViews.set(host, view)
  const heading = element('span', 'flex-1 min-w-0 truncate text-[13px] font-semibold text-text-strong', title)
  heading.title = title
  const head = element('div', 'flex items-center gap-2 min-w-0')
  head.append(leadingIcon('monitor-cog', 'text-accent'), heading, inlineToggle(host, listing, actions, () => paint()))
  const list = element('div', 'flex flex-col gap-0.5')
  cardSequence += 1
  list.id = `live-view-card-${cardSequence}`
  list.setAttribute('role', 'list')
  const rows = frozen.lines.map(lineRow)
  list.append(...rows)
  const hidden = frozen.lines.length - frozen.shown
  const more = element('button', 'self-start text-[11.5px] font-medium text-accent interactive cursor-pointer hover:underline')
  more.type = 'button'
  more.dataset.more = ''
  more.setAttribute('aria-controls', list.id)
  more.onclick = event => {
    event.stopPropagation()
    view.expanded = !view.expanded
    paint()
  }
  const elsewhere = element('span', 'text-[11.5px] text-text-subtle', `${frozen.elsewhere} more on the live display`)
  const footer = element('div', 'flex items-center gap-2 mt-1')
  footer.append(open)
  const paint = (): void => {
    // Shown inline, the live display holds every line: the card keeps its title, meta and actions, unless a key opened it.
    const folded = actions.inlineShown(listing.key) && !view.expanded
    list.hidden = folded
    rows.forEach((row, index) => { row.hidden = index >= frozen.shown && !view.expanded })
    more.hidden = folded || hidden === 0
    more.textContent = view.expanded ? 'Fewer lines' : `${hidden} more ${hidden === 1 ? 'line' : 'lines'}`
    more.setAttribute('aria-expanded', String(view.expanded))
    elsewhere.hidden = folded || frozen.elsewhere === 0 || (hidden > 0 && !view.expanded)
  }
  card.append(head, element('span', 'text-[11.5px] text-text-subtle', frozen.meta), list, more, elsewhere, footer)
  view.paint = paint
  paint()
  return card
}

/** Opens the frozen card that holds a key's line, shows that line and marks it; false where no shown card holds it. */
const revealLine = (container: HTMLElement, key: string): boolean => {
  const line = container.querySelector<HTMLElement>(`[data-card-keys~="${key}"]`)
  const host = line?.closest<HTMLElement>('[data-live-view]')
  const view = host === null || host === undefined ? undefined : cardViews.get(host)
  if (line === null || view === undefined) return false
  view.expanded = true
  view.paint()
  line.scrollIntoView({ block: 'nearest' })
  line.classList.add('bg-surface-strong')
  setTimeout(() => line.classList.remove('bg-surface-strong'), 1_500)
  return true
}

const offerRow = (host: HTMLElement, listing: EmbeddedViewListing, main: HTMLElement, actions: ChipActions): HTMLElement => {
  const row = element('div', ROW)
  row.append(main, inlineToggle(host, listing, actions, () => {}))
  return row
}

/** A chip (or frozen card) that offers its display: the inline display comes back where the reader showed it before. */
const offer = (host: HTMLElement, state: 'available' | 'unhosted', listing: EmbeddedViewListing, actions: ChipActions, card: ChipCard | undefined, context: ChipContext,
  open: { readonly frozen: HTMLElement; readonly chip: () => HTMLElement }): void => {
  chipListings.set(host, listing)
  chipContexts.set(host, context)
  if (card !== undefined) chipCards.set(host, card)
  const frozen = card !== undefined && !('refused' in card) ? card : undefined
  const shown = frozen === undefined ? offerRow(host, listing, open.chip(), actions) : frozenElement(host, listing, actions, frozen, open.frozen)
  show(host, state, shown)
  // An answer rendered again shows inline what the reader showed inline before.
  if (actions.inlineShown(listing.key) && inlineSlots.get(host)?.parentElement !== host) applyInline(host, listing, true)
}

/** The element that replaces the fence's `<pre>`; it keeps its place while the chip changes state. */
export const createChipHost = (): HTMLElement => element('div', 'my-2')

export const showPreparing = (host: HTMLElement): void => {
  const chip = element('button', `${CHIP} max-w-[520px] cursor-wait`)
  chip.type = 'button'
  chip.disabled = true
  chip.append(leadingIcon('loader-circle', 'text-text-muted animate-spin'), lines('Preparing display…', SUBTITLE, { titleTooltip: false, wrapSubtitle: false }))
  chipListings.delete(host)
  chipCards.delete(host)
  dropInline(host)
  show(host, 'preparing', chip)
}

export const showAvailable = (host: HTMLElement, listing: EmbeddedViewListing, actions: ChipActions, card = chipCards.get(host), context = chipContexts.get(host) ?? { proposal: false }): void => {
  const title = listing.envelope.title
  const opener = (button: HTMLButtonElement): HTMLButtonElement => {
    button.type = 'button'
    button.setAttribute('aria-label', `Open live display in the display window: ${title}`)
    button.onclick = event => {
      event.stopPropagation()
      actions.open(listing)
    }
    return button
  }
  offer(host, 'available', listing, actions, card, context, {
    // In an answer that proposed, the proposal card's review is the primary action and opening the display secondary.
    frozen: opener(element('button', context.proposal ? SECONDARY : PRIMARY, context.proposal ? 'Open live' : 'Open live ›')),
    chip: () => {
      const chip = opener(element('button', `${CHIP} ${INTERACTIVE}`))
      const refused = card !== undefined && 'refused' in card ? card.refused : undefined
      chip.append(leadingIcon('monitor-cog', 'text-accent'), lines(title, refused === undefined ? SUBTITLE : `${SUBTITLE} · ${refused}`, { titleTooltip: true, wrapSubtitle: false }),
        element('span', 'shrink-0 text-xs font-medium text-accent', 'Open'))
      return chip
    },
  })
}

export const showRefused = (host: HTMLElement, code: string, message: string): void => {
  const chip = element('div', `${CHIP} max-w-[520px]`)
  chip.append(leadingIcon('monitor-off', 'text-text-muted'), lines('Display not shown', `${message} (${code})`, { titleTooltip: false, wrapSubtitle: true }))
  chipListings.delete(host)
  dropInline(host)
  show(host, 'refused', chip)
}

/** Outside the Host no window shows displays: link to the Workspace page with this room; Inline still shows the display here. */
export const showUnhosted = (host: HTMLElement, listing: EmbeddedViewListing, href: string, actions: ChipActions, card?: ChipCard, context: ChipContext = { proposal: false }): void => {
  const title = listing.envelope.title
  const link = (className: string): HTMLAnchorElement => {
    const anchor = element('a', className)
    anchor.href = href
    anchor.target = '_top'
    anchor.setAttribute('aria-label', `Open live display in the workspace: ${title}`)
    return anchor
  }
  offer(host, 'unhosted', listing, actions, card, context, {
    frozen: (() => { const anchor = link(SECONDARY); anchor.append('Open workspace', icon('external-link', { size: 14 })); return anchor })(),
    chip: () => {
      const chip = link(`${CHIP} ${INTERACTIVE} text-text`)
      const refused = card !== undefined && 'refused' in card ? card.refused : undefined
      const action = element('span', 'shrink-0 inline-flex items-center gap-1 text-xs font-medium text-accent')
      action.append('Open workspace', icon('external-link', { size: 14 }))
      chip.append(leadingIcon('monitor-cog', 'text-accent'), lines(title, refused === undefined ? 'Process displays open in the Leitbild workspace' : refused, { titleTooltip: true, wrapSubtitle: false }), action)
      return chip
    },
  })
}

/** Once the Host has announced itself, every chip that linked to the Workspace page opens the display instead. */
export const promoteUnhostedChips = (root: ParentNode, actions: ChipActions): void => {
  for (const host of root.querySelectorAll<HTMLElement>('[data-live-view="unhosted"]')) {
    const listing = chipListings.get(host)
    if (listing === undefined) throw new Error('A display chip linking to the Workspace page lost its listing')
    showAvailable(host, listing, actions)
  }
}

/** The listing of the first chip under `root` that opens its display in the window, if any. */
export const firstAvailableListing = (root: ParentNode): EmbeddedViewListing | null => {
  const host = root.querySelector<HTMLElement>('[data-live-view="available"]')
  return host === null ? null : chipListings.get(host) ?? null
}

/** Fences outside a posted answer (human messages, comparison reruns) never become displays. */
export const fenceNotice = (text: string): HTMLElement => element('div', 'my-2 px-3 py-2 rounded border border-border text-xs text-text-muted', text)

const KEY_TOKEN = /⟦(k\d+)⟧/g

/**
 * A chip for one cited key: its line's words, and a press that opens the frozen card at its line. A key on a card this
 * answer shows is a button; a key on no card, or on a card whose display the answer does not show, says so.
 */
const keyChip = (container: HTMLElement, key: string, read: TurnCardsRead, presented: ReadonlySet<string>): HTMLElement => {
  const found = read.kind === 'cards' ? read.cards.find(({ card }) => card.items.some(item => item.key === key)) : undefined
  const item = read.kind === 'cards' ? itemOf(read.cards, key) : undefined
  const shown = found !== undefined && presented.has(found.viewRef)
  const chip = element(shown ? 'button' : 'span',
    `inline-flex items-center px-1 mx-0.5 rounded border text-[11px] font-mono leading-tight ${item === undefined ? 'border-dashed border-border-strong text-text-subtle' : shown ? 'border-border text-text-muted interactive cursor-pointer hover:border-accent hover:text-accent' : 'border-border text-text-subtle'}`)
  chip.dataset.cites = key
  chip.textContent = item === undefined ? `${key}?` : key
  chip.title = item === undefined ? (read.kind === 'refused' ? `${key}: ${read.message}` : `${key} is on no card of this answer`)
    : `${key} · ${item.label} · ${item.reading}${shown ? '' : ' (on a display this answer does not show)'}`
  if (chip instanceof HTMLButtonElement) {
    chip.type = 'button'
    chip.onclick = event => {
      event.stopPropagation()
      revealLine(container, key)
    }
  }
  return chip
}

/**
 * Replaces each ⟦k⟧ in an answer's prose (never in code or a display chip) with its key chip; `presented` holds the
 * viewRefs of the displays the answer shows, whose cards hold their lines.
 */
export const citeKeys = (container: HTMLElement, read: TurnCardsRead, presented: ReadonlySet<string>): void => {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent?.includes('⟦k') && node.parentElement?.closest('code, pre, [data-live-view]') === null) texts.push(node as Text)
  }
  for (const text of texts) {
    const parts: Array<string | HTMLElement> = []
    let last = 0
    for (const match of text.data.matchAll(KEY_TOKEN)) {
      parts.push(text.data.slice(last, match.index), keyChip(container, match[1]!, read, presented))
      last = match.index! + match[0].length
    }
    text.replaceWith(...parts, text.data.slice(last))
  }
}

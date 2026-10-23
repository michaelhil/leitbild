// The cards a posted answer's turn returned, keyed as the answer cites them
// (the Agents cards route re-keys the turn's stored calls): the frozen card on
// a display chip and the chips that stand for each ⟦k⟧ in the answer. Pure:
// no DOM, no stores.
import { z } from 'zod'
import { displayCardSchema, type DisplayCard, type DisplayCardItem } from '@leitbild/contracts'

const turnCardsSchema = z.object({ cards: z.array(z.object({ viewRef: z.string().min(1), card: displayCardSchema }).strict()) }).strict()

export type TurnCardList = ReadonlyArray<{ readonly viewRef: string; readonly card: DisplayCard }>
export type TurnCardsRead = { readonly kind: 'cards'; readonly cards: TurnCardList } | { readonly kind: 'refused'; readonly message: string }
type FetchJson = (path: string) => Promise<{ readonly status: number; readonly body: unknown }>

/** One read per answer turn for the life of the page; a failure is kept and shown like a result, so chips agree. */
export const createTurnCardsReader = (fetchJson: FetchJson): ((roomId: string, turnId: string) => Promise<TurnCardsRead>) => {
  const reads = new Map<string, Promise<TurnCardsRead>>()
  return (roomId, turnId) => {
    const key = `${roomId}/${turnId}`
    const cached = reads.get(key)
    if (cached !== undefined) return cached
    const read = (async (): Promise<TurnCardsRead> => {
      const response = await fetchJson(`/rooms/${encodeURIComponent(roomId)}/executions/${encodeURIComponent(turnId)}/cards`)
      if (response.status !== 200) return { kind: 'refused', message: `reading this answer's cards failed with HTTP ${response.status}` }
      return { kind: 'cards', cards: turnCardsSchema.parse(response.body).cards }
    })().catch((error: unknown): TurnCardsRead => ({ kind: 'refused', message: `this answer's cards are unreadable (${error instanceof Error ? error.message : String(error)})` }))
    reads.set(key, read)
    return read
  }
}

/** The lines a frozen card shows before "N more lines" (W7.1). */
export const FROZEN_LINES = 3
/** What an answer's vignette is, as its live footer says it (World's provenanceMark for an Assistant's view): never an operating display. */
export const PROVENANCE_MARK = 'AI-composed, not an operating display'

/** One line of a frozen card: label | value, with the keys it stands for (several where items differ only by their object). */
export interface CardLine {
  readonly keys: ReadonlyArray<string>
  /** Its label without the object the card names once; '' where the object was all it named. */
  readonly label: string
  /** The item's reading, whole. */
  readonly value: string
  /** The answer cites one of its keys. */
  readonly cited: boolean
}

/** What a chip shows of its card: when it was read and what it is, its lines (the cited first), and what only the live display shows. */
export interface FrozenCard {
  readonly meta: string
  readonly lines: ReadonlyArray<CardLine>
  /** The lines shown before "N more lines": at most FROZEN_LINES. */
  readonly shown: number
  /** Items the card leaves to the live display (its `more`). */
  readonly elsewhere: number
}

const KEY_CITE = /⟦(k\d+)⟧/g

/** The keys an answer cites, in the order it first cites them. */
export const citedKeys = (content: string): ReadonlyArray<string> => [...new Set([...content.matchAll(KEY_CITE)].map(match => match[1]!))]

/** Labels that differ only by their last words, written once: "Halden Unit 1, 2, 3, 4"; otherwise listed. */
export const objectsText = (names: ReadonlyArray<string>): string => {
  const words = names.map(name => name.split(' '))
  const shortest = Math.min(...words.map(list => list.length))
  let common = 0
  while (common < shortest - 1 && words.every(list => list[common] === words[0]![common])) common += 1
  return common === 0 ? names.join(', ') : `${words[0]!.slice(0, common).join(' ')} ${words.map(list => list.slice(common).join(' ')).join(', ')}`
}

/**
 * A card as its chip shows it (W7.1): each item as label | reading, the object named once (in the label where the
 * card is about several); items alike but for their object as one line naming them all; the lines the answer cites
 * first, in the order it cites them; at most three before "N more lines". Every line is there, so every key resolves.
 */
export const frozenCard = (card: DisplayCard, cited: ReadonlyArray<string> = []): FrozenCard => {
  const objects = new Set(card.items.map(item => item.object))
  const oneObject = objects.size === 1 && !objects.has(undefined)
  const rest = (item: DisplayCardItem): string => item.object === undefined ? item.label : item.label === item.object ? '' : item.label.slice(item.object.length + 3)
  const groups = new Map<string, DisplayCardItem[]>()
  for (const item of card.items) {
    const same = item.object === undefined || oneObject ? item.key : `${rest(item)}\u0000${item.reading}`
    groups.set(same, [...groups.get(same) ?? [], item])
  }
  const lines = [...groups.values()].map((items): CardLine => {
    const [first] = items as [DisplayCardItem]
    const label = oneObject ? rest(first)
      : items.length === 1 ? first.label : [objectsText(items.map(item => item.object!)), rest(first)].filter(part => part !== '').join(' · ')
    return { keys: items.map(item => item.key), label, value: first.reading, cited: items.some(item => cited.includes(item.key)) }
  })
  const firstCited = (line: CardLine): number => Math.min(...line.keys.map(key => cited.indexOf(key)).filter(at => at >= 0))
  const ordered = [...lines.filter(line => line.cited).sort((left, right) => firstCited(left) - firstCited(right)), ...lines.filter(line => !line.cited)]
  return {
    meta: `Frozen at ${card.at.clock === 'simulation' ? 'sim ' : ''}${card.at.at.slice(11, 19)} · ${PROVENANCE_MARK}`,
    lines: ordered,
    shown: Math.min(FROZEN_LINES, ordered.length),
    elsewhere: card.more,
  }
}

/** A frozen card's line as assistive technology reads it. */
export const cardLineText = (line: CardLine): string => `${line.label === '' ? '' : `${line.label}: `}${line.value} (${line.keys.join(', ')})`

/** A frozen card as assistive technology reads it, apart from the chip's actions: title, what it is, every line, what only the live display shows. */
export const frozenCardText = (title: string, frozen: FrozenCard): string =>
  [title, frozen.meta, ...frozen.lines.map(cardLineText), ...(frozen.elsewhere > 0 ? [`${frozen.elsewhere} more on the live display`] : [])].join('. ')

/** The line a key names on the turn's cards, if any. */
export const itemOf = (cards: TurnCardList, key: string): DisplayCardItem | undefined => {
  for (const { card } of cards) {
    const item = card.items.find(candidate => candidate.key === key)
    if (item !== undefined) return item
  }
  return undefined
}

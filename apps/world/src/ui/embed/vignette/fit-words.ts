import { wordsThatFit } from './alerts.ts'

/**
 * As many whole words of `text` as fit (wordsThatFit), then "…"; nothing where not even its first word fits: a word is
 * never cut (plan v5 §2 rule 2), as wordsThatFit's last resort would ("Frequenc…").
 */
export const wholeWordsThatFit = (text: string, fits: (shown: string) => boolean): string => {
  const shown = wordsThatFit(text, fits)
  const kept = shown.endsWith('…') ? shown.slice(0, -1) : shown
  return kept === text || (kept !== '' && text.startsWith(kept) && /^[\s,;:·]/.test(text.slice(kept.length))) ? shown : ''
}

/**
 * A Svelte action: the node shows as many whole words of `text` as its room holds (wholeWordsThatFit: whole words,
 * then "…"), and nothing where not one whole word does, fitted again whenever its room or the text changes. The node
 * needs a width of its own and hidden overflow; the whole text belongs in its title or its accessible name.
 */
export const wholeWords = (node: HTMLElement, text: string) => {
  let full = text
  const fit = (): void => {
    node.textContent = wholeWordsThatFit(full, candidate => {
      node.textContent = candidate
      return node.scrollWidth <= node.clientWidth
    })
  }
  fit()
  const resized = new ResizeObserver(fit)
  resized.observe(node)
  return { update: (next: string) => { full = next; fit() }, destroy: () => resized.disconnect() }
}

/**
 * The parts of a line that fit its room, joined by " · ": all where they fit; else without the parts `giving` names,
 * one more each time, first first; then the first part's whole words (wholeWordsThatFit). The parts' order never changes.
 */
export const partsThatFit = (parts: ReadonlyArray<string>, giving: ReadonlyArray<number>, fits: (shown: string) => boolean): string => {
  const join = (dropped: ReadonlySet<number>): string => parts.filter((_, at) => !dropped.has(at)).join(' · ')
  for (let count = 0; count <= giving.length; count += 1) {
    const shown = join(new Set(giving.slice(0, count)))
    if (fits(shown)) return shown
  }
  return wholeWordsThatFit(join(new Set(giving)), fits)
}

/** A Svelte action: the node shows the parts that fit its room (partsThatFit), fitted again whenever its room or the parts change; the whole line belongs in its title or its accessible name. */
export const wholeParts = (node: HTMLElement, line: { readonly parts: ReadonlyArray<string>; readonly giving: ReadonlyArray<number> }) => {
  let current = line
  const fit = (): void => {
    node.textContent = partsThatFit(current.parts, current.giving, candidate => {
      node.textContent = candidate
      return node.scrollWidth <= node.clientWidth
    })
  }
  fit()
  const resized = new ResizeObserver(fit)
  resized.observe(node)
  return { update: (next: typeof line) => { current = next; fit() }, destroy: () => resized.disconnect() }
}

/**
 * A Svelte action: the node shows the first of `texts` (each a whole statement, the longest first) that fits its room,
 * else the last's whole words (wholeWordsThatFit), fitted again whenever its room or the texts change. The first belongs in
 * its title or its accessible name.
 */
export const firstFitting = (node: HTMLElement, texts: ReadonlyArray<string>) => {
  let current = texts
  const fits = (candidate: string): boolean => { node.textContent = candidate; return node.scrollWidth <= node.clientWidth }
  const fit = (): void => { node.textContent = current.find(fits) ?? wholeWordsThatFit(current.at(-1) ?? '', fits) }
  fit()
  const resized = new ResizeObserver(fit)
  resized.observe(node)
  return { update: (next: ReadonlyArray<string>) => { current = next; fit() }, destroy: () => resized.disconnect() }
}

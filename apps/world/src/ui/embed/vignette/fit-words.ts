import { wordsThatFit } from './alerts.ts'

/**
 * A Svelte action: the node shows as many whole words of `text` as its room holds (wordsThatFit: whole words, then
 * "…"), and nothing where not one letter of it does (a lone "…" says nothing), fitted again whenever its room or the
 * text changes. The node needs a width of its own and hidden overflow; the whole text belongs in its title or its
 * accessible name.
 */
export const wholeWords = (node: HTMLElement, text: string) => {
  let full = text
  const fit = (): void => {
    const shown = wordsThatFit(full, candidate => {
      node.textContent = candidate
      return node.scrollWidth <= node.clientWidth
    })
    node.textContent = shown === '…' ? '' : shown
  }
  fit()
  const resized = new ResizeObserver(fit)
  resized.observe(node)
  return { update: (next: string) => { full = next; fit() }, destroy: () => resized.disconnect() }
}

/**
 * The parts of a line that fit its room, joined by " · ": all where they fit; else without the parts `giving` names,
 * one more each time, first first; then the first part's whole words (wordsThatFit). The parts' order never changes.
 */
export const partsThatFit = (parts: ReadonlyArray<string>, giving: ReadonlyArray<number>, fits: (shown: string) => boolean): string => {
  const join = (dropped: ReadonlySet<number>): string => parts.filter((_, at) => !dropped.has(at)).join(' · ')
  for (let count = 0; count <= giving.length; count += 1) {
    const shown = join(new Set(giving.slice(0, count)))
    if (fits(shown)) return shown
  }
  return wordsThatFit(join(new Set(giving)), fits)
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
 * else the last's whole words (wordsThatFit), fitted again whenever its room or the texts change. The first belongs in
 * its title or its accessible name.
 */
export const firstFitting = (node: HTMLElement, texts: ReadonlyArray<string>) => {
  let current = texts
  const fits = (candidate: string): boolean => { node.textContent = candidate; return node.scrollWidth <= node.clientWidth }
  const fit = (): void => { node.textContent = current.find(fits) ?? wordsThatFit(current.at(-1) ?? '', fits) }
  fit()
  const resized = new ResizeObserver(fit)
  resized.observe(node)
  return { update: (next: ReadonlyArray<string>) => { current = next; fit() }, destroy: () => resized.disconnect() }
}

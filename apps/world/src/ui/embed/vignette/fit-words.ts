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

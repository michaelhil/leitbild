// OpenBridge's automation buttons (obc-automation-button, and obc-switch, obc-transformer and obc-source drawn over
// one) render a <button> of their own inside their shadow roots. In a drawing an item's body is its button (W6.1,
// W9.1), so the symbol's own button would be a second, nameless tab stop on every device (W8.3 Tab order) and a
// button inside a button for a screen reader. This keeps the symbol's look, its hover included, and takes its button
// out of the tab order and the accessibility tree once it has rendered; a press on it is the item's, as before.

type Rendered = Element & { readonly updateComplete?: Promise<unknown> }

/** Each custom element's buttons, through nested shadow roots, once each element has rendered. */
const quieten = async (host: Rendered): Promise<void> => {
  if (host.localName.includes('-')) await customElements.whenDefined(host.localName)
  await host.updateComplete
  const root = host.shadowRoot
  if (root === null) return
  for (const button of root.querySelectorAll('button')) {
    button.tabIndex = -1
    button.setAttribute('aria-hidden', 'true')
  }
  await Promise.all([...root.querySelectorAll('*')].filter(element => element.localName.includes('-')).map(element => quieten(element)))
}

/** A Svelte action on an OpenBridge symbol inside an item's button. */
export const symbolOnly = (host: HTMLElement): void => { void quieten(host) }

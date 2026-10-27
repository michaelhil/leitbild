/** Test driver for the public Host View menu. No private state or product hook.
 * Kept self-contained so isolated CDP runners can evaluate this function. */
export const nativeMapStartup = async (openControls = true) => {
  const wait = async <T>(read: () => T | null | undefined | false, label: string): Promise<T> => {
    const started = performance.now()
    for (;;) {
      const value = read(); if (value) return value
      if (performance.now() - started > 45_000) throw new Error(`Native map startup did not expose ${label}`)
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
  }
  const frame = await wait(() => document.querySelector<HTMLIFrameElement>('iframe[src*="/world/runs/"]'), 'the World Run frame')
  await wait(() => frame.contentDocument?.querySelector('.maplibregl-canvas'), 'the geographic map')
  const doc = frame.contentDocument!
  const viewButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.getAttribute('aria-label') === 'View' || button.textContent?.trim() === 'View') && button.getBoundingClientRect().width > 0)
  // Historical diagnostic builds opened the real controls directly. This path
  // is explicitly recorded and cannot satisfy the new clean-start acceptance.
  await wait(() => viewButton() || doc.querySelector('.explorer-controls'), 'the Host View control or historical diagnostic controls')
  if (!viewButton() && doc.querySelector('.explorer-controls')) return { legacyAlreadyOpen: true, initial: null, openedControls: true }
  const view = await wait(() => { const button = viewButton(); return button && !button.disabled ? button : null }, 'the enabled Host View control')
  view.click()
  const menu = await wait(() => document.querySelector<HTMLElement>('[aria-label="Run view"]'), 'the Run view disclosure')
  const initial = [...menu.querySelectorAll('label')].map(label => ({ label: label.textContent?.trim() ?? '', checked: label.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked ?? null }))
  const toggle = [...menu.querySelectorAll('label')].find(label => label.textContent?.trim().startsWith('Layout controls'))?.querySelector<HTMLInputElement>('input[type=checkbox]')
  if (!toggle) throw new Error('Host View did not list Layout controls')
  if (openControls && !toggle.checked) toggle.click()
  if (view.getAttribute('aria-expanded') === 'true') view.click()
  const briefing = doc.querySelector<HTMLButtonElement>('[aria-label="Close scenario briefing"]')
  if (openControls) briefing?.click()
  if (openControls) await wait(() => doc.querySelector('.explorer-controls'), 'the requested Layout controls')
  return { legacyAlreadyOpen: false, initial, briefingInitiallyVisible: Boolean(briefing), openedControls: openControls }
}

/** Test driver for the World-owned View sheet. No private state or product hook.
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
  await wait(() => !doc.querySelector('.startup-modal-frame'), 'the completed public map startup')
  if (document.querySelector('button[aria-label="View"]')) throw new Error('World controls must not be rendered in the Host header')
  const view = await wait(() => doc.querySelector<HTMLButtonElement>('button[aria-label="View"]'), 'the World View control')
  view.click()
  const menu = await wait(() => doc.querySelector<HTMLElement>('[aria-label="Run view"]'), 'the Run view disclosure')
  const panels = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Panels')
  if (!panels) throw new Error('World View did not expose Panels')
  panels.click()
  await wait(() => menu.querySelector('input[type="checkbox"]'), 'declared panel choices')
  const initial = [...menu.querySelectorAll('label')].map(label => ({ label: label.textContent?.trim() ?? '', checked: label.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked ?? null }))
  const toggle = [...menu.querySelectorAll('label')].find(label => label.textContent?.trim().startsWith('Physical layout controls'))?.querySelector<HTMLInputElement>('input[type=checkbox]')
  if (!toggle) throw new Error('World View did not list Physical layout controls')
  if (openControls && !toggle.checked) toggle.click()
  if (view.getAttribute('aria-expanded') === 'true') view.click()
  const briefingInitiallyVisible = Boolean(doc.querySelector('.scenario-guidance'))
  if (openControls) {
    const guide = await wait(() => doc.querySelector<HTMLButtonElement>('button[aria-label^="Guide"]'), 'the separate Guide control')
    guide.click()
    const pause = await wait(() => [...doc.querySelectorAll<HTMLButtonElement>('[aria-label="Guidance options"] button')].find(button => button.textContent?.trim() === 'Pause guidance'), 'global Pause guidance')
    pause.click()
  }
  if (openControls) await wait(() => doc.querySelector('.explorer-controls'), 'the requested Layout controls')
  return { owner: 'world', initial, briefingInitiallyVisible, openedControls: openControls }
}

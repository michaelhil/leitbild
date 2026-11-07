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
  const panels = await wait(() => [...menu.querySelectorAll<HTMLHeadingElement>('h3')].find(heading => heading.textContent?.trim() === 'Panels')?.parentElement, 'declared panel choices')
  const initial = [...panels.querySelectorAll('label')].map(label => ({ label: label.textContent?.trim() ?? '', checked: label.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked ?? null }))
  const toggle = [...panels.querySelectorAll('label')].find(label => label.textContent?.trim().startsWith('Physical layout controls'))?.querySelector<HTMLInputElement>('input[type=checkbox]')
  if (!toggle) throw new Error('World View did not list Physical layout controls')
  if (openControls && !toggle.checked) toggle.click()
  if (view.getAttribute('aria-expanded') === 'true') view.click()
  const briefingInitiallyVisible = Boolean(doc.querySelector('.scenario-guidance'))
  if (openControls && briefingInitiallyVisible) {
    const guide = await wait(() => doc.querySelector<HTMLButtonElement>('button[aria-label^="Guide"]'), 'the separate Guide control')
    guide.click()
    const updates = await wait(() => doc.querySelector<HTMLDetailsElement>('[aria-label="Guide"] details.timed-cards'), 'Scenario update controls')
    updates.open = true
    const pause = await wait(() => [...updates.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Pause map updates'), 'Pause map updates')
    pause.click()
    if (guide.getAttribute('aria-expanded') === 'true') guide.click()
  }
  if (openControls) await wait(() => doc.querySelector('.explorer-controls'), 'the requested Layout controls')
  return { owner: 'world', initial, briefingInitiallyVisible, openedControls: openControls }
}

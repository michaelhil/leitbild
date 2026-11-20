/** Test driver for the World-owned Run page controls: the rail's Tools and the Guide. No private state or product hook.
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
  // The rail's Tools section is the one home of the panel toggles. A scripted click is sent to them without opening a
  // collapsed rail or a narrow window's Menu drawer first.
  const tools = await wait(() => doc.querySelector<HTMLElement>('.control-rail .pack-tools'), 'the rail\'s Tools')
  const toggles = [...tools.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
  const initial = toggles.map(button => ({ label: button.textContent?.trim() ?? '', checked: button.getAttribute('aria-pressed') === 'true' }))
  const toggle = toggles.find(button => button.textContent?.trim() === 'Layout controls')
  if (!toggle) throw new Error('The rail\'s Tools did not list Layout controls')
  if (openControls && toggle.getAttribute('aria-pressed') !== 'true') toggle.click()
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

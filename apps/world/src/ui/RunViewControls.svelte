<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte'
  import type { RunViewPreferences } from './run-view-preferences.ts'
  import type { MapCover } from './surface-panel-contract.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'

  interface Props {
    alarms: number
    alarmsVisible: boolean
    showAlarms: (visible: boolean) => void
    guidance: { readonly available: boolean; readonly visible: boolean; readonly unread: boolean; readonly instruction: { readonly id: string; readonly title: string; readonly message: string } | null }
    setGuidance: (mode: RunViewPreferences['guidance']['mode']) => void
    onReadUpdate: (id: string) => void
    clear: MapCover
    ready: boolean
    /** The World shell keeps active guidance reachable over a live display. */
    raised: boolean
    foregroundProcedure?: boolean
    guideContent?: Snippet
    hasGuide?: boolean
    guideBadge: 'Start' | 'Resume' | 'Suggestion' | undefined
  }
  let { alarms, alarmsVisible, showAlarms, guidance, setGuidance, onReadUpdate, clear, ready, raised, foregroundProcedure = false, guideContent, hasGuide = false, guideBadge }: Props = $props()
  let root = $state<HTMLDivElement | null>(null)
  let alarmsTrigger = $state<HTMLButtonElement | null>(null)
  let guideTrigger = $state<HTMLButtonElement | null>(null)
  let sheet = $state<HTMLElement | null>(null)
  /** The Guide sheet, the dock's one disclosure. */
  let open = $state(false)
  let updateExpanded = $state(false)
  let geometry = $state({ left: 12, right: 12, bottom: 52, height: 300, short: false })
  let remeasure: (() => void) | null = null
  const guideStatus = $derived(guideBadge ?? (guidance.unread ? 'Update' : undefined))
  $effect(() => {
    void geometry
    const instruction = guidance.instruction
    if (open && !foregroundProcedure && updateExpanded && instruction && sheet && sheet.clientWidth > 0 && sheet.clientHeight > 0) {
      untrack(() => onReadUpdate(instruction.id))
    }
  })

  const close = (returnFocus = false): void => {
    open = false
    if (returnFocus && !foregroundProcedure) guideTrigger?.focus({ preventScroll: true })
  }
  export const dismiss = (): void => close(true)
  export const revealGuide = async (focus = true): Promise<void> => {
    if (foregroundProcedure) throw new Error('Close the procedure window to use the World controls.')
    if (!open) await disclose(focus)
  }
  const disclose = async (focus = true): Promise<void> => {
    if (open) { close(true); return }
    updateExpanded = !hasGuide
    open = true
    await tick()
    if (!open || foregroundProcedure) return
    if (focus) sheet?.focus({ preventScroll: true })
    remeasure?.()
  }
  const toggleAlarms = async (): Promise<void> => {
    const visible = !alarmsVisible
    const focusOwner = document.activeElement
    if (visible) close()
    showAlarms(visible)
    if (!visible) return
    await tick()
    const currentFocus = document.activeElement
    if (!foregroundProcedure && (currentFocus === focusOwner || currentFocus === alarmsTrigger || currentFocus === document.body)) {
      document.getElementById('run-alert-strip')?.focus({ preventScroll: true })
    }
  }
  // Guide is a working surface while the person operates the map or a panel: it stays open until closed.
  const toggleGuide = (): void => {
    if (alarmsVisible && !open) showAlarms(false)
    void disclose()
  }
  const key = (event: KeyboardEvent): void => {
    if (open && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(true) }
  }
  const ownKeys = (event: KeyboardEvent): void => {
    key(event)
    if (event.key !== 'Escape') event.stopPropagation()
  }
  $effect(() => { void clear; void ready; void guidance; void foregroundProcedure; remeasure?.() })

  runOnMount(() => {
    const element = root, main = element?.parentElement
    if (!element || !main) throw new Error('The Run dock requires its World surface')
    const observed = new Set<Element>()
    const measure = (): void => {
      const bounds = main.getBoundingClientRect()
      const viewport = window.visualViewport
      const visibleBottom = Math.min(bounds.bottom, viewport ? viewport.offsetTop + viewport.height : innerHeight)
      const obstacles = [...main.querySelectorAll<HTMLElement>('.world-status-line, .maplibregl-ctrl-attrib, .maplibregl-ctrl-bottom-right .maplibregl-ctrl-group, .maplibregl-ctrl-bottom-left .maplibregl-ctrl-group')]
      const instruction = main.closest('.app-shell')?.querySelector<HTMLElement>('.scenario-guidance')
      const current = new Set<Element>([main, element, ...obstacles, ...(instruction ? [instruction] : [])])
      for (const previous of observed) if (!current.has(previous)) { observer.unobserve(previous); observed.delete(previous) }
      for (const target of current) if (!observed.has(target)) { observed.add(target); observer.observe(target) }
      let bottom = Math.max(clear.bottom, bounds.bottom - visibleBottom)
      const inset = 12
      let navigationLeft = 0, navigationRight = 0
      for (const obstacle of obstacles) {
        const rect = obstacle.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || rect.right <= bounds.left || rect.left >= bounds.right) continue
        if (obstacle.classList.contains('maplibregl-ctrl-group')) {
          // Navigation stays beside the launcher; the attribution and status
          // stay below it. A tall zoom control must not push the whole sheet
          // out of a short viewport (for example beside an open keyboard).
          if (obstacle.closest('.maplibregl-ctrl-bottom-right')) navigationRight = Math.max(navigationRight, bounds.right - rect.left)
          else navigationLeft = Math.max(navigationLeft, rect.right - bounds.left)
        } else bottom = Math.max(bottom, bounds.bottom - rect.top)
      }
      // Preserve the zoom controls. Fit optional Pack clearance in the space
      // left after reserving room to read the sheet on a narrow pane.
      const extraLeft = Math.max(0, clear.left - navigationLeft)
      const extraRight = Math.max(0, clear.right - navigationRight)
      const coverBudget = Math.max(0, bounds.width - 2 * inset - 240 - navigationLeft - navigationRight)
      const scale = Math.min(1, coverBudget / Math.max(1, extraLeft + extraRight))
      const left = navigationLeft + extraLeft * scale, right = navigationRight + extraRight * scale
      let top = clear.top
      if (instruction) {
        top = Math.max(top, instruction.getBoundingClientRect().bottom - bounds.top)
      }
      // Panel covers are measured by their owners. Keep a reachable strip when
      // a panel uses all of a narrow map; do not resize or wake the map here.
      const launcherHeight = element.querySelector('.dock-launchers')?.getBoundingClientRect().height ?? 50
      const visibleHeight = Math.max(0, visibleBottom - bounds.top)
      // A disclosure needs room for a 44 px action plus its padding. When a
      // split pane is shorter (for example above a keyboard), controls take
      // priority over the bottom attribution/status reserve. Their whole
      // scrollport must stay inside this World pane.
      const minimumSheet = Math.min(76, Math.max(0, visibleHeight - launcherHeight - 8))
      const minimumContent = launcherHeight + (open ? minimumSheet + 8 : 0)
      const verticalInset = Math.min(inset, Math.max(0, (visibleHeight - minimumContent) / 2))
      bottom = Math.min(bottom, Math.max(0, visibleHeight - minimumContent - verticalInset * 2))
      const availableHeight = visibleHeight - bottom - verticalInset * 2 - launcherHeight - 8
      // The active disclosure can temporarily cover an instruction when the
      // viewport is too short for both. Guide Pause/Resume remains reachable.
      const clearTop = Math.min(top, Math.max(0, availableHeight - minimumSheet))
      geometry = { left: inset + left, right: inset + right, bottom: bottom + verticalInset, height: Math.max(minimumSheet, availableHeight - clearTop), short: visibleHeight <= 280 }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(main); observer.observe(element)
    // Only map-control DOM and direct surface composition are relevant; no
    // observation of objects, model geometry or high-frequency value changes.
    const controls = main.querySelector('.maplibregl-control-container')
    const mutations = new MutationObserver(measure)
    mutations.observe(main, { childList: true })
    if (controls) mutations.observe(controls, { childList: true, subtree: true })
    window.addEventListener('resize', measure)
    viewportListen(true)
    function viewportListen(add: boolean): void {
      const viewport = window.visualViewport
      if (add) { viewport?.addEventListener('resize', measure); viewport?.addEventListener('scroll', measure) }
      else { viewport?.removeEventListener('resize', measure); viewport?.removeEventListener('scroll', measure) }
    }
    remeasure = measure
    measure()
    return () => { remeasure = null; observer.disconnect(); mutations.disconnect(); window.removeEventListener('resize', measure); viewportListen(false) }
  })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="run-view-tools" class:short-pane={geometry.short} data-world-disclosure bind:this={root} hidden={foregroundProcedure} inert={foregroundProcedure} onkeydown={ownKeys} style:left={`${geometry.left}px`} style:right={`${geometry.right}px`} style:bottom={`${geometry.bottom}px`} style:z-index={raised && !foregroundProcedure ? 94 : 26} style:--sheet-height={`${geometry.height}px`}>
  {#if open}
    <section id="run-guide-options" class="dock-sheet" aria-label="Guide" tabindex="-1" bind:this={sheet}>
      <header><h2>Guide</h2><button class="close" type="button" aria-label="Close Guide" onclick={() => close(true)}>×</button></header>
      {#if guideContent}{@render guideContent()}{/if}
      {#if guidance.available}
        <details class="sheet-section timed-cards" bind:open={updateExpanded}>
          <summary>Scenario update{guidance.unread ? ' · new' : ''}</summary>
          {#if guidance.instruction}<div class="current-instruction"><strong>{guidance.instruction.title}</strong><p>{guidance.instruction.message}</p></div>{/if}
          {#if raised}
            <small>Map update controls are available when you return to the map.</small>
          {:else}
            <button type="button" onclick={() => {
              const showOnMap = !guidance.visible
              setGuidance(showOnMap ? 'running' : 'paused')
              if (showOnMap) close(true)
            }}>{guidance.visible ? 'Pause map updates' : 'Show on map'}</button>
          {/if}
        </details>
      {/if}
    </section>
  {/if}
  <nav class="dock-launchers" aria-label="World controls">
    <button id="run-alarms-trigger" bind:this={alarmsTrigger} type="button" aria-label={`Alarms · ${alarms} unacknowledged`} aria-expanded={alarmsVisible} aria-controls={alarmsVisible ? 'run-alert-strip' : undefined} onclick={() => void toggleAlarms()}>Alarms <strong>{alarms}</strong></button>
    <button id="run-guide-trigger" bind:this={guideTrigger} type="button" aria-label={guideStatus ? `Guide · ${guideStatus}` : 'Guide'} aria-expanded={open} aria-controls={open ? 'run-guide-options' : undefined} onclick={toggleGuide}>Guide{#if guideStatus}<span class="guide-badge">{guideStatus}</span>{/if}</button>
  </nav>
</div>

<style>
  .run-view-tools { position: absolute; z-index: 26; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; font-size: 13px; color: var(--text); }
  .run-view-tools[hidden] { display: none; }
  .dock-launchers { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; pointer-events: auto; padding: 3px; max-width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 20px; background: color-mix(in srgb, var(--panel) 96%, transparent); box-shadow: 0 3px 12px rgb(0 0 0 / 12%); }
  button { font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); min-height: 38px; padding: 7px 11px; }
  button:disabled { opacity: .65; cursor: default; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dock-launchers button { border-color: transparent; border-radius: 16px; background: transparent; display: inline-flex; gap: 6px; align-items: center; }
  button:hover:not(:disabled), .dock-launchers button[aria-expanded='true'] { background: color-mix(in srgb, var(--accent) 12%, var(--panel)); border-color: var(--accent); }
  .dock-sheet { box-sizing: border-box; pointer-events: auto; width: min(520px, 100%); max-height: var(--sheet-height); overflow: auto; overscroll-behavior: contain; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); box-shadow: 0 8px 28px rgb(0 0 0 / 20%); }
  .dock-sheet:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  h2 { font-size: 16px; margin: 0; }
  .close { font-size: 20px; line-height: 1; min-width: 38px; padding: 2px 8px; background: transparent; }
  .sheet-section { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 9px; }
  small { display: block; color: var(--muted); font-size: 11px; line-height: 1.4; }
  summary { cursor: pointer; min-height: 32px; line-height: 1.5; font-weight: 650; }
  summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .current-instruction { padding: 10px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel-strong); }
  .current-instruction p { margin-bottom: 0; }
  .guide-badge { border-radius: 8px; padding: 1px 5px; background: color-mix(in srgb, var(--accent) 12%, var(--panel)); color: var(--text); font-size: 10px; }
  @media (pointer: coarse) { button, summary { min-height: 44px; } }
  /* A short World split needs a single reachable launcher row. Status stays in
     accessible names; keyboard focus can scroll the row on narrower surfaces. */
  .short-pane .dock-launchers { flex-wrap: nowrap; justify-content: flex-start; overflow-x: auto; gap: 2px; }
  .short-pane .dock-launchers button { flex: none; padding-inline: 6px; }
  .short-pane .guide-badge { width: 6px; height: 6px; padding: 0; font-size: 0; background: var(--accent); }
  @media (prefers-reduced-transparency: reduce), (forced-colors: active) { .dock-launchers { background: var(--panel); } }
</style>

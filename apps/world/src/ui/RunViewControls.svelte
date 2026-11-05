<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte'
  import { arrangeRunViewCamera, type RunViewCameraAction, type RunViewChoice } from './run-view-actions.ts'
  import type { RunViewPreferences } from './run-view-preferences.ts'
  import type { MapCover } from './surface-panel-contract.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'

  interface Props {
    camera: ReadonlyArray<RunViewCameraAction>
    layers: ReadonlyArray<RunViewChoice>
    panels: ReadonlyArray<RunViewChoice>
    act: (id: string) => void
    toggle: (id: string, visible: boolean) => void
    reset: () => void
    resetDisabledReason: string | undefined
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
    guideBadge?: 'Start' | 'Resume' | 'Suggestion'
  }
  let { camera, layers, panels, act, toggle, reset, resetDisabledReason, alarms, alarmsVisible, showAlarms, guidance, setGuidance, onReadUpdate, clear, ready, raised, foregroundProcedure = false, guideContent, hasGuide = false, guideBadge }: Props = $props()
  let root = $state<HTMLDivElement | null>(null)
  let viewTrigger = $state<HTMLButtonElement | null>(null)
  let alarmsTrigger = $state<HTMLButtonElement | null>(null)
  let guideTrigger = $state<HTMLButtonElement | null>(null)
  let sheet = $state<HTMLElement | null>(null)
  let open = $state<'view' | 'guide' | null>(null)
  let updateExpanded = $state(false)
  let geometry = $state({ left: 12, right: 12, bottom: 52, height: 300, short: false })
  let remeasure: (() => void) | null = null
  const cameraActions = $derived(arrangeRunViewCamera(camera))
  const guideStatus = $derived(guideBadge ?? (guidance.unread ? 'Update' : undefined))
  $effect(() => {
    void geometry
    const instruction = guidance.instruction
    if (open === 'guide' && !foregroundProcedure && updateExpanded && instruction && sheet && sheet.clientWidth > 0 && sheet.clientHeight > 0) {
      untrack(() => onReadUpdate(instruction.id))
    }
  })

  const close = (returnFocus = false): void => {
    const trigger = open === 'guide' ? guideTrigger : viewTrigger
    open = null
    if (returnFocus && !foregroundProcedure) trigger?.focus({ preventScroll: true })
  }
  export const dismiss = (): void => close(true)
  export const reveal = async (which: 'view' | 'guide', focus = true): Promise<void> => {
    if (foregroundProcedure) throw new Error('Close the procedure window to use the World controls.')
    if (open !== which) await disclose(which, focus)
  }
  const disclose = async (which: 'view' | 'guide', focus = true): Promise<void> => {
    if (open === which) { close(true); return }
    if (which === 'guide') updateExpanded = !hasGuide
    open = which
    await tick()
    if (open !== which || foregroundProcedure) return
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
  const openDockSheet = (which: 'view' | 'guide'): void => {
    if (alarmsVisible && open !== which) showAlarms(false)
    void disclose(which)
  }
  // Guide is a working surface while the person operates the map or a panel.
  // View remains a quick disclosure that can be dismissed by leaving it.
  const outside = (event: PointerEvent): void => { if (open === 'view' && event.target instanceof Node && !root?.contains(event.target)) close() }
  const key = (event: KeyboardEvent): void => {
    if (open && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(true) }
  }
  const ownKeys = (event: KeyboardEvent): void => { key(event); event.stopPropagation() }
  const focusout = (event: FocusEvent): void => { if (open === 'view' && event.relatedTarget instanceof Node && !root?.contains(event.relatedTarget)) close() }
  $effect(() => { void clear; void ready; void guidance; void foregroundProcedure; remeasure?.() })

  runOnMount(() => {
    const element = root, main = element?.parentElement
    if (!element || !main) throw new Error('Run View controls require their World surface')
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
      const maxCovered = Math.max(0, bounds.width - 240)
      const scale = clear.left + clear.right > maxCovered ? maxCovered / Math.max(1, clear.left + clear.right) : 1
      let left = clear.left * scale, right = clear.right * scale
      for (const obstacle of obstacles) {
        const rect = obstacle.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || rect.right <= bounds.left || rect.left >= bounds.right) continue
        if (obstacle.classList.contains('maplibregl-ctrl-group')) {
          // Navigation stays beside the launcher; the attribution and status
          // stay below it. A tall zoom control must not push the whole sheet
          // out of a short viewport (for example beside an open keyboard).
          if (obstacle.closest('.maplibregl-ctrl-bottom-right')) right = Math.max(right, bounds.right - rect.left)
          else left = Math.max(left, rect.right - bounds.left)
        } else bottom = Math.max(bottom, bounds.bottom - rect.top)
      }
      let top = clear.top
      if (instruction) {
        top = Math.max(top, instruction.getBoundingClientRect().bottom - bounds.top)
      }
      // Panel covers are measured by their owners. Keep a reachable strip when
      // a panel uses all of a narrow map; do not resize or wake the map here.
      const launcherHeight = element.querySelector('.view-launchers')?.getBoundingClientRect().height ?? 50
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

<svelte:window onpointerdown={outside} />

{#snippet cameraButtons(actions: ReadonlyArray<RunViewCameraAction>)}
  <div class="camera-actions">
    {#each actions as action (action.id)}
      <button type="button" title={action.disabledReason} disabled={Boolean(action.disabledReason)} onclick={() => act(action.id)}>
        {action.label}
        {#if action.disabledReason}<small>{action.disabledReason}</small>{/if}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet viewChoices(choices: ReadonlyArray<RunViewChoice>)}
  {#each choices as choice (choice.id)}
    <label title={choice.disabledReason}>
      <input type="checkbox" checked={choice.visible} disabled={Boolean(choice.disabledReason)} onchange={event => toggle(choice.id, event.currentTarget.checked)} />
      <span>{choice.label}{#if choice.disabledReason}<small>{choice.disabledReason}</small>{/if}</span>
    </label>
  {/each}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="run-view-tools" class:short-pane={geometry.short} data-world-disclosure bind:this={root} hidden={foregroundProcedure} inert={foregroundProcedure} onfocusout={focusout} onkeydown={ownKeys} style:left={`${geometry.left}px`} style:right={`${geometry.right}px`} style:bottom={`${geometry.bottom}px`} style:z-index={raised && !foregroundProcedure ? 94 : 26} style:--sheet-height={`${geometry.height}px`}>
  {#if open === 'view'}
    <section id="run-view-sheet" class="view-sheet" aria-label="Run view" tabindex="-1" bind:this={sheet}>
      <header><h2>View</h2><button class="close" type="button" aria-label="Close View controls" onclick={() => close(true)}>×</button></header>
      {@render cameraButtons(cameraActions.quick)}
      {#if panels.length > 0}
        <div class="view-section">
          <h3>Panels</h3>
          {@render viewChoices(panels)}
        </div>
      {/if}
      {#if layers.length > 0}
        <details class="view-section"><summary>Map layers</summary>{@render viewChoices(layers)}</details>
      {/if}
      <details class="view-section">
        <summary>More view controls</summary>
        {@render cameraButtons(cameraActions.more)}
        <button type="button" disabled={Boolean(resetDisabledReason)} onclick={reset}>Reset local view</button>
        <small>{resetDisabledReason ?? 'Restore the default map view, layers and panels.'}</small>
      </details>
    </section>
  {:else if open === 'guide'}
    <section id="run-guide-options" class="view-sheet guide-options" aria-label="Guide" tabindex="-1" bind:this={sheet}>
      <header><h2>Guide</h2><button class="close" type="button" aria-label="Close Guide" onclick={() => close(true)}>×</button></header>
      {#if guideContent}{@render guideContent()}{/if}
      {#if guidance.available}
        <details class="view-section timed-cards" bind:open={updateExpanded}>
          <summary>Scenario update{guidance.unread ? ' · new' : ''}</summary>
          {#if guidance.instruction}<div class="current-instruction"><strong>{guidance.instruction.title}</strong><p>{guidance.instruction.message}</p></div>{/if}
          <button type="button" onclick={() => {
            setGuidance(guidance.visible ? 'paused' : 'running')
            if (!guidance.visible && !raised) close(true)
          }}>{guidance.visible ? 'Pause map updates' : raised ? 'Resume map updates' : 'Show on map'}</button>
          {#if raised}<small>Map updates appear when you return to the map.</small>{/if}
        </details>
      {/if}
    </section>
  {/if}
  <nav class="view-launchers" aria-label="World controls">
    <button id="run-view-trigger" bind:this={viewTrigger} type="button" aria-label="View" aria-expanded={open === 'view'} aria-controls={open === 'view' ? 'run-view-sheet' : undefined} onclick={() => openDockSheet('view')}>View <span aria-hidden="true">{open === 'view' ? '⌄' : '⌃'}</span></button>
    <button id="run-alarms-trigger" bind:this={alarmsTrigger} type="button" aria-label={`Alarms · ${alarms} unacknowledged`} aria-expanded={alarmsVisible} aria-controls={alarmsVisible ? 'run-alert-strip' : undefined} onclick={() => void toggleAlarms()}>Alarms <strong>{alarms}</strong></button>
    <button id="run-guide-trigger" bind:this={guideTrigger} type="button" aria-label={guideStatus ? `Guide · ${guideStatus}` : 'Guide'} aria-expanded={open === 'guide'} aria-controls={open === 'guide' ? 'run-guide-options' : undefined} onclick={() => openDockSheet('guide')}>Guide{#if guideStatus}<span class="guide-badge">{guideStatus}</span>{/if}</button>
  </nav>
</div>

<style>
  .run-view-tools { position: absolute; z-index: 26; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; font-size: 13px; color: var(--text); }
  .run-view-tools[hidden] { display: none; }
  .view-launchers { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; pointer-events: auto; padding: 3px; max-width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 20px; background: color-mix(in srgb, var(--panel) 96%, transparent); box-shadow: 0 3px 12px rgb(0 0 0 / 12%); }
  button { font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); min-height: 38px; padding: 7px 11px; }
  button:disabled { opacity: .65; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .view-launchers button { border-color: transparent; border-radius: 16px; background: transparent; display: inline-flex; gap: 6px; align-items: center; }
  button:hover:not(:disabled), button[aria-pressed='true'], .view-launchers button[aria-expanded='true'] { background: color-mix(in srgb, var(--accent) 12%, var(--panel)); border-color: var(--accent); }
  .view-sheet { box-sizing: border-box; pointer-events: auto; width: min(460px, 100%); max-height: var(--sheet-height); overflow: auto; overscroll-behavior: contain; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); box-shadow: 0 8px 28px rgb(0 0 0 / 20%); }
  .guide-options { width: min(520px, 100%); }
  .view-sheet:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  h2 { font-size: 16px; margin: 0; }
  h3 { font-size: 13px; margin: 0; }
  .close { font-size: 20px; line-height: 1; min-width: 38px; padding: 2px 8px; background: transparent; }
  .view-section { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 9px; }
  .camera-actions { display: flex; flex-wrap: wrap; gap: 7px; }
  .camera-actions:empty { display: none; }
  .camera-actions button { flex: 1 1 92px; }
  .view-section .camera-actions { margin-bottom: 7px; }
  label { display: flex; align-items: flex-start; gap: 10px; padding: 8px 4px; min-height: 24px; cursor: pointer; border-radius: 6px; }
  label:hover { background: var(--panel-strong); }
  label:has(input:disabled) { cursor: default; }
  label span { min-width: 0; overflow-wrap: anywhere; }
  input[type='checkbox'] { flex: none; width: 18px; height: 18px; margin: 0; padding: 0; accent-color: var(--accent); }
  small { display: block; color: var(--muted); font-size: 11px; line-height: 1.4; }
  summary { cursor: pointer; min-height: 32px; line-height: 1.5; font-weight: 650; }
  summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .current-instruction { padding: 10px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel-strong); }
  .current-instruction p { margin-bottom: 0; }
  .guide-badge { border-radius: 8px; padding: 1px 5px; background: color-mix(in srgb, var(--accent) 12%, var(--panel)); color: var(--text); font-size: 10px; }
  @media (pointer: coarse) { button, summary { min-height: 44px; } label { min-height: 28px; padding-block: 10px; } }
  /* A short World split needs a single reachable launcher row. Status stays in
     accessible names; keyboard focus can scroll the row on narrower surfaces. */
  .short-pane .view-launchers { flex-wrap: nowrap; justify-content: flex-start; overflow-x: auto; gap: 2px; }
  .short-pane .view-launchers button { flex: none; padding-inline: 6px; }
  .short-pane .guide-badge { width: 6px; height: 6px; padding: 0; font-size: 0; background: var(--accent); }
  @media (prefers-reduced-transparency: reduce), (forced-colors: active) { .view-launchers { background: var(--panel); } }
</style>

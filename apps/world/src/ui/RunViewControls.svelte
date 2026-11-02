<script lang="ts">
  import { tick, type Snippet } from 'svelte'
  import type { RunViewChoice } from './run-view-actions.ts'
  import type { RunViewPreferences } from './run-view-preferences.ts'
  import type { MapCover } from './surface-panel-contract.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'

  interface Props {
    camera: ReadonlyArray<{ readonly id: string; readonly label: string; readonly disabledReason?: string }>
    layers: ReadonlyArray<RunViewChoice>
    panels: ReadonlyArray<RunViewChoice>
    act: (id: string) => void
    toggle: (id: string, visible: boolean) => void
    reset: () => void
    resetDisabledReason: string | undefined
    alarms: number
    alarmsVisible: boolean
    showAlarms: (visible: boolean) => void
    guidance: { readonly available: boolean; readonly visible: boolean; readonly unread: boolean; readonly mode: RunViewPreferences['guidance']['mode']; readonly instruction: { readonly title: string; readonly message: string } | null }
    setGuidance: (mode: RunViewPreferences['guidance']['mode']) => void
    clear: MapCover
    ready: boolean
    /** The World shell keeps active guidance reachable over a live display. */
    raised: boolean
    guideContent?: Snippet
    hasGuide?: boolean
    guideNotice?: boolean
    guideOpenKey?: string | null
  }
  let { camera, layers, panels, act, toggle, reset, resetDisabledReason, alarms, alarmsVisible, showAlarms, guidance, setGuidance, clear, ready, raised, guideContent, hasGuide = false, guideNotice = false, guideOpenKey = null }: Props = $props()
  let root = $state<HTMLDivElement | null>(null)
  let viewTrigger = $state<HTMLButtonElement | null>(null)
  let guideTrigger = $state<HTMLButtonElement | null>(null)
  let sheet = $state<HTMLElement | null>(null)
  let open = $state<'view' | 'guide' | null>(null)
  let group = $state<'camera' | 'layers' | 'panels'>('camera')
  let geometry = $state({ left: 12, right: 12, bottom: 52, height: 300 })
  let remeasure: (() => void) | null = null
  let openedGuideKey: string | null = null
  $effect(() => { if (guideOpenKey && guideOpenKey !== openedGuideKey) { openedGuideKey = guideOpenKey; void disclose('guide') } })

  const close = (returnFocus = false): void => {
    const trigger = open === 'guide' ? guideTrigger : viewTrigger
    open = null
    if (returnFocus) trigger?.focus({ preventScroll: true })
  }
  export const dismiss = (): void => close(true)
  export const reveal = async (which: 'view' | 'guide'): Promise<void> => { if (open !== which) await disclose(which) }
  const disclose = async (which: 'view' | 'guide'): Promise<void> => {
    if (open === which) { close(true); return }
    open = which
    await tick()
    sheet?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    remeasure?.()
  }
  const outside = (event: PointerEvent): void => { if (open && event.target instanceof Node && !root?.contains(event.target)) close() }
  const key = (event: KeyboardEvent): void => {
    if (open && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(true) }
  }
  const ownKeys = (event: KeyboardEvent): void => { key(event); event.stopPropagation() }
  const focusout = (event: FocusEvent): void => { if (open && event.relatedTarget instanceof Node && !root?.contains(event.relatedTarget)) close() }
  $effect(() => { void clear; void ready; void guidance; remeasure?.() })

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
      const availableHeight = visibleBottom - bounds.top - bottom - inset * 2 - launcherHeight - 8
      // The active disclosure can temporarily cover an instruction when the
      // viewport is too short for both. Guide Pause/Resume remains reachable.
      const clearTop = Math.min(top, Math.max(0, availableHeight - 44))
      geometry = { left: inset + left, right: inset + right, bottom: bottom + inset, height: Math.max(44, availableHeight - clearTop) }
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
<!-- A nonmodal disclosure: Tab may leave it; Escape returns to its own trigger. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="run-view-tools" data-world-disclosure bind:this={root} onfocusout={focusout} onkeydown={ownKeys} style:left={`${geometry.left}px`} style:right={`${geometry.right}px`} style:bottom={`${geometry.bottom}px`} style:z-index={raised ? 94 : 26} style:--sheet-height={`${geometry.height}px`}>
  {#if open === 'view'}
    <section id="run-view-sheet" class="view-sheet" aria-label="Run view" bind:this={sheet}>
      <header><strong>View</strong><button class="close" type="button" aria-label="Close View controls" onclick={() => close(true)}>×</button></header>
      <div class="groups" aria-label="View groups">
        <button type="button" aria-pressed={group === 'camera'} onclick={() => group = 'camera'}>Camera</button>
        <button type="button" aria-pressed={group === 'layers'} onclick={() => group = 'layers'}>Layers</button>
        <button type="button" aria-pressed={group === 'panels'} onclick={() => group = 'panels'}>Panels</button>
      </div>
      <div class="choices">
        {#if group === 'camera'}
          <div class="camera-actions">{#each camera as action (action.id)}<button type="button" title={action.disabledReason ?? ''} disabled={Boolean(action.disabledReason)} onclick={() => act(action.id)}>{action.label}{#if action.disabledReason}<small>{action.disabledReason}</small>{/if}</button>{/each}</div>
        {:else}
          {@const choices = group === 'layers' ? layers : panels}
          {#if choices.length === 0}<p>No {group} are available in this Run.</p>{/if}
          {#each choices as choice (choice.id)}
            <label title={choice.disabledReason ?? ''}><input type="checkbox" checked={choice.visible} disabled={Boolean(choice.disabledReason)} onchange={event => toggle(choice.id, event.currentTarget.checked)} /><span>{choice.label}{#if choice.disabledReason}<small>{choice.disabledReason}</small>{/if}</span></label>
          {/each}
        {/if}
      </div>
      <footer><button type="button" disabled={Boolean(resetDisabledReason)} title={resetDisabledReason ?? 'Restore local camera, layers and panels; the simulation and guide are unchanged'} onclick={reset}>Reset local view</button>{#if resetDisabledReason}<small>{resetDisabledReason}</small>{/if}</footer>
    </section>
  {:else if open === 'guide'}
    <section id="run-guide-options" class="view-sheet guide-options" aria-label="Guidance options" bind:this={sheet}>
      <header><strong>Guide</strong><button class="close" type="button" aria-label="Close guidance options" onclick={() => close(true)}>×</button></header>
      {#if guidance.available}
      <h4>Timed scenario cards</h4>
      {#if guidance.instruction}<div class="current-instruction"><strong>{guidance.instruction.title}</strong><p>{guidance.instruction.message}</p></div>{/if}
      <p>{guidance.available ? guidance.unread ? 'A new scenario instruction is available.' : 'Show the current scenario instruction again.' : hasGuide ? 'An authored guide is available below.' : 'This Run has no current scenario instruction.'}</p>
      <div class="camera-actions"><button type="button" disabled={!guidance.available} onclick={() => { setGuidance('running'); close(true) }}>{hasGuide ? 'Show current card' : 'Resume guidance'}</button><button type="button" disabled={guidance.mode === 'paused'} onclick={() => { setGuidance('paused'); close(true) }}>{hasGuide ? 'Pause timed cards' : 'Pause guidance'}</button><button type="button" disabled={guidance.mode === 'stopped'} onclick={() => { setGuidance('stopped'); close(true) }}>{hasGuide ? 'Stop timed cards' : 'Stop guidance'}</button></div>
      <p class="help">Pause and Stop hide instructions on this screen. The simulation keeps its current playback. Resume remains available.</p>
      {:else if !hasGuide}<p>This Run has no current scenario instruction.</p>{/if}
      {#if guideContent}{@render guideContent()}{/if}
    </section>
  {/if}
  <nav class="view-launchers" aria-label="World Run presentation">
    {#if raised}<span class="world-context" title="These controls belong to the World map. The display window has its own controls.">World</span>{/if}
    <button id="run-view-trigger" bind:this={viewTrigger} type="button" aria-label="View" aria-expanded={open === 'view'} aria-controls={open === 'view' ? 'run-view-sheet' : undefined} onclick={() => void disclose('view')}>View <span aria-hidden="true">{open === 'view' ? '⌄' : '⌃'}</span></button>
    <button id="run-alarms-trigger" type="button" aria-label={`${alarms} unacknowledged ${alarms === 1 ? 'alarm' : 'alarms'}; ${alarmsVisible ? 'hide' : 'show'} alarm strip`} aria-pressed={alarmsVisible} onclick={() => showAlarms(!alarmsVisible)}>Alarms <strong>{alarms}</strong></button>
    <button id="run-guide-trigger" bind:this={guideTrigger} type="button" aria-label={`Guide${guidance.unread || guideNotice ? ': new instruction' : ''}${guidance.mode !== 'running' ? `; ${guidance.mode}` : ''}`} aria-expanded={open === 'guide'} aria-controls={open === 'guide' ? 'run-guide-options' : undefined} onclick={() => void disclose('guide')}>Guide{#if guidance.unread || guideNotice}<span class="new">New</span>{:else if guidance.mode !== 'running'}<small>{guidance.mode}</small>{/if}</button>
  </nav>
</div>

<style>
  .run-view-tools { position: absolute; z-index: 26; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; font-size: 13px; color: var(--text); }
  .view-launchers { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; pointer-events: auto; padding: 3px; border: 1px solid var(--border); border-radius: 20px; background: color-mix(in srgb, var(--panel) 86%, transparent); box-shadow: 0 3px 12px rgb(0 0 0 / 12%); }
  button { font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); min-height: 38px; padding: 7px 11px; }
  button:disabled { opacity: .65; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .view-launchers button { border-color: transparent; border-radius: 16px; background: transparent; display: inline-flex; gap: 6px; align-items: center; }
  .world-context { align-self: center; padding-inline: 8px 2px; color: var(--muted); font-size: 11px; font-weight: 650; }
  button:hover:not(:disabled), button[aria-pressed='true'], .view-launchers button[aria-expanded='true'] { background: color-mix(in srgb, var(--accent) 12%, var(--panel)); border-color: var(--accent); }
  .view-sheet { box-sizing: border-box; pointer-events: auto; width: min(640px, 100%); max-height: var(--sheet-height); overflow: auto; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); box-shadow: 0 8px 28px rgb(0 0 0 / 20%); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .close { font-size: 20px; line-height: 1; min-width: 38px; padding: 2px 8px; background: transparent; }
  .groups { display: flex; flex-wrap: wrap; gap: 6px; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .groups button { flex: 1 1 80px; }
  .choices { padding-block: 10px; }
  .camera-actions { display: flex; flex-wrap: wrap; gap: 7px; }
  .camera-actions button { flex: 1 1 135px; }
  label { display: flex; align-items: flex-start; gap: 10px; padding: 8px 4px; min-height: 24px; cursor: pointer; }
  label span { min-width: 0; overflow-wrap: anywhere; }
  input[type='checkbox'] { flex: none; width: 18px; height: 18px; margin: 0; padding: 0; accent-color: var(--accent); }
  small { display: block; color: var(--muted); font-size: 11px; line-height: 1.4; }
  footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; border-top: 1px solid var(--border); padding-top: 9px; }
  p { margin: 8px 0 12px; line-height: 1.5; }
  .help { color: var(--muted); font-size: 12px; margin-bottom: 0; }
  .current-instruction { padding: 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel-strong); }
  .current-instruction p { margin-bottom: 0; }
  .new { border-radius: 8px; padding: 1px 5px; background: var(--accent); color: var(--panel); font-size: 10px; }
  @media (pointer: coarse) { button { min-height: 44px; } label { min-height: 28px; padding-block: 10px; } }
  @media (prefers-reduced-transparency: reduce), (forced-colors: active) { .view-launchers { background: var(--panel); } }
</style>

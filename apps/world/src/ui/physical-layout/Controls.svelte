<script lang="ts">
  import { changePhysicalLayoutView, levelLabel, type PhysicalLayoutLevel, type PhysicalLayoutView } from './view.ts'

  // The map is an OpenBridge-free host. These are ordinary map controls; the
  // actual operational faceplate is hosted by the embed boundary.
  let { title, levels, view, status, suspended = false, onviewchange, onfit, onreset, onoverview, oncomponents, onclose }: {
    title: string
    levels: ReadonlyArray<PhysicalLayoutLevel>
    view: PhysicalLayoutView
    /** A short acquisition/coverage statement, never an inferred all-clear. */
    status: string
    suspended?: boolean
    onviewchange: (view: PhysicalLayoutView) => void
    onfit: () => void
    onreset: () => void
    onoverview: () => void
    oncomponents: () => void
    onclose: () => void
  } = $props()

  const change = (patch: Partial<PhysicalLayoutView>): void => onviewchange(changePhysicalLayoutView(view, patch, levels))
</script>

<section class="layout-controls" aria-label={`${title}: physical layout controls`}>
  <header><strong>{title}</strong><button type="button" class="close" aria-label="Close layout controls" onclick={onclose}>×</button></header>
  <div class="primary">
    <div class="modes" role="group" aria-label="Layout projection">
      <button type="button" aria-pressed={view.mode === '2d'} onclick={() => change({ mode: '2d' })}>2D</button>
      <button type="button" aria-pressed={view.mode === '3d'} onclick={() => change({ mode: '3d' })}>3D</button>
    </div>
    <label class="level">Level
      <select aria-label="Layout level" value={view.levelId} onchange={event => change({ levelId: event.currentTarget.value })}>
        {#each levels as level (level.id)}<option value={level.id}>{levelLabel(level)}</option>{/each}
        {#if view.mode === '3d'}<option value="all">All levels</option>{/if}
      </select>
    </label>
  </div>
  <div class="actions">
    <button type="button" onclick={onfit}>Fit layout</button>
    <button type="button" onclick={onoverview}>Overview</button>
    <button type="button" onclick={oncomponents}>Components</button>
  </div>
  <details>
    <summary>View and layers</summary>
    <div class="settings">
      <label><input type="checkbox" checked={view.detail === 'auto'} onchange={event => change({ detail: event.currentTarget.checked ? 'auto' : 'hidden' })} /> Show layout detail on zoom</label>
      <label><input type="checkbox" checked={view.live} onchange={event => change({ live: event.currentTarget.checked })} /> Live status layer</label>
      <label><input type="checkbox" checked={view.cutaway} onchange={event => change({ cutaway: event.currentTarget.checked })} /> Cut away roof and upper walls</label>
      {#if view.mode === '3d'}
        <label class="separation">Separate levels <output>{view.separation} m</output>
          <input aria-label="Level separation in metres" type="range" min="0" max="30" step="1" value={view.separation} oninput={event => change({ separation: Number(event.currentTarget.value) })} />
        </label>
        <p>Separation is a viewing offset. It does not move equipment.</p>
      {/if}
      <button type="button" onclick={onreset}>Reset layout view</button>
    </div>
  </details>
  <p class="status" role="status">{suspended ? 'Layout inspection suspended while choosing a map target.' : status}{view.live ? '' : ' · Live status layer off'}</p>
</section>

<style>
  .layout-controls { width: min(390px, calc(100vw - 32px)); max-height: min(70vh, 620px); overflow: auto; box-sizing: border-box; padding: 10px; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-floating, 0 4px 12px var(--border)); font: inherit; font-size: 12px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  header strong { min-width: 0; font-size: 13px; }
  button, select { min-height: 44px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; color: var(--text); background: var(--panel); font: inherit; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); background: var(--panel-strong); font-weight: 700; }
  .close { flex: none; min-width: 44px; font-size: 22px; line-height: 1; border-color: transparent; }
  .primary { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin-top: 4px; }
  .modes { display: flex; gap: 4px; }
  .level { flex: 1; display: grid; gap: 3px; min-width: 180px; color: var(--muted); }
  .level select { width: 100%; }
  .actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .actions button { flex: 1; }
  details { border-top: 1px solid var(--border); margin-top: 10px; }
  summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; font-weight: 600; }
  summary::before { content: '›'; margin-right: 8px; }
  details[open] summary::before { content: '⌄'; }
  .settings { display: grid; gap: 2px; }
  .settings label { display: flex; align-items: center; min-height: 44px; gap: 8px; }
  input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }
  .settings .separation { display: grid; grid-template-columns: 1fr auto; gap: 3px; margin-top: 6px; }
  .separation input { grid-column: 1 / -1; width: 100%; min-height: 44px; margin: 0; accent-color: var(--accent); }
  .settings p, .status { margin: 4px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
  .status { border-top: 1px solid var(--border); padding-top: 8px; }
</style>

<script lang="ts">
  import { changePhysicalLayoutView, levelLabel, type PhysicalLayoutLevel, type PhysicalLayoutView } from './view.ts'
  import type { ExplorerScopeChoice } from './explorer-model.ts'

  let { title, path = title, choices, scopeKey, levels, layers = [], view, status, host, suspended = false,
    onscope, onviewchange, onfit, onoverview, onfind, onbrowser, onback, onclose,
  }: {
    title: string; path?: string; choices: ReadonlyArray<ExplorerScopeChoice>; scopeKey: string | null
    levels: ReadonlyArray<PhysicalLayoutLevel>; view: PhysicalLayoutView; status: string; host: 'map' | 'browser'; suspended?: boolean
    layers?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly defaultVisible: boolean }>
    onscope: (key: string | null) => void; onviewchange: (view: PhysicalLayoutView) => void
    onfit: () => void; onoverview?: (() => void) | undefined; onfind: () => void; onbrowser?: ((sceneId: string | null, groupId?: string) => void) | undefined
    onback?: (() => void) | undefined; onclose?: (() => void) | undefined
  } = $props()
  let scopeOpen = $state(false)
  let viewOpen = $state(false)
  const hiddenLayerIds = $derived(view.hiddenLayerIds ?? layers.filter(layer => !layer.defaultVisible).map(layer => layer.id))
  const change = (patch: Partial<PhysicalLayoutView>): void => onviewchange(levels.length > 0 ? changePhysicalLayoutView(view, patch, levels) : { ...view, ...patch })
  const choose = (key: string | null): void => { scopeOpen = false; onscope(key) }
  const openBrowser = (): void => { const choice = choices.find(choice => choice.key === scopeKey); onbrowser?.(choice?.sceneId ?? null, choice?.groupId) }
  export const dismiss = (): boolean => {
    if (viewOpen) { viewOpen = false; return true }
    if (scopeOpen) { scopeOpen = false; return true }
    return false
  }
</script>

<section class="explorer-controls" aria-label={`${title}: physical layout controls`}>
  <div class="scope-row">
    <button class="scope" type="button" title={path} aria-label={`Choose physical scope: ${path}`} aria-expanded={scopeOpen} onclick={() => { scopeOpen = !scopeOpen; viewOpen = false }}><strong>{title}</strong><span>{scopeKey === null ? 'All admitted layouts' : path} ▾</span></button>
    <div class="modes" role="group" aria-label="Layout representation"><button type="button" aria-pressed={view.mode === '2d'} onclick={() => change({ mode: '2d' })}>Plan</button><button type="button" aria-pressed={view.mode === '3d'} onclick={() => change({ mode: '3d' })}>3D</button></div>
  </div>
  <div class="action-row"><button type="button" onclick={onfind}>Find</button><button type="button" aria-expanded={viewOpen} onclick={() => { viewOpen = !viewOpen; scopeOpen = false }}>View</button>{#if host === 'map' && onbrowser}<button type="button" onclick={openBrowser}>Open layout browser</button>{:else if host === 'browser'}<button type="button" onclick={onback}>Back to map</button>{/if}{#if onclose}<button class="close" type="button" aria-label="Close layout controls" onclick={onclose}>×</button>{/if}</div>
  {#if scopeOpen}
    <nav class="sheet scopes" aria-label="Physical scope hierarchy">
      <header><strong>Choose an area</strong><button type="button" aria-label="Close area chooser" onclick={() => scopeOpen = false}>×</button></header>
      <button type="button" aria-current={scopeKey === null ? 'location' : undefined} onclick={() => choose(null)}>All available layouts</button>
      {#each choices as choice (choice.key)}<button type="button" title={choice.path} aria-current={choice.key === scopeKey ? 'location' : undefined} style:padding-left={`${12 + choice.depth * 12}px`} onclick={() => choose(choice.key)}><span>{choice.label}</span><small>{choice.kind}</small></button>{/each}
      <footer>{#if onoverview}<button type="button" onclick={onoverview}>Owner overview</button>{/if}{#if host === 'map'}<button type="button" onclick={() => { scopeOpen = false; onfit() }}>Explore on map</button>{#if onbrowser}<button type="button" onclick={openBrowser}>Open this area in layout browser</button>{/if}{/if}</footer>
    </nav>
  {/if}
  {#if viewOpen}
    <section class="sheet settings" aria-label="Layout view and information layers"><header><strong>View</strong><button type="button" aria-label="Close view settings" onclick={() => viewOpen = false}>×</button></header>
      {#if levels.length > 0}<label>Floor<select aria-label="Layout level" value={view.levelId} onchange={event => change({ levelId: event.currentTarget.value })}>{#each levels as level (level.id)}<option value={level.id}>{levelLabel(level)}</option>{/each}{#if view.mode === '3d'}<option value="all">Stack · all floors</option>{/if}</select></label>{/if}
      <label><input type="checkbox" checked={view.live} onchange={event => change({ live: event.currentTarget.checked })} /> Live status</label>
      <label><input type="checkbox" checked={view.cutaway} onchange={event => change({ cutaway: event.currentTarget.checked })} /> Inspection cutaway</label>
      <label><input type="checkbox" checked={view.detail === 'auto'} onchange={event => change({ detail: event.currentTarget.checked ? 'auto' : 'hidden' })} /> Reveal detail as needed</label>
      {#each layers as layer (layer.id)}<label><input type="checkbox" checked={!hiddenLayerIds.includes(layer.id)} onchange={event => change({ hiddenLayerIds: event.currentTarget.checked ? hiddenLayerIds.filter(id => id !== layer.id) : [...hiddenLayerIds, layer.id] })} /> {layer.label}</label>{/each}
      {#if view.mode === '3d' && view.levelId === 'all'}<label class="separation">Separate floors <output>metres of view offset</output><input aria-label="Floor separation view offset in metres" type="number" min="0" step="1" value={view.separation} oninput={event => { const separation = event.currentTarget.valueAsNumber; if (Number.isFinite(separation) && separation >= 0) change({ separation }) }} /></label>{/if}
      <button type="button" onclick={() => { viewOpen = false; onfit() }}>Fit selection · keep angle</button>{#if onoverview}<button type="button" onclick={onoverview}>Owner overview</button>{/if}
    </section>
  {/if}
  <p class="evidence" role="status">{suspended ? 'Inspection suspended while choosing an operational target.' : status}{view.live ? '' : ' · Status layer off'}</p>
</section>
<style>
  .explorer-controls { color: var(--text); font: inherit; font-size: 12px; }
  button, select { box-sizing: border-box; min-height: 44px; min-width: 44px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; color: var(--text); background: var(--panel); font: inherit; cursor: pointer; }
  button:hover { border-color: var(--accent); } button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button[aria-pressed="true"], button[aria-current="location"] { color: var(--accent); border-color: var(--accent); background: var(--panel-strong); font-weight: 700; }
  .scope-row { display: flex; gap: 6px; } .scope { flex: 1; min-width: 0; text-align: left; display: grid; gap: 2px; }.scope strong,.scope span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.scope span { color: var(--muted); font-size: 11px; }
  .modes { display: flex; gap: 4px; } .modes button { min-width: 52px; }
  .action-row { display: flex; gap: 6px; margin-top: 6px; }.action-row button { flex: 1; }.action-row .close { flex: none; padding: 0; }
  .sheet { display: grid; gap: 6px; box-sizing: border-box; padding: 10px; margin-top: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); max-height: min(55dvh, 560px); overflow: auto; overscroll-behavior: contain; box-shadow: var(--shadow-floating); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }header button { padding: 0; font-size: 21px; }.scopes > button { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; }.scopes small { color: var(--muted); }.scopes footer { display: grid; gap: 6px; border-top: 1px solid var(--border); padding-top: 6px; }
  .settings label { display: flex; align-items: center; gap: 8px; min-height: 44px; }.settings label:has(select) { display: grid; }.settings select { width: 100%; }.settings input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }.settings .separation { display: grid; grid-template-columns: 1fr auto; }.separation input { grid-column: 1 / -1; width: 100%; min-height: 44px; box-sizing: border-box; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font: inherit; }
  .evidence { margin: 5px 0 0; color: var(--muted); background: var(--panel); border-radius: 4px; padding: 4px 6px; font-size: 11px; line-height: 1.4; }
  @media (max-width: 440px) { .modes button { min-width: 48px; }.action-row .close { display: none; } }
</style>

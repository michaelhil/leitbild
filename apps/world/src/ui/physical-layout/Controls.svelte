<script lang="ts">
  import { changePhysicalLayoutView, levelLabel, type PhysicalLayoutLevel, type PhysicalLayoutView } from './view.ts'
  import { explorerEntryTarget, explorerScopeAncestors, explorerScopeBranches, type ExplorerScopeBranch, type ExplorerScopeChoice, type PhysicalExplorerTarget } from './explorer-model.ts'

  let { title, path = title, choices, scopeKey, levels, layers = [], view, status, host, suspended = false,
    onscope, onviewchange, onfit, onoverview, onfind, onbrowser, onback, onclose,
  }: {
    title: string; path?: string; choices: ReadonlyArray<ExplorerScopeChoice>; scopeKey: string | null
    levels: ReadonlyArray<PhysicalLayoutLevel>; view: PhysicalLayoutView; status: string; host: 'map' | 'browser'; suspended?: boolean
    layers?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly defaultVisible: boolean }>
    onscope: (key: string | null) => void; onviewchange: (view: PhysicalLayoutView) => void
    onfit: () => void; onoverview?: (() => void) | undefined; onfind: () => void; onbrowser?: ((target: PhysicalExplorerTarget) => void) | undefined
    onback?: (() => void) | undefined; onclose?: (() => void) | undefined
  } = $props()
  let scopeOpen = $state(false)
  let viewOpen = $state(false)
  let scopeQuery = $state('')
  let expandedScopes = $state.raw<ReadonlySet<string>>(new Set())
  const scopeBranches = $derived(explorerScopeBranches(choices, expandedScopes, scopeQuery))
  const toggleScope = (key: string): void => {
    const next = new Set(expandedScopes)
    if (next.has(key)) next.delete(key); else next.add(key)
    expandedScopes = next
  }
  const revealCurrent = (): void => { if (scopeKey !== null) { scopeQuery = ''; expandedScopes = new Set([...expandedScopes, ...explorerScopeAncestors(choices, scopeKey)]) } }
  const hiddenLayerIds = $derived(view.hiddenLayerIds ?? layers.filter(layer => !layer.defaultVisible).map(layer => layer.id))
  const change = (patch: Partial<PhysicalLayoutView>): void => onviewchange(levels.length > 0 ? changePhysicalLayoutView(view, patch, levels) : { ...view, ...patch })
  const choose = (key: string | null): void => { scopeOpen = false; onscope(key) }
  const openBrowser = (): void => { const choice = choices.find(choice => choice.key === scopeKey); onbrowser?.(explorerEntryTarget(choice, view)) }
  export const dismiss = (): boolean => {
    if (viewOpen) { viewOpen = false; return true }
    if (scopeOpen) { scopeOpen = false; return true }
    return false
  }
</script>

{#snippet scopeBranch(branch: ExplorerScopeBranch)}
  <li>
    <div class="scope-node">
      {#if branch.hasChildren}<button class="expand-area" type="button" aria-label={`${branch.expanded ? 'Collapse' : 'Expand'} ${branch.choice.label}`} aria-expanded={branch.expanded} disabled={scopeQuery.trim().length > 0} onclick={() => toggleScope(branch.choice.key)}>{branch.expanded ? '▾' : '▸'}</button>{:else}<span class="leaf-spacer" aria-hidden="true"></span>{/if}
      <button class="choose-area" type="button" title={branch.choice.path} aria-label={`Choose area: ${branch.choice.path}${branch.choice.levelContext ? ` · ${branch.choice.levelContext}` : ''}`} aria-current={branch.choice.key === scopeKey ? 'location' : undefined} onclick={() => choose(branch.choice.key)}><strong>{branch.choice.label}</strong><small>{branch.choice.kind === 'space' ? 'Room' : branch.choice.kind}{branch.choice.levelContext ? ` · ${branch.choice.levelContext}` : ''}</small></button>
    </div>
    {#if branch.children.length > 0}<ul>{#each branch.children as child (child.choice.key)}{@render scopeBranch(child)}{/each}</ul>{/if}
  </li>
{/snippet}

<section class="explorer-controls" aria-label={`${title}: physical layout controls`}>
  <div class="scope-row">
    <button class="scope" type="button" title={path} aria-label={`Choose physical scope: ${path}`} aria-expanded={scopeOpen} onclick={() => { scopeOpen = !scopeOpen; viewOpen = false }}><strong>{title}</strong><span>{scopeKey === null ? 'All admitted layouts' : path} ▾</span></button>
    <div class="modes" role="group" aria-label="Layout representation"><button type="button" aria-pressed={view.mode === '2d'} onclick={() => change({ mode: '2d' })}>Plan</button><button type="button" aria-pressed={view.mode === '3d'} onclick={() => change({ mode: '3d' })}>3D</button></div>
  </div>
  <div class="action-row"><button type="button" onclick={onfind}>Find</button><button type="button" aria-expanded={viewOpen} onclick={() => { viewOpen = !viewOpen; scopeOpen = false }}>View</button>{#if host === 'map' && onbrowser}<button type="button" onclick={openBrowser}>Open layout browser</button>{:else if host === 'browser'}<button type="button" onclick={onback}>Back to map</button>{/if}{#if onclose}<button class="close" type="button" aria-label="Close layout controls" onclick={onclose}>×</button>{/if}</div>
  {#if levels.length > 0}<label class="floor-row"><span>Floor</span><select aria-label="Layout level" value={view.levelId} onchange={event => change({ levelId: event.currentTarget.value })}>{#each levels as level (level.id)}<option value={level.id}>{levelLabel(level)}</option>{/each}{#if view.mode === '3d'}<option value="all">Stack · all floors</option>{/if}</select></label>{#if view.mode === '3d' && view.levelId === 'all'}<p class="floor-hint">Choose a floor to inspect the interior.</p>{/if}{/if}
  {#if scopeOpen}
    <nav class="sheet scopes" aria-label="Physical scope hierarchy">
      <header><strong>Choose an area</strong><button type="button" aria-label="Close area chooser" onclick={() => scopeOpen = false}>×</button></header>
      <label class="area-search">Find an area<input type="search" bind:value={scopeQuery} placeholder="Building, room or floor" /></label>
      <button type="button" aria-current={scopeKey === null ? 'location' : undefined} onclick={() => choose(null)}>All available layouts</button>
      {#if scopeKey !== null}<button type="button" onclick={revealCurrent}>Show current area in hierarchy</button>{/if}
      <p class="area-help">Choose an area to focus it. Expand an arrow to browse inside.</p>
      <ul class="area-tree">{#each scopeBranches as branch (branch.choice.key)}{@render scopeBranch(branch)}{/each}</ul>
      {#if scopeBranches.length === 0}<p role="status">No area matches this search.</p>{/if}
      <footer>{#if onoverview}<button type="button" onclick={onoverview}>Owner overview</button>{/if}{#if host === 'map'}<button type="button" onclick={() => { scopeOpen = false; onfit() }}>Explore on map</button>{#if onbrowser}<button type="button" onclick={openBrowser}>Open this area in layout browser</button>{/if}{/if}</footer>
    </nav>
  {/if}
  {#if viewOpen}
    <section class="sheet settings" aria-label="Layout view and information layers"><header><strong>View</strong><button type="button" aria-label="Close view settings" onclick={() => viewOpen = false}>×</button></header>
      <label><input type="checkbox" checked={view.live} onchange={event => change({ live: event.currentTarget.checked })} /> Live status</label>
      <label><input type="checkbox" checked={view.cutaway} onchange={event => change({ cutaway: event.currentTarget.checked })} /> Inspection cutaway</label>
      {#if choices.find(choice => choice.key === scopeKey)?.sceneId}<label><input type="checkbox" checked={view.surroundings ?? false} onchange={event => change({ surroundings: event.currentTarget.checked })} /> Surrounding buildings</label>{/if}
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
  .floor-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding-left: 8px; background: var(--panel); border-radius: 7px; }.floor-row select { flex: 1; min-width: 0; }.floor-hint { margin: 3px 0 0; padding: 3px 6px; background: var(--panel); border-radius: 4px; color: var(--muted); font-size: 11px; }
  .sheet { display: grid; gap: 6px; box-sizing: border-box; padding: 10px; margin-top: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); max-height: min(55dvh, 560px); overflow: auto; overscroll-behavior: contain; box-shadow: var(--shadow-floating); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }header button { padding: 0; font-size: 21px; }.scopes > button { text-align: left; }.scopes small { color: var(--muted); }.scopes footer { display: grid; gap: 6px; border-top: 1px solid var(--border); padding-top: 6px; }
  .area-search { display: grid; gap: 4px; }.area-search input { min-width: 0; min-height: 44px; box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--panel); font: inherit; }.area-help { margin: 2px 0; font-size: 11px; color: var(--muted); line-height: 1.5; }
  .area-tree, .area-tree ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }.area-tree ul { margin-top: 5px; margin-left: 12px; padding-left: 5px; border-left: 1px solid var(--border); }.scope-node { display: flex; align-items: stretch; gap: 4px; }.expand-area, .leaf-spacer { flex: 0 0 44px; width: 44px; }.expand-area { padding: 0; font-size: 18px; }.choose-area { flex: 1; min-width: 0; display: grid; gap: 3px; text-align: left; }.choose-area strong { font-weight: 600; overflow-wrap: anywhere; }.choose-area small { font-size: 10px; line-height: 1.4; overflow-wrap: anywhere; }
  .settings label { display: flex; align-items: center; gap: 8px; min-height: 44px; }.settings input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }.settings .separation { display: grid; grid-template-columns: 1fr auto; }.separation input { grid-column: 1 / -1; width: 100%; min-height: 44px; box-sizing: border-box; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font: inherit; }
  .evidence { margin: 5px 0 0; color: var(--muted); background: var(--panel); border-radius: 4px; padding: 4px 6px; font-size: 11px; line-height: 1.4; }
  @media (max-width: 440px) { .modes button { min-width: 48px; }.action-row .close { display: none; } }
</style>

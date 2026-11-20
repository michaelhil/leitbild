<script lang="ts">
  import type { PhysicalCollectionFloorGroup, PhysicalMixedViewSetting } from './collection-floors.ts'
  import type { PhysicalCollectionLayerChoice } from './collection-layers.ts'
  import { changePhysicalLayoutView, levelLabel, type PhysicalLayoutLevel, type PhysicalLayoutView } from './view.ts'
  import { explorerScopeAncestors, explorerScopeBranches, type ExplorerScopeBranch, type ExplorerScopeChoice } from './explorer-model.ts'

  let { title, path = title, choices, scopeKey, levels, layers = [], collectionLayerChoices = [], view, status, statusQuiet, suspended = false, floorGroups = [], mixedSettings = [], onfloorchange, oncollectionlayerchange,
    onscope, onviewchange, onfit, onhome, onoverview, onfind, onclose, onretry, retryLabel = 'Retry physical layout', camera,
  }: {
    title: string; path?: string; choices: ReadonlyArray<ExplorerScopeChoice>; scopeKey: string | null
    levels: ReadonlyArray<PhysicalLayoutLevel>; view: PhysicalLayoutView; suspended?: boolean
    /** The status line; `statusQuiet` when it has nothing to report and need not cover the map. */
    status: string; statusQuiet: boolean
    layers?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly defaultVisible: boolean }>
    collectionLayerChoices?: ReadonlyArray<PhysicalCollectionLayerChoice>
    floorGroups?: ReadonlyArray<PhysicalCollectionFloorGroup>; mixedSettings?: ReadonlyArray<PhysicalMixedViewSetting>
    onfloorchange?: (key: string, levelId: string) => void
    oncollectionlayerchange?: ((key: string, visible: boolean) => void) | undefined
    onscope: (key: string | null) => void; onviewchange: (view: PhysicalLayoutView, patch?: Partial<PhysicalLayoutView>) => void
    onfit: () => void; onhome: () => void; onoverview?: (() => void) | undefined; onfind: () => void
    onclose?: (() => void) | undefined
    onretry?: (() => void) | undefined
    retryLabel?: string
    /** The 3D camera strip; absent in Plan. */
    camera?: { readonly navigation: 'pan' | 'orbit'; readonly pitch: number; readonly bearing: number; readonly onnavigation: (tool: 'pan' | 'orbit') => void; readonly ontilt: (degrees: number) => void; readonly onturn: (degrees: number) => void } | undefined
  } = $props()
  type Sheet = 'scope' | 'floors' | 'view' | 'camera'
  let chosenSheet = $state<Sheet | null>(null)
  // One sheet opens below the toolbar at a time. Tilt and turn exists only beside its strip, in 3D.
  const sheet = $derived(chosenSheet === 'camera' && !camera ? null : chosenSheet)
  const toggleSheet = (next: Sheet): void => { chosenSheet = sheet === next ? null : next }
  let scopeQuery = $state('')
  let expandedScopes = $state.raw<ReadonlySet<string>>(new Set())
  const scopeBranches = $derived(explorerScopeBranches(choices, expandedScopes, scopeQuery))
  const collidingCollectionLayerLabels = $derived.by(() => {
    const seen = new Set<string>(), colliding = new Set<string>()
    for (const layer of collectionLayerChoices) { if (seen.has(layer.label)) colliding.add(layer.label); else seen.add(layer.label) }
    return colliding
  })
  const toggleScope = (key: string): void => {
    const next = new Set(expandedScopes)
    if (next.has(key)) next.delete(key); else next.add(key)
    expandedScopes = next
  }
  const revealCurrent = (): void => { if (scopeKey !== null) { scopeQuery = ''; expandedScopes = new Set([...expandedScopes, ...explorerScopeAncestors(choices, scopeKey)]) } }
  const hiddenLayerIds = $derived(view.hiddenLayerIds ?? layers.filter(layer => !layer.defaultVisible).map(layer => layer.id))
  const change = (patch: Partial<PhysicalLayoutView>): void => onviewchange(levels.length > 0 ? changePhysicalLayoutView(view, patch, levels) : { ...view, ...patch }, patch)
  const changeFloor = (levelId: string): void => { chosenSheet = null; change({ levelId }) }
  const choose = (key: string | null): void => { chosenSheet = null; onscope(key) }
  export const dismiss = (): boolean => { if (sheet === null) return false; chosenSheet = null; return true }
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
 <div class="toolbar" data-layout-camera-cover>
  <div class="scope-row">
    <button class="scope" type="button" title={path} aria-label={`Choose physical scope: ${path}`} aria-expanded={sheet === 'scope'} onclick={() => toggleSheet('scope')}><strong>{title}</strong><span>{scopeKey === null ? 'All admitted layouts' : path} ▾</span></button>
  </div>
  {#if levels.length > 0}<label class="floor-row primary-floor"><span>Floor</span><select aria-label="Layout level" value={view.levelId} onchange={event => changeFloor(event.currentTarget.value)}>{#each levels as level (level.id)}<option value={level.id}>{levelLabel(level)}</option>{/each}{#if view.mode === '3d'}<option value="all">Stack · all floors</option>{/if}</select></label>
  {:else if floorGroups.length > 0}<button class="floors-toggle" type="button" aria-expanded={sheet === 'floors'} onclick={() => toggleSheet('floors')}>Floors <span>· {floorGroups.length} {floorGroups.length === 1 ? 'model' : 'models'} ▾</span></button>{/if}
  <div class="action-row"><button type="button" onclick={() => { chosenSheet = null; onfind() }}>Find</button><button type="button" title={`Fit the layout scope in view: ${path}`} onclick={() => { chosenSheet = null; onfit() }}>Fit</button><button type="button" title={`Return to the home view of the layout scope: ${path}`} onclick={() => { chosenSheet = null; onhome() }}>Home</button><button type="button" aria-expanded={sheet === 'view'} onclick={() => toggleSheet('view')}>Options</button>{#if onclose}<button class="close" type="button" aria-label="Close layout controls" onclick={onclose}>×</button>{/if}</div>
  {#if camera}<div class="camera-controls" role="group" aria-label="3D navigation"><button type="button" aria-pressed={camera.navigation === 'pan'} onclick={() => camera.onnavigation('pan')}>Pan</button><button type="button" aria-pressed={camera.navigation === 'orbit'} onclick={() => camera.onnavigation('orbit')}>Orbit</button><button type="button" aria-label="Tilt down" onclick={() => camera.ontilt(-10)}><span>Tilt</span>−</button><button type="button" aria-label="Tilt up" onclick={() => camera.ontilt(10)}><span>Tilt</span>+</button><button class="expand" type="button" aria-label="Tilt and turn" title="More camera controls" aria-expanded={sheet === 'camera'} onclick={() => toggleSheet('camera')}>⋯</button></div>{/if}
  <p class="evidence" class:quiet={statusQuiet} role="status">{#if onretry}<button type="button" aria-label={retryLabel} disabled={suspended} onclick={onretry}>Retry</button>{/if}{status}</p>
 </div>
  {#if sheet === 'camera' && camera}<section data-layout-camera-cover class="sheet camera-sheet" aria-label="Tilt and turn"><header><strong>Tilt and turn</strong><button type="button" aria-label="Close tilt and turn" onclick={() => chosenSheet = null}>×</button></header><p>Tilt {camera.pitch.toFixed(0)}° · heading {camera.bearing.toFixed(0)}°</p><div class="camera-grid"><button type="button" onclick={() => camera.onturn(-15)}>Turn left</button><button type="button" onclick={() => camera.onturn(15)}>Turn right</button><button type="button" onclick={() => camera.onturn(-camera.bearing)}>North</button><button type="button" onclick={() => camera.ontilt(-90)}>Top view</button></div><p>Orbit turns around the focused physical area. Pan moves the view. Focus the drawing for arrows to pan, Shift + arrows to turn/tilt, + / − to zoom, and Home to restore the area.</p></section>{/if}
  {#if sheet === 'floors' && floorGroups.length > 0}<section data-layout-camera-cover class="sheet collection-floors" aria-label="Floors by physical model"><header><strong>Floors by model</strong><button type="button" aria-label="Close floor choices" onclick={() => chosenSheet = null}>×</button></header>{#each floorGroups as group (group.key)}<label class="floor-row collection-floor" title={group.memberLabels.join(', ')}><span>{group.label}<small>{group.scenes.length} {group.scenes.length === 1 ? 'layout' : 'layouts'} · {group.memberLabels.join(', ')}</small></span><select aria-label={`Layout level: ${group.label} · ${group.memberLabels.join(', ')}`} value={group.levelId ?? ''} onchange={event => { chosenSheet = null; onfloorchange?.(group.key, event.currentTarget.value) }}>{#if group.levelId === null}<option value="" disabled>Mixed floors</option>{/if}{#each group.levels as level (level.id)}<option value={level.id}>{levelLabel(level)}</option>{/each}{#if view.mode === '3d'}<option value="all">Stack · all floors</option>{/if}</select></label>{/each}</section>{/if}
  {#if sheet === 'scope'}
    <nav data-layout-camera-cover class="sheet scopes" aria-label="Physical scope hierarchy">
      <header><strong>Choose an area</strong><button type="button" aria-label="Close area chooser" onclick={() => chosenSheet = null}>×</button></header>
      <label class="area-search">Find an area<input type="search" bind:value={scopeQuery} placeholder="Building, room or floor" /></label>
      <button type="button" aria-current={scopeKey === null ? 'location' : undefined} onclick={() => choose(null)}>All available layouts</button>
      {#if scopeKey !== null}<button type="button" onclick={revealCurrent}>Show current area in hierarchy</button>{/if}
      <p class="area-help">Choose an area to focus it. Expand an arrow to browse inside.</p>
      <ul class="area-tree">{#each scopeBranches as branch (branch.choice.key)}{@render scopeBranch(branch)}{/each}</ul>
      {#if scopeBranches.length === 0}<p role="status">No area matches this search.</p>{/if}
      <footer>{#if onoverview}<button type="button" onclick={onoverview}>Owner overview</button>{/if}</footer>
    </nav>
  {/if}
  {#if sheet === 'view'}
    <section data-layout-camera-cover class="sheet settings" aria-label="Layout view and information layers"><header><strong>Options</strong><button type="button" aria-label="Close view settings" onclick={() => chosenSheet = null}>×</button></header>
      <label><input type="checkbox" checked={view.live} indeterminate={mixedSettings.includes('live')} onchange={event => change({ live: event.currentTarget.checked })} /> Live status{mixedSettings.includes('live') ? ' · Mixed' : ''}</label>
      <label><input type="checkbox" checked={view.cutaway} indeterminate={mixedSettings.includes('cutaway')} onchange={event => change({ cutaway: event.currentTarget.checked })} /> Inspection cutaway{mixedSettings.includes('cutaway') ? ' · Mixed' : ''}</label>
      {#if choices.find(choice => choice.key === scopeKey)?.sceneId}<label><input type="checkbox" checked={view.surroundings ?? false} onchange={event => change({ surroundings: event.currentTarget.checked })} /> Surrounding buildings</label>{/if}
      <label><input type="checkbox" checked={view.detail === 'auto'} indeterminate={mixedSettings.includes('detail')} onchange={event => change({ detail: event.currentTarget.checked ? 'auto' : 'hidden' })} /> Reveal detail as needed{mixedSettings.includes('detail') ? ' · Mixed' : ''}</label>
      {#each layers as layer (layer.id)}<label><input type="checkbox" checked={!hiddenLayerIds.includes(layer.id)} onchange={event => change({ hiddenLayerIds: event.currentTarget.checked ? hiddenLayerIds.filter(id => id !== layer.id) : [...hiddenLayerIds, layer.id] })} /> {layer.label}</label>{/each}
      {#each collectionLayerChoices as layer (layer.key)}<label class="collection-layer" title={layer.memberLabels.join(', ')}><input type="checkbox" checked={layer.visible === true} indeterminate={layer.visible === null} disabled={suspended || !oncollectionlayerchange} onchange={event => oncollectionlayerchange?.(layer.key, event.currentTarget.checked)} /><span>{layer.label}{collidingCollectionLayerLabels.has(layer.label) ? ` · ${layer.id}` : ''}{layer.visible === null ? ' · Mixed' : ''}<small>{layer.scenes.length} {layer.scenes.length === 1 ? 'layout' : 'layouts'} · {layer.memberLabels.join(', ')}</small></span></label>{/each}
      {#if view.mode === '3d' && (view.levelId === 'all' || floorGroups.some(group => group.scenes.some(scene => scene.view.levelId === 'all')))}<label class="separation">Separate floors <output>metres of view offset</output><input aria-label="Floor separation view offset in metres" type="number" min="0" step="1" value={mixedSettings.includes('separation') ? '' : view.separation} placeholder={mixedSettings.includes('separation') ? 'Mixed' : undefined} oninput={event => { const separation = event.currentTarget.valueAsNumber; if (Number.isFinite(separation) && separation >= 0) change({ separation }) }} /></label>{/if}
      {#if onoverview}<button type="button" onclick={onoverview}>Owner overview</button>{/if}
    </section>
  {/if}
</section>
<style>
  .explorer-controls { color: var(--text); font: inherit; font-size: 12px; }
  button, select { box-sizing: border-box; min-height: 44px; min-width: 44px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; color: var(--text); background: var(--panel); font: inherit; cursor: pointer; }
  button:hover { border-color: var(--accent); } button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button[aria-current="location"], button[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); background: var(--panel-strong); font-weight: 700; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: stretch; gap: 5px 6px; }.scope-row { display: flex; gap: 6px; flex: 1 1 200px; min-width: 0; } .scope { flex: 1; min-width: 0; text-align: left; display: grid; gap: 2px; }.scope strong,.scope span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.scope span { color: var(--muted); font-size: 11px; }
  /* Squeezed below their own width, the button rows wrap inside the space given: no button, least of all Close, may be cut off. */
  .action-row, .camera-controls { display: flex; flex-wrap: wrap; gap: 6px; flex: 0 1 auto; }.action-row button, .camera-controls button { flex: 1; }.action-row .close, .camera-controls .expand { flex: none; padding: 0; }
  /* A label wider than its squeezed button stays centred on it instead of running out of its right edge. */
  .action-row button { display: flex; align-items: center; justify-content: center; }
  .camera-controls button { padding: 4px; }.camera-controls button span { display: block; font-size: 10px; }.camera-controls .expand { font-size: 20px; }.camera-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }.camera-sheet p { margin: 2px 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
  .floor-row { display: flex; align-items: center; gap: 8px; padding-left: 8px; background: var(--panel); border-radius: 7px; }.floor-row select { flex: 1; min-width: 0; }.primary-floor { flex: 1 1 220px; min-width: 0; }.floors-toggle { flex: 0 1 auto; }.floors-toggle span { color: var(--muted); font-size: 11px; }
  .collection-floors { display: grid; gap: 4px; }.collection-floor > span { min-width: 0; max-width: 42%; overflow-wrap: anywhere; }.collection-floor small { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); font-size: 10px; }.collection-floor select { width: 0; }
  .sheet { display: grid; gap: 6px; box-sizing: border-box; width: min(440px, 100%); margin-left: auto; padding: 10px; margin-top: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); max-height: min(55dvh, 560px); overflow: auto; overscroll-behavior: contain; box-shadow: var(--shadow-floating); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }header button { padding: 0; font-size: 21px; }.scopes > button { text-align: left; }.scopes small { color: var(--muted); }.scopes footer { display: grid; gap: 6px; border-top: 1px solid var(--border); padding-top: 6px; }
  .area-search { display: grid; gap: 4px; }.area-search input { min-width: 0; min-height: 44px; box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--panel); font: inherit; }.area-help { margin: 2px 0; font-size: 11px; color: var(--muted); line-height: 1.5; }
  .area-tree, .area-tree ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }.area-tree ul { margin-top: 5px; margin-left: 12px; padding-left: 5px; border-left: 1px solid var(--border); }.scope-node { display: flex; align-items: stretch; gap: 4px; }.expand-area, .leaf-spacer { flex: 0 0 44px; width: 44px; }.expand-area { padding: 0; font-size: 18px; }.choose-area { flex: 1; min-width: 0; display: grid; gap: 3px; text-align: left; }.choose-area strong { font-weight: 600; overflow-wrap: anywhere; }.choose-area small { font-size: 10px; line-height: 1.4; overflow-wrap: anywhere; }
  .settings label { display: flex; align-items: center; gap: 8px; min-height: 44px; }.settings input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }.settings .separation { display: grid; grid-template-columns: 1fr auto; }.separation input { grid-column: 1 / -1; width: 100%; min-height: 44px; box-sizing: border-box; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font: inherit; }
  .collection-layer > span { min-width: 0; overflow-wrap: anywhere; }.collection-layer input { flex: 0 0 18px; }.collection-layer small { display: block; color: var(--muted); font-size: 10px; line-height: 1.4; }
  .evidence button { margin-right: 8px; }
  .evidence { flex: 1 1 20rem; align-self: center; min-width: 0; margin: 0; color: var(--muted); background: var(--panel); border-radius: 4px; padding: 4px 6px; font-size: 11px; line-height: 1.4; }
  /* Nothing to report: still read by assistive technology, but out of the toolbar's rows, so it covers no map. */
  .evidence.quiet { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @container (max-width: 440px) { .action-row, .camera-controls { flex: 1 1 auto; }.primary-floor { flex-basis: 100%; } }
</style>

<script lang="ts">
  import type { ScenarioAuthoringCatalog } from '../../core/scenarios/authoring.ts'
  import ScenarioBuilderMap from '../ScenarioBuilderMap.svelte'
  import { parseControlSurfaceRoute } from '../simulation-run-route.ts'
  import {
    createEmptyScenarioDraft,
    deepCopy,
    itemTypeFor,
    setValueAtPath,
    valueAtPath,
    type AuthoringFeature,
    type AuthoringField,
    type AuthoringItemType,
    type ScenarioDraftRecord,
  } from '../scenario-builder-model.ts'

  interface InvocationResponse {
    readonly result: unknown
    readonly createdResources?: ReadonlyArray<{ readonly moduleId: string; readonly type: string; readonly id: string }>
  }

  interface CreateResult {
    readonly definition: {
      readonly workspaceId: string
      readonly moduleId: 'world'
      readonly type: 'world.scenario'
      readonly id: string
      readonly revisionId: string
    }
    readonly title: string
  }

  type Selection = { readonly kind: 'scenario' } | { readonly kind: 'feature'; readonly id: string } | { readonly kind: 'item'; readonly id: string }

  const route = parseControlSurfaceRoute(location.pathname)
  if (route.mode !== 'scenario-builder') throw new Error('Scenario Builder route expected')
  const workspaceId = route.workspaceId
  const embedded = new URLSearchParams(location.search).get('embed') === '1'

  let catalog = $state<ScenarioAuthoringCatalog | null>(null)
  let draft = $state<ScenarioDraftRecord>(createEmptyScenarioDraft())
  let selection = $state<Selection>({ kind: 'scenario' })
  let placementItemId = $state<string | null>(null)
  let featureToAdd = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let error = $state<string | null>(null)
  let saved = $state<CreateResult | null>(null)

  const invoke = async <T,>(capabilityId: string, input: unknown, definition?: CreateResult['definition']): Promise<T> => {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, ...(definition ? { definition } : {}), actor: { kind: 'human' } }),
      },
    )
    const body = await response.json() as T & { error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message ?? `Request failed: ${response.status}`)
    return body
  }

  const loadCatalog = async (): Promise<void> => {
    try {
      const response = await invoke<InvocationResponse>('world.scenario-authoring.describe', {})
      catalog = response.result as ScenarioAuthoringCatalog
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading = false
    }
  }

  const mapRegion = (): ScenarioDraftRecord['surface']['regions'][number] => {
    const region = draft.surface.regions.find(candidate => candidate.primitive === 'map')
    if (!region) throw new Error('Scenario Draft has no map region')
    return region
  }

  const mapCenter = (): [number, number] => {
    const value = mapRegion().config.center
    return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number'
      ? [value[0], value[1]]
      : [10.7522, 59.9139]
  }

  const mapZoom = (): number => typeof mapRegion().config.zoom === 'number' ? mapRegion().config.zoom : 11
  const activeFeatures = (): ReadonlyArray<AuthoringFeature> => catalog?.features.filter(feature => draft.packs.includes(feature.id)) ?? []
  const availableFeatures = (): ReadonlyArray<AuthoringFeature> => catalog?.features.filter(feature => !draft.packs.includes(feature.id)) ?? []
  const selectedItem = (): ScenarioDraftRecord['items'][number] | undefined => selection.kind === 'item'
    ? draft.items.find(item => item.id === selection.id)
    : undefined
  const selectedType = (): AuthoringItemType | undefined => {
    const item = selectedItem()
    return item && catalog ? itemTypeFor(catalog, item) : undefined
  }
  const selectedSystem = (): ScenarioDraftRecord['processSystems'][number] | undefined => {
    const item = selectedItem()
    const type = selectedType()
    if (!item || !type?.linkedSystem) return undefined
    const id = valueAtPath(item, type.linkedSystem.itemReferencePath)
    return typeof id === 'string' ? draft.processSystems.find(system => system.id === id) : undefined
  }

  const mapPoints = (): ReadonlyArray<{ id: string; label: string; coordinates: [number, number] }> => !catalog ? [] : draft.items.flatMap(item => {
    const type = itemTypeFor(catalog, item)
    if (!type?.placement) return []
    const value = valueAtPath(item, type.placement.path)
    return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number'
      ? [{ id: item.id, label: item.label, coordinates: [value[0], value[1]] }]
      : []
  })

  const updateRailSections = (): void => {
    const rail = draft.surface.regions.find(region => region.primitive === 'objectRail')
    if (!rail) return
    rail.config.sections = activeFeatures().flatMap(feature => feature.categoryIds.map(categoryId => ({
      categoryId, visible: true, collapsed: false, visibleFields: [],
    })))
  }

  const addFeature = (): void => {
    const feature = catalog?.features.find(candidate => candidate.id === featureToAdd)
    if (!feature || draft.packs.includes(feature.id)) return
    draft.packs.push(feature.id)
    updateRailSections()
    draft = { ...draft }
    selection = { kind: 'feature', id: feature.id }
    featureToAdd = ''
  }

  const removeFeature = (feature: AuthoringFeature): void => {
    if (!confirm(`Remove ${feature.title} and all of its items from this draft?`)) return
    const removedItems = draft.items.filter(item => item.pack === feature.id)
    const linkedSystemIds = new Set(removedItems.flatMap(item => {
      const type = itemTypeFor({ features: [feature] }, item)
      const id = type?.linkedSystem ? valueAtPath(item, type.linkedSystem.itemReferencePath) : undefined
      return typeof id === 'string' ? [id] : []
    }))
    draft.packs = draft.packs.filter(id => id !== feature.id)
    draft.items = draft.items.filter(item => item.pack !== feature.id)
    draft.processSystems = draft.processSystems.filter(system => !linkedSystemIds.has(system.id))
    delete draft.runtimeConfigs[feature.id]
    delete draft.runtimeOverrides[feature.id]
    updateRailSections()
    draft = { ...draft }
    selection = { kind: 'scenario' }
    if (placementItemId && removedItems.some(item => item.id === placementItemId)) placementItemId = null
  }

  const addItem = (feature: AuthoringFeature, type: AuthoringItemType): void => {
    const id = `${type.idPrefix}-${crypto.randomUUID()}`
    const count = draft.items.filter(item => item.pack === feature.id && item.type === type.id).length + 1
    const item = {
      pack: feature.id,
      type: type.id,
      id,
      label: `${type.label} ${count}`,
      ...deepCopy(type.defaultItem),
    }
    if (type.linkedSystem) {
      const systemId = `${type.linkedSystem.idPrefix}-${crypto.randomUUID()}`
      setValueAtPath(item, type.linkedSystem.itemReferencePath, systemId)
      draft.processSystems.push({ id: systemId, ...deepCopy(type.linkedSystem.defaults) })
    }
    draft.items.push(item)
    selection = { kind: 'item', id }
    if (type.placement) placementItemId = id
    draft = { ...draft }
  }

  const removeItem = (item: ScenarioDraftRecord['items'][number]): void => {
    const type = catalog ? itemTypeFor(catalog, item) : undefined
    if (type?.linkedSystem) {
      const systemId = valueAtPath(item, type.linkedSystem.itemReferencePath)
      if (typeof systemId === 'string') draft.processSystems = draft.processSystems.filter(system => system.id !== systemId)
    }
    draft.items = draft.items.filter(candidate => candidate.id !== item.id)
    draft = { ...draft }
    selection = { kind: 'feature', id: item.pack }
    if (placementItemId === item.id) placementItemId = null
  }

  const setMapView = (center: [number, number], zoom: number): void => {
    mapRegion().config.center = center
    mapRegion().config.zoom = Math.round(zoom * 100) / 100
    draft = { ...draft }
  }

  const placeItem = (coordinates: [number, number]): void => {
    if (!placementItemId || !catalog) return
    const item = draft.items.find(candidate => candidate.id === placementItemId)
    const type = item ? itemTypeFor(catalog, item) : undefined
    if (!item || !type?.placement) return
    setValueAtPath(item, type.placement.path, coordinates)
    draft = { ...draft }
    placementItemId = null
  }

  const updateField = (field: AuthoringField, value: unknown): void => {
    const target = field.target === 'item' ? selectedItem() : selectedSystem()
    if (!target) return
    setValueAtPath(target, field.path, value)
    draft = { ...draft }
  }

  const validationError = (): string | null => {
    if (draft.title.trim().length === 0) return 'Give the scenario a title.'
    if (draft.packs.length === 0) return 'Add at least one feature.'
    if (placementItemId) return 'Place the selected item on the map.'
    if (catalog && draft.items.some(item => {
      const type = itemTypeFor(catalog, item)
      return type?.placement && valueAtPath(item, type.placement.path) === undefined
    })) return 'Every map item needs a position.'
    return null
  }

  const save = async (start: boolean): Promise<void> => {
    const invalid = validationError()
    if (invalid) { error = invalid; return }
    saving = true
    error = null
    try {
      draft.title = draft.title.trim()
      if (draft.description?.trim()) draft.description = draft.description.trim()
      else delete draft.description
      const response = await invoke<InvocationResponse>('world.scenario.create', { draft })
      saved = response.result as CreateResult
      window.parent.postMessage({ type: 'leitbild:scenario-saved' }, location.origin)
      if (start) {
        const started = await invoke<InvocationResponse>('world.scenario.start', {}, saved.definition)
        const run = started.createdResources?.find(resource => resource.type === 'world.simulation-run')
        if (!run) throw new Error('Scenario was saved, but the Simulation Run was not returned')
        window.parent.location.href = `/workspaces/${encodeURIComponent(workspaceId)}?world=${encodeURIComponent(run.id)}`
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      saving = false
    }
  }

  const reset = (): void => {
    draft = createEmptyScenarioDraft()
    selection = { kind: 'scenario' }
    placementItemId = null
    saved = null
    error = null
  }

  void loadCatalog()
</script>

<main class:embedded class="scenario-builder">
  <header class="scenario-builder-header">
    <div><p class="eyebrow">World</p><h1>Build a scenario</h1><p>Choose features, place items, then save the result as a reusable card.</p></div>
    {#if !embedded}<a class="command-button" href={`/workspaces/${encodeURIComponent(workspaceId)}`}>Workspace home</a>{/if}
  </header>

  {#if loading}
    <section class="builder-message">Discovering World features…</section>
  {:else if !catalog}
    <section class="builder-message error">{error ?? 'Scenario authoring is unavailable.'}</section>
  {:else if saved}
    <section class="builder-success"><p class="eyebrow">Saved</p><h2>{saved.title}</h2><p>The scenario is now available on the Workspace homepage.</p><div><button class="command-button primary" onclick={reset}>Build another</button><a class="command-button" target="_top" href={`/workspaces/${encodeURIComponent(workspaceId)}`}>Back to Workspace</a></div></section>
  {:else}
    <section class="builder-toolbar">
      <label>Scenario title <input maxlength="160" value={draft.title} oninput={event => { draft.title = event.currentTarget.value; draft = { ...draft } }} /></label>
      <label class="feature-picker">Add feature <select bind:value={featureToAdd}><option value="">Choose…</option>{#each availableFeatures() as feature (feature.id)}<option value={feature.id}>{feature.title}</option>{/each}</select></label>
      <button disabled={!featureToAdd} onclick={addFeature}>Add</button>
      <span class="builder-spacer"></span>
      <button class="primary" disabled={saving} onclick={() => void save(false)}>Save</button>
      <button disabled={saving} onclick={() => void save(true)}>Save & start</button>
    </section>
    {#if error}<p class="builder-inline-error">{error}</p>{/if}
    <section class="builder-workbench">
      <aside class="builder-outline">
        <button class:active={selection.kind === 'scenario'} onclick={() => { selection = { kind: 'scenario' }; placementItemId = null }}><strong>Scenario</strong><small>Starting view</small></button>
        {#each activeFeatures() as feature (feature.id)}
          <section class="outline-feature">
            <button class:active={selection.kind === 'feature' && selection.id === feature.id} onclick={() => { selection = { kind: 'feature', id: feature.id }; placementItemId = null }}><strong>{feature.title}</strong><small>{draft.items.filter(item => item.pack === feature.id).length} items</small></button>
            {#each draft.items.filter(item => item.pack === feature.id) as item (item.id)}
              <button class:active={selection.kind === 'item' && selection.id === item.id} class="outline-item" onclick={() => { selection = { kind: 'item', id: item.id }; placementItemId = null }}><span>{item.label}</span><small>{item.type}</small></button>
            {/each}
          </section>
        {/each}
        {#if draft.packs.length === 0}<p class="outline-empty">Add a feature to begin.</p>{/if}
      </aside>

      <section class="builder-map-panel">
        {#if placementItemId}<div class="placement-banner">Click the map to place {draft.items.find(item => item.id === placementItemId)?.label}. <button onclick={() => { placementItemId = null }}>Cancel</button></div>{/if}
        <ScenarioBuilderMap
          center={mapCenter()} zoom={mapZoom()} points={mapPoints()}
          selectedId={selection.kind === 'item' ? selection.id : null}
          placementActive={placementItemId !== null} editView={selection.kind === 'scenario'}
          onviewchange={setMapView} onplace={placeItem}
          onselect={id => { selection = { kind: 'item', id }; placementItemId = null }}
        />
        {#if selection.kind === 'scenario'}<span class="map-hint">Pan and zoom to set the starting view</span>{/if}
      </section>

      <aside class="builder-properties">
        {#if selection.kind === 'scenario'}
          <h2>Scenario</h2><p>The map position is the starting frame users will see.</p>
          <label>Description <textarea rows="4" placeholder="Optional" value={draft.description ?? ''} oninput={event => { draft.description = event.currentTarget.value; draft = { ...draft } }}></textarea></label>
          <dl><div><dt>Center</dt><dd>{mapCenter().map(value => value.toFixed(4)).join(', ')}</dd></div><div><dt>Zoom</dt><dd>{mapZoom().toFixed(1)}</dd></div></dl>
        {:else if selection.kind === 'feature'}
          {@const feature = catalog.features.find(candidate => candidate.id === selection.id)}
          {#if feature}<h2>{feature.title}</h2><p>{feature.description}</p><h3>Add item</h3><div class="item-type-list">{#each feature.itemTypes as type (type.id)}<button onclick={() => addItem(feature, type)}><strong>{type.label}</strong><small>{type.description}</small></button>{/each}</div><button class="danger-text" onclick={() => removeFeature(feature)}>Remove feature</button>{/if}
        {:else}
          {@const item = selectedItem()}
          {@const type = selectedType()}
          {#if item && type}
            <p class="eyebrow">{catalog.features.find(feature => feature.id === item.pack)?.title}</p><h2>{type.label}</h2>
            <label>Name <input value={item.label} oninput={event => { item.label = event.currentTarget.value; draft = { ...draft } }} /></label>
            {#each type.fields as field (`${field.target}:${field.path.join('.')}`)}
              {@const target = field.target === 'item' ? item : selectedSystem()}
              {#if target}
                <label>{field.label}
                  {#if field.control.kind === 'select'}
                    <select value={String(valueAtPath(target, field.path) ?? field.control.defaultValue)} onchange={event => updateField(field, event.currentTarget.value)}>{#each field.control.options as option (option.value)}<option value={option.value}>{option.label}</option>{/each}</select>
                  {:else if field.control.kind === 'boolean'}
                    <input type="checkbox" checked={Boolean(valueAtPath(target, field.path) ?? field.control.defaultValue)} onchange={event => updateField(field, event.currentTarget.checked)} />
                  {:else if field.control.kind === 'number'}
                    <input type="number" value={Number(valueAtPath(target, field.path) ?? field.control.defaultValue)} min={field.control.min} max={field.control.max} step={field.control.step} onchange={event => updateField(field, event.currentTarget.valueAsNumber)} />
                  {:else}
                    <input value={String(valueAtPath(target, field.path) ?? field.control.defaultValue)} oninput={event => updateField(field, event.currentTarget.value)} />
                  {/if}
                </label>
              {/if}
            {/each}
            {#if type.placement}<button onclick={() => { placementItemId = item.id }}>Move on map</button>{/if}
            <button class="danger-text" onclick={() => removeItem(item)}>Remove item</button>
          {/if}
        {/if}
      </aside>
    </section>
  {/if}
</main>


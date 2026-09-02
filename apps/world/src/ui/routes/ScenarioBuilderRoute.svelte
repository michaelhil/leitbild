<script lang="ts">
  import type { ScenarioAuthoringCatalog } from '../../core/scenarios/authoring.ts'
  import ScenarioBuilderMap from '../ScenarioBuilderMap.svelte'
  import { parseControlSurfaceRoute } from '../simulation-run-route.ts'
  import {
    createEmptyScenarioSource,
    deepCopy,
    itemTypeFor,
    selectionFor,
    setValueAtPath,
    valueAtPath,
    type AuthoringPack,
    type AuthoringField,
    type AuthoringItemType,
    type ScenarioSourceRecord,
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

  interface ScenarioPreview {
    readonly scenarioId: string
    readonly packs: ReadonlyArray<string>
    readonly assets: ReadonlyArray<{
      readonly id: string
      readonly label: string
      readonly kind: string
      readonly packId: string
      readonly electricalPorts: ReadonlyArray<{
        readonly id: string
        readonly label: string
        readonly role: 'system' | 'network'
        readonly nominalKv: number
        readonly maximumExportMw: number
        readonly maximumImportMw: number
      }>
    }>
    readonly connections: ReadonlyArray<unknown>
  }

  type Selection = { readonly kind: 'scenario' } | { readonly kind: 'pack'; readonly id: string } | { readonly kind: 'item'; readonly id: string }

  const route = parseControlSurfaceRoute(location.pathname)
  if (route.mode !== 'scenario-builder') throw new Error('Scenario Builder route expected')
  const workspaceId = route.workspaceId
  const query = new URLSearchParams(location.search)
  const embedded = query.get('embed') === '1'
  const definitionId = query.get('definition')
  const requestedRevisionId = query.get('revision')

  let catalog = $state<ScenarioAuthoringCatalog | null>(null)
  let draft = $state<ScenarioSourceRecord>(createEmptyScenarioSource())
  let selection = $state<Selection>({ kind: 'scenario' })
  let placementItemId = $state<string | null>(null)
  let packToAdd = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let error = $state<string | null>(null)
  let saved = $state<CreateResult | null>(null)
  let editing = $state<CreateResult['definition'] | null>(null)
  let preview = $state<ScenarioPreview | null>(null)
  let previewError = $state<string | null>(null)
  let systemEndpointKey = $state('')
  let networkEndpointKey = $state('')
  let previewTimer: ReturnType<typeof setTimeout> | null = null

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

  const loadEditor = async (): Promise<void> => {
    try {
      const [catalogResponse, definitionResponse] = await Promise.all([
        invoke<InvocationResponse>('world.scenario-authoring.describe', {}),
        definitionId === null
          ? Promise.resolve(null)
          : fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/world/scenarios/${encodeURIComponent(definitionId)}`).then(async response => {
              const body = await response.json() as { source?: ScenarioSourceRecord; revisionId?: string; error?: { message?: string } }
              if (!response.ok || !body.source || !body.revisionId) throw new Error(body.error?.message ?? `Request failed: ${response.status}`)
              return body as { source: ScenarioSourceRecord; revisionId: string }
            }),
      ])
      catalog = catalogResponse.result as ScenarioAuthoringCatalog
      if (definitionResponse) {
        if (requestedRevisionId !== null && requestedRevisionId !== definitionResponse.revisionId) {
          throw new Error('This Scenario has changed. Reopen the editor from the Workspace homepage.')
        }
        draft = deepCopy(definitionResponse.source)
        editing = {
          workspaceId,
          moduleId: 'world',
          type: 'world.scenario',
          id: definitionResponse.source.id,
          revisionId: definitionResponse.revisionId,
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading = false
    }
  }

  const mapCenter = (): [number, number] => draft.view.map.center
  const mapZoom = (): number => draft.view.map.zoom
  const activePacks = (): ReadonlyArray<AuthoringPack> => catalog?.packs.filter(pack => selectionFor(draft, pack.id) !== undefined) ?? []
  const availablePacks = (): ReadonlyArray<AuthoringPack> => catalog?.packs.filter(pack => selectionFor(draft, pack.id) === undefined) ?? []
  const allItems = () => draft.packs.flatMap(pack => pack.items.map(item => ({ packId: pack.id, item })))
  const electricalEndpoints = () => preview?.assets.flatMap(asset => asset.electricalPorts.map(port => ({
    key: `${asset.id}\u0000${port.id}`,
    objectId: asset.id,
    objectLabel: asset.label,
    packId: asset.packId,
    ...port,
  }))) ?? []
  const systemElectricalEndpoints = () => electricalEndpoints().filter(endpoint => endpoint.role === 'system')
  const networkElectricalEndpoints = () => electricalEndpoints().filter(endpoint => endpoint.role === 'network')
  const selectedEntry = () => selection.kind === 'item' ? allItems().find(entry => entry.item.id === selection.id) : undefined
  const selectedItem = () => selectedEntry()?.item
  const recordingSelectionFor = (packId: string) => draft.recording.find(selection => selection.packId === packId)
  const selectedType = (): AuthoringItemType | undefined => {
    const item = selectedItem()
    const entry = selectedEntry()
    return entry && catalog ? itemTypeFor(catalog, entry.packId, entry.item) : undefined
  }
  const selectedLinkedConfig = (): Record<string, unknown> | undefined => {
    const item = selectedItem()
    const entry = selectedEntry()
    const type = selectedType()
    if (!item || !entry || !type?.linkedConfig) return undefined
    const id = valueAtPath(item, type.linkedConfig.itemReferencePath)
    const entries = valueAtPath(selectionFor(draft, entry.packId)?.config, type.linkedConfig.collectionPath)
    return typeof id === 'string' && Array.isArray(entries)
      ? entries.find(candidate => candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === id) as Record<string, unknown> | undefined
      : undefined
  }

  const mapPoints = (): ReadonlyArray<{ id: string; label: string; coordinates: [number, number] }> => !catalog ? [] : allItems().flatMap(({ packId, item }) => {
    const type = itemTypeFor(catalog, packId, item)
    if (!type?.placement) return []
    const value = valueAtPath(item, type.placement.path)
    return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number'
      ? [{ id: item.id, label: item.label, coordinates: [value[0], value[1]] }]
      : []
  })

  const updateRailSections = (): void => {
    if (!draft.view.rail) draft.view.rail = { width: 340, sections: [] }
    draft.view.rail.sections = activePacks().flatMap(pack => pack.categoryIds.map(categoryId => ({
      categoryId, visible: true, collapsed: false, visibleFields: [],
    })))
  }

  const addPack = (): void => {
    const pack = catalog?.packs.find(candidate => candidate.id === packToAdd)
    if (!pack || selectionFor(draft, pack.id)) return
    draft.packs.push({ id: pack.id, config: {}, items: [] })
    updateRailSections()
    draft = { ...draft }
    selection = { kind: 'pack', id: pack.id }
    packToAdd = ''
  }

  const removePack = (pack: AuthoringPack): void => {
    if (!confirm(`Remove ${pack.title} and all of its items from this scenario?`)) return
    const removedItems = selectionFor(draft, pack.id)?.items ?? []
    draft.packs = draft.packs.filter(selection => selection.id !== pack.id)
    const removedIds = new Set(removedItems.map(item => item.id))
    draft.connections = draft.connections.filter(connection =>
      !removedIds.has(connection.system.objectId) && !removedIds.has(connection.network.objectId))
    draft.recording = draft.recording.filter(selection => selection.packId !== pack.id)
    updateRailSections()
    draft = { ...draft }
    selection = { kind: 'scenario' }
    if (placementItemId && removedItems.some(item => item.id === placementItemId)) placementItemId = null
  }

  const setRecordingProfile = (pack: AuthoringPack, profileId: string): void => {
    draft.recording = draft.recording.filter(selection => selection.packId !== pack.id)
    const profile = pack.recordingProfiles.find(candidate => candidate.id === profileId)
    if (profile) draft.recording.push({ packId: pack.id, profileId: profile.id, intervalMs: profile.defaultIntervalMs })
    draft = { ...draft }
  }

  const setRecordingInterval = (pack: AuthoringPack, seconds: number): void => {
    const selection = recordingSelectionFor(pack.id)
    const profile = pack.recordingProfiles.find(candidate => candidate.id === selection?.profileId)
    if (!selection || !profile || !Number.isFinite(seconds)) return
    selection.intervalMs = Math.max(profile.minimumIntervalMs, Math.round(seconds * 1_000))
    draft = { ...draft }
  }

  const addItem = (packDescription: AuthoringPack, type: AuthoringItemType): void => {
    const id = `${type.idPrefix}-${crypto.randomUUID()}`
    const pack = selectionFor(draft, packDescription.id)
    if (!pack) return
    const count = pack.items.filter(item => item.type === type.id).length + 1
    const item = {
      type: type.id,
      id,
      label: `${type.label} ${count}`,
      ...deepCopy(type.defaultItem),
    }
    if (type.linkedConfig) {
      const configId = `${type.linkedConfig.idPrefix}-${crypto.randomUUID()}`
      setValueAtPath(item, type.linkedConfig.itemReferencePath, configId)
      const current = valueAtPath(pack.config, type.linkedConfig.collectionPath)
      const entries = Array.isArray(current) ? current : []
      entries.push({ id: configId, ...deepCopy(type.linkedConfig.defaults) })
      setValueAtPath(pack.config, type.linkedConfig.collectionPath, entries)
    }
    pack.items.push(item)
    selection = { kind: 'item', id }
    if (type.placement) placementItemId = id
    draft = { ...draft }
  }

  const removeItem = (item: ScenarioSourceRecord['packs'][number]['items'][number]): void => {
    const entry = allItems().find(candidate => candidate.item.id === item.id)
    if (!entry) return
    const pack = selectionFor(draft, entry.packId)!
    const type = catalog ? itemTypeFor(catalog, entry.packId, item) : undefined
    if (type?.linkedConfig) {
      const configId = valueAtPath(item, type.linkedConfig.itemReferencePath)
      const current = valueAtPath(pack.config, type.linkedConfig.collectionPath)
      if (typeof configId === 'string' && Array.isArray(current)) {
        setValueAtPath(pack.config, type.linkedConfig.collectionPath, current.filter(candidate =>
          !candidate || typeof candidate !== 'object' || (candidate as { id?: unknown }).id !== configId))
      }
    }
    pack.items = pack.items.filter(candidate => candidate.id !== item.id)
    draft.connections = draft.connections.filter(connection =>
      connection.system.objectId !== item.id && connection.network.objectId !== item.id)
    draft = { ...draft }
    selection = { kind: 'pack', id: entry.packId }
    if (placementItemId === item.id) placementItemId = null
  }

  const setMapView = (center: [number, number], zoom: number): void => {
    draft.view.map.center = center
    draft.view.map.zoom = Math.round(zoom * 100) / 100
    draft = { ...draft }
  }

  const placeItem = (coordinates: [number, number]): void => {
    if (!placementItemId || !catalog) return
    const entry = allItems().find(candidate => candidate.item.id === placementItemId)
    const item = entry?.item
    const type = item && entry ? itemTypeFor(catalog, entry.packId, item) : undefined
    if (!item || !type?.placement) return
    setValueAtPath(item, type.placement.path, coordinates)
    draft = { ...draft }
    placementItemId = null
  }

  const updateField = (field: AuthoringField, value: unknown): void => {
    const target = field.target === 'item' ? selectedItem() : selectedLinkedConfig()
    if (!target) return
    setValueAtPath(target, field.path, value)
    draft = { ...draft }
  }

  const addElectricalConnection = (): void => {
    const system = electricalEndpoints().find(endpoint => endpoint.key === systemEndpointKey)
    const network = electricalEndpoints().find(endpoint => endpoint.key === networkEndpointKey)
    if (!system || !network) return
    if (system.objectId === network.objectId) {
      previewError = 'Connect ports on two different assets.'
      return
    }
    if (system.nominalKv !== network.nominalKv) {
      previewError = `Voltage mismatch: ${system.nominalKv} kV and ${network.nominalKv} kV.`
      return
    }
    const endpointAlreadyConnected = draft.connections.some(connection =>
      (connection.system.objectId === system.objectId && connection.system.portId === system.id)
      || (connection.network.objectId === system.objectId && connection.network.portId === system.id)
      || (connection.system.objectId === network.objectId && connection.system.portId === network.id)
      || (connection.network.objectId === network.objectId && connection.network.portId === network.id))
    if (endpointAlreadyConnected) {
      previewError = 'Each electrical port can have only one connection.'
      return
    }
    draft.connections.push({
      id: `electrical-${crypto.randomUUID()}`,
      type: 'electrical',
      system: { objectId: system.objectId, portId: system.id },
      network: { objectId: network.objectId, portId: network.id },
    })
    draft = { ...draft }
    systemEndpointKey = ''
    networkEndpointKey = ''
  }

  const removeConnection = (id: string): void => {
    draft.connections = draft.connections.filter(connection => connection.id !== id)
    draft = { ...draft }
  }

  const validationError = (): string | null => {
    if (draft.title.trim().length === 0) return 'Give the scenario a title.'
    if (draft.packs.length === 0) return 'Add at least one Pack.'
    if (placementItemId) return 'Place the selected item on the map.'
    if (catalog && allItems().some(({ packId, item }) => {
      const type = itemTypeFor(catalog, packId, item)
      return type?.placement && valueAtPath(item, type.placement.path) === undefined
    })) return 'Every map item needs a position.'
    if (previewError) return previewError
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
      const response = editing === null
        ? await invoke<InvocationResponse>('world.scenario.create', { source: draft })
        : await invoke<InvocationResponse>('world.scenario.update', { source: draft }, editing)
      saved = response.result as CreateResult
      editing = saved.definition
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
    draft = createEmptyScenarioSource()
    editing = null
    selection = { kind: 'scenario' }
    placementItemId = null
    saved = null
    error = null
  }

  $effect(() => {
    const source = JSON.stringify(draft)
    if (loading || catalog === null) return
    if (draft.packs.length === 0) {
      preview = null
      previewError = null
      return
    }
    if (previewTimer !== null) clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      void invoke<InvocationResponse>('world.scenario.preview', { source: JSON.parse(source) })
        .then(response => {
          preview = response.result as ScenarioPreview
          previewError = null
        })
        .catch(cause => {
          preview = null
          previewError = cause instanceof Error ? cause.message : String(cause)
        })
    }, 250)
    return () => {
      if (previewTimer !== null) clearTimeout(previewTimer)
    }
  })

  void loadEditor()
</script>

<main class:embedded class="scenario-builder">
  <header class="scenario-builder-header">
    <div><p class="eyebrow">World</p><h1>{editing ? 'Edit scenario' : 'Build a scenario'}</h1><p>Choose Packs, place items, then save the result as a reusable card.</p></div>
    {#if !embedded}<a class="command-button" href={`/workspaces/${encodeURIComponent(workspaceId)}`}>Workspace home</a>{/if}
  </header>

  {#if loading}
    <section class="builder-message">Discovering World Packs…</section>
  {:else if !catalog}
    <section class="builder-message error">{error ?? 'Scenario authoring is unavailable.'}</section>
  {:else if saved}
    <section class="builder-success"><p class="eyebrow">Saved</p><h2>{saved.title}</h2><p>The scenario is now available on the Workspace homepage.</p><div><button class="command-button primary" onclick={reset}>Build another</button><a class="command-button" target="_top" href={`/workspaces/${encodeURIComponent(workspaceId)}`}>Back to Workspace</a></div></section>
  {:else}
    <section class="builder-toolbar">
      <label>Scenario title <input maxlength="160" value={draft.title} oninput={event => { draft.title = event.currentTarget.value; draft = { ...draft } }} /></label>
      <label class="feature-picker">Add Pack <select bind:value={packToAdd}><option value="">Choose…</option>{#each availablePacks() as pack (pack.id)}<option value={pack.id}>{pack.title}</option>{/each}</select></label>
      <button disabled={!packToAdd} onclick={addPack}>Add</button>
      <span class="builder-spacer"></span>
      <button class="primary" disabled={saving} onclick={() => void save(false)}>{editing ? 'Save revision' : 'Save'}</button>
      <button disabled={saving} onclick={() => void save(true)}>Save & start</button>
    </section>
    {#if error}<p class="builder-inline-error">{error}</p>{/if}
    <section class="builder-workbench">
      <aside class="builder-outline">
        <button class:active={selection.kind === 'scenario'} onclick={() => { selection = { kind: 'scenario' }; placementItemId = null }}><strong>Scenario</strong><small>Starting view</small></button>
        {#each activePacks() as pack (pack.id)}
          <section class="outline-feature">
            <button class:active={selection.kind === 'pack' && selection.id === pack.id} onclick={() => { selection = { kind: 'pack', id: pack.id }; placementItemId = null }}><strong>{pack.title}</strong><small>{selectionFor(draft, pack.id)?.items.length ?? 0} items</small></button>
            {#each selectionFor(draft, pack.id)?.items ?? [] as item (item.id)}
              <button class:active={selection.kind === 'item' && selection.id === item.id} class="outline-item" onclick={() => { selection = { kind: 'item', id: item.id }; placementItemId = null }}><span>{item.label}</span><small>{item.type}</small></button>
            {/each}
          </section>
        {/each}
        {#if draft.packs.length === 0}<p class="outline-empty">Add a Pack to begin.</p>{/if}
      </aside>

      <section class="builder-map-panel">
        {#if placementItemId}<div class="placement-banner">Click the map to place {allItems().find(entry => entry.item.id === placementItemId)?.item.label}. <button onclick={() => { placementItemId = null }}>Cancel</button></div>{/if}
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
          <h3>Electrical connections</h3>
          {#if systemElectricalEndpoints().length === 0 || networkElectricalEndpoints().length === 0}
            <p>Add both a system asset and a network asset with compatible electrical ports.</p>
          {:else}
            <label>System port
              <select bind:value={systemEndpointKey}>
                <option value="">Choose…</option>
                {#each systemElectricalEndpoints() as endpoint (endpoint.key)}
                  <option value={endpoint.key}>{endpoint.objectLabel} · {endpoint.label} · {endpoint.nominalKv} kV</option>
                {/each}
              </select>
            </label>
            <label>Network port
              <select bind:value={networkEndpointKey}>
                <option value="">Choose…</option>
                {#each networkElectricalEndpoints() as endpoint (endpoint.key)}
                  <option value={endpoint.key}>{endpoint.objectLabel} · {endpoint.label} · {endpoint.nominalKv} kV</option>
                {/each}
              </select>
            </label>
            <button disabled={!systemEndpointKey || !networkEndpointKey} onclick={addElectricalConnection}>Connect ports</button>
          {/if}
          {#if previewError}<p class="connection-error">{previewError}</p>{/if}
          {#if draft.connections.length > 0}
            <div class="connection-list">
              {#each draft.connections as connection (connection.id)}
                {@const system = electricalEndpoints().find(endpoint => endpoint.objectId === connection.system.objectId && endpoint.id === connection.system.portId)}
                {@const network = electricalEndpoints().find(endpoint => endpoint.objectId === connection.network.objectId && endpoint.id === connection.network.portId)}
                <div>
                  <span>{system?.objectLabel ?? connection.system.objectId} ↔ {network?.objectLabel ?? connection.network.objectId}</span>
                  <small>{system?.label ?? connection.system.portId} · {network?.label ?? connection.network.portId}</small>
                  <button aria-label={`Remove ${connection.id}`} title="Remove connection" onclick={() => removeConnection(connection.id)}>×</button>
                </div>
              {/each}
            </div>
          {/if}
        {:else if selection.kind === 'pack'}
          {@const pack = catalog.packs.find(candidate => candidate.id === selection.id)}
          {#if pack}
            {@const packSelection = selectionFor(draft, pack.id)}
            <h2>{pack.title}</h2><p>{pack.description}</p>
            {#if packSelection && pack.runtimes.length > 1}
              <label>Runtime
                <select value={packSelection.runtime ?? pack.defaultRuntimeId} onchange={event => { packSelection.runtime = event.currentTarget.value; draft = { ...draft } }}>
                  {#each pack.runtimes as runtime (runtime.id)}<option value={runtime.id}>{runtime.label} · {runtime.kind}</option>{/each}
                </select>
              </label>
            {/if}
            {#if pack.recordingProfiles.length > 0}
              {@const recording = recordingSelectionFor(pack.id)}
              <label>Recording
                <select value={recording?.profileId ?? ''} onchange={event => setRecordingProfile(pack, event.currentTarget.value)}>
                  <option value="">Off</option>
                  {#each pack.recordingProfiles as profile (profile.id)}<option value={profile.id}>{profile.title}</option>{/each}
                </select>
              </label>
              {#if recording}
                {@const profile = pack.recordingProfiles.find(candidate => candidate.id === recording.profileId)}
                {#if profile}
                  <p>{profile.description}</p>
                  <label>Sample interval (seconds)
                    <input type="number" min={profile.minimumIntervalMs / 1_000} step={profile.minimumIntervalMs / 1_000} value={(recording.intervalMs ?? profile.defaultIntervalMs) / 1_000} onchange={event => setRecordingInterval(pack, event.currentTarget.valueAsNumber)} />
                  </label>
                {/if}
              {/if}
            {/if}
            <h3>Add item</h3><div class="item-type-list">{#each pack.itemTypes as type (type.id)}<button onclick={() => addItem(pack, type)}><strong>{type.label}</strong><small>{type.description}</small></button>{/each}</div><button class="danger-text" onclick={() => removePack(pack)}>Remove Pack</button>
          {/if}
        {:else}
          {@const item = selectedItem()}
          {@const type = selectedType()}
          {#if item && type}
            <p class="eyebrow">{catalog.packs.find(pack => pack.id === selectedEntry()?.packId)?.title}</p><h2>{type.label}</h2>
            <label>Name <input value={item.label} oninput={event => { item.label = event.currentTarget.value; draft = { ...draft } }} /></label>
            {#each type.fields as field (`${field.target}:${field.path.join('.')}`)}
              {@const target = field.target === 'item' ? item : selectedLinkedConfig()}
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

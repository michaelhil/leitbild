<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    coreModuleIds,
    type InspectionView,
    type ModuleCapabilityDescriptor,
    type ModuleDefinitionDescriptor,
    type ModuleResourceDescriptor,
    type ResourceSummaryItem,
    type Workspace,
  } from '@leitbild/contracts'
  import JsonTree from './JsonTree.svelte'
  import WorkspaceComposer from './WorkspaceComposer.svelte'

  type Page = { readonly kind: 'list' } | { readonly kind: 'workspace'; readonly id: string }
  interface CompositionDefinition { readonly id: string; readonly title: string; readonly description: string }
  interface InvocationResponse {
    readonly result: unknown
    readonly createdResources?: ReadonlyArray<ModuleResourceDescriptor['ref']>
  }
  interface CompositionResponse {
    readonly application: {
      readonly status: 'applied' | 'partial' | 'failed'
      readonly outcomes: ReadonlyArray<{
        readonly error?: string
        readonly createdResources?: ReadonlyArray<ModuleResourceDescriptor['ref']>
      }>
    }
  }
  type InspectionSubject =
    | { readonly kind: 'definition'; readonly descriptor: ModuleDefinitionDescriptor }
    | { readonly kind: 'resource'; readonly descriptor: ModuleResourceDescriptor }

  const moduleTitles: Readonly<Record<string, string>> = { world: 'World', agents: 'Agents' }
  const page = (): Page => {
    if (location.pathname === '/workspaces') return { kind: 'list' }
    const match = location.pathname.match(/^\/workspaces\/([^/]+)$/)
    if (!match) throw new Error('Unknown Workspace route')
    return { kind: 'workspace', id: decodeURIComponent(match[1] ?? '') }
  }

  const currentPage = page()
  const initialSelection = new URLSearchParams(location.search)
  let selectedWorldRunId = $state(initialSelection.get('world'))
  let selectedAgentsRoomId = $state(initialSelection.get('agents'))
  let workspaces = $state<ReadonlyArray<Workspace>>([])
  let workspace = $state<Workspace | null>(null)
  let name = $state('')
  let createName = $state('')
  let loading = $state(true)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let settingsDialog = $state<HTMLDialogElement | null>(null)
  let inspectionDialog = $state<HTMLDialogElement | null>(null)
  let inspectionSubject = $state<InspectionSubject | null>(null)
  let inspectionView = $state<InspectionView | null>(null)
  let inspectionLoading = $state(false)
  let inspectionError = $state<string | null>(null)
  let inspectionCopied = $state(false)
  let compositions = $state<ReadonlyArray<CompositionDefinition>>([])
  let definitions = $state<ReadonlyArray<ModuleDefinitionDescriptor>>([])
  let resources = $state<ReadonlyArray<ModuleResourceDescriptor>>([])
  let capabilities = $state<ReadonlyArray<ModuleCapabilityDescriptor>>([])
  let summaryClock = $state(Date.now())
  let scenarioEditorPath = $state<string | null>(null)
  const workspaceTitle = $derived(workspace?.name ?? workspace?.id ?? 'Workspace')
  const showingComposer = $derived(selectedWorldRunId !== null || selectedAgentsRoomId !== null)
  const continuableResources = $derived(resources.filter(resource => resource.uiPath !== undefined))

  const request = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(path, options)
    if (response.status === 204) return undefined as T
    const body = await response.json() as T & { error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message ?? `Request failed: ${response.status}`)
    return body
  }

  const loadWorkspaceCatalog = async (workspaceId: string): Promise<void> => {
    const encoded = encodeURIComponent(workspaceId)
    const [definitionResponse, resourceResponse, capabilityResponse] = await Promise.all([
      request<{ definitions: ReadonlyArray<ModuleDefinitionDescriptor> }>(`/api/workspaces/${encoded}/definitions`),
      request<{ resources: ReadonlyArray<ModuleResourceDescriptor> }>(`/api/workspaces/${encoded}/resources`),
      request<{ capabilities: ReadonlyArray<ModuleCapabilityDescriptor> }>(`/api/workspaces/${encoded}/capabilities`),
    ])
    definitions = definitionResponse.definitions
    resources = resourceResponse.resources
    capabilities = capabilityResponse.capabilities
  }

  const refreshResources = async (workspaceId: string): Promise<void> => {
    const response = await request<{ resources: ReadonlyArray<ModuleResourceDescriptor> }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/resources`,
    )
    resources = response.resources
  }

  const handleWindowMessage = (event: MessageEvent): void => {
    if (event.origin !== location.origin || !workspace) return
    const data = event.data as { readonly type?: unknown }
    if (data.type === 'leitbild:scenario-saved') void loadWorkspaceCatalog(workspace.id)
  }

  const load = async (): Promise<void> => {
    loading = true
    error = null
    try {
      if (currentPage.kind === 'list') {
        workspaces = (await request<{ workspaces: ReadonlyArray<Workspace> }>('/api/workspaces')).workspaces
      } else {
        const workspaceId = encodeURIComponent(currentPage.id)
        const [workspaceResponse, compositionResponse] = await Promise.all([
          request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`),
          request<{ compositions: ReadonlyArray<CompositionDefinition> }>('/api/compositions'),
          loadWorkspaceCatalog(currentPage.id),
        ])
        workspace = workspaceResponse.workspace
        compositions = compositionResponse.compositions
        name = workspace.name ?? ''
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading = false
    }
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    busy = true
    error = null
    try { await action() }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    finally { busy = false }
  }

  const createWorkspace = (): Promise<void> => run(async () => {
    const response = await request<{ workspace: Workspace }>('/api/workspaces', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: createName.trim() || null }),
    })
    location.href = `/workspaces/${response.workspace.id}`
  })

  const saveName = (): Promise<void> => run(async () => {
    if (!workspace) return
    const response = await request<{ workspace: Workspace }>(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || null }),
    })
    workspace = response.workspace
    name = workspace.name ?? ''
  })

  const retryModule = (moduleId: string): Promise<void> => run(async () => {
    if (!workspace) return
    workspace = (await request<{ workspace: Workspace }>(
      `/api/workspaces/${workspace.id}/modules/${encodeURIComponent(moduleId)}/retry`, { method: 'POST' },
    )).workspace
    await loadWorkspaceCatalog(workspace.id)
  })

  const deleteWorkspace = (): Promise<void> => run(async () => {
    if (!workspace || !confirm('Delete this Workspace and all of its World and Agents state?')) return
    await request(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })
    location.href = '/workspaces'
  })

  const openResources = (created: ReadonlyArray<ModuleResourceDescriptor['ref']>): void => {
    const world = created.find(resource => resource.moduleId === 'world' && resource.type === 'world.simulation-run')
    const agents = created.find(resource => resource.moduleId === 'agents' && resource.type === 'agents.room')
    const params = new URLSearchParams()
    if (world) params.set('world', world.id)
    else if (selectedWorldRunId) params.set('world', selectedWorldRunId)
    if (agents) params.set('agents', agents.id)
    else if (selectedAgentsRoomId) params.set('agents', selectedAgentsRoomId)
    location.href = `${location.pathname}${params.size > 0 ? `?${params}` : ''}`
  }

  const invokeDefinition = (definition: ModuleDefinitionDescriptor, capability: ModuleCapabilityDescriptor): Promise<void> => run(async () => {
    if (!workspace) return
    if (capability.risk === 'destructive' && !confirm(`${capability.title}: ${definition.title}? Existing live resources will remain.`)) return
    const response = await request<InvocationResponse>(
      `/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(capability.id)}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: { ...definition.ref, revisionId: definition.currentRevisionId },
          input: {}, actor: { kind: 'human' },
        }),
      },
    )
    if (response.createdResources?.length) openResources(response.createdResources)
    else await loadWorkspaceCatalog(workspace.id)
  })

  const invokeResource = (resource: ModuleResourceDescriptor, capability: ModuleCapabilityDescriptor): Promise<void> => run(async () => {
    if (!workspace) return
    if (capability.risk === 'destructive' && !confirm(`${capability.title}: ${resource.title}? This cannot be undone.`)) return
    await request<InvocationResponse>(
      `/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(capability.id)}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: resource.ref, input: {}, actor: { kind: 'human' } }),
      },
    )
    await loadWorkspaceCatalog(workspace.id)
  })

  const inspect = async (subject: InspectionSubject): Promise<void> => {
    if (!workspace) return
    const capabilityId = subject.descriptor.inspectionCapabilityId
    const capability = capabilityId === undefined ? undefined : capabilityFor(capabilityId)
    const correctlyScoped = capability !== undefined && (
      subject.kind === 'definition'
        ? capability.scope.kind === 'definition' && capability.scope.definitionType === subject.descriptor.ref.type
        : capability.scope.kind === 'resource' && capability.scope.resourceType === subject.descriptor.ref.type
    )
    if (!capability || capability.kind !== 'query' || capability.risk !== 'read' || !correctlyScoped) {
      error = 'This item does not publish a valid read-only Inspection Capability.'
      return
    }
    inspectionSubject = subject
    inspectionView = null
    inspectionError = null
    inspectionCopied = false
    inspectionLoading = true
    inspectionDialog?.showModal()
    try {
      const response = await request<InvocationResponse>(
        `/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(capability.id)}/invoke`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(subject.kind === 'definition'
              ? { definition: { ...subject.descriptor.ref, revisionId: subject.descriptor.currentRevisionId } }
              : { resource: subject.descriptor.ref }),
            input: {}, actor: { kind: 'human' },
          }),
        },
      )
      inspectionView = response.result as InspectionView
    } catch (cause) {
      inspectionError = cause instanceof Error ? cause.message : String(cause)
    } finally {
      inspectionLoading = false
    }
  }

  const inspectedCapabilities = (): ReadonlyArray<ModuleCapabilityDescriptor> => inspectionSubject === null
    ? []
    : inspectionSubject.descriptor.capabilityIds.flatMap(id => {
      const capability = capabilityFor(id)
      return capability === undefined ? [] : [capability]
    })

  const inspectionExport = (): unknown => inspectionSubject === null ? null : {
    kind: inspectionSubject.kind,
    descriptor: inspectionSubject.descriptor,
    capabilities: inspectedCapabilities(),
    inspection: inspectionView,
  }

  const copyInspection = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(inspectionExport(), null, 2))
      inspectionCopied = true
      setTimeout(() => { inspectionCopied = false }, 1_500)
    } catch (cause) {
      inspectionError = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const startComposition = (compositionId: string): Promise<void> => run(async () => {
    if (!workspace) return
    const response = await request<CompositionResponse>(
      `/api/workspaces/${workspace.id}/compositions/${encodeURIComponent(compositionId)}/start`, { method: 'POST' },
    )
    const created = response.application.outcomes.flatMap(outcome => outcome.createdResources ?? [])
    if (response.application.status === 'failed') {
      throw new Error(response.application.outcomes.flatMap(outcome => outcome.error ? [outcome.error] : []).join('; ') || 'Composition failed')
    }
    openResources(created)
  })

  const openResource = (resource: ModuleResourceDescriptor): void => {
    const params = new URLSearchParams()
    if (resource.ref.type === 'world.simulation-run') params.set('world', resource.ref.id)
    if (resource.ref.type === 'agents.room') params.set('agents', resource.ref.id)
    if (params.size > 0) location.href = `${location.pathname}?${params}`
    else if (resource.uiPath) location.href = resource.uiPath
  }

  const capabilityFor = (id: string): ModuleCapabilityDescriptor | undefined => capabilities.find(item => item.id === id)
  const acceptsEmptyInput = (capability: ModuleCapabilityDescriptor): boolean => {
    const required = capability.inputSchema.required
    return !Array.isArray(required) || required.length === 0
  }
  const destructiveCapabilityFor = (resource: ModuleResourceDescriptor): ModuleCapabilityDescriptor | undefined =>
    resource.capabilityIds.map(capabilityFor).find(capability => capability?.risk === 'destructive')
  const definitionsFor = (moduleId: string): ReadonlyArray<ModuleDefinitionDescriptor> => definitions.filter(item => item.ref.moduleId === moduleId)
  const resourcesFor = (moduleId: string): ReadonlyArray<ModuleResourceDescriptor> => continuableResources.filter(item => item.ref.moduleId === moduleId)
  const relativeTime = (timestamp: string): string => {
    const deltaSeconds = Math.round((summaryClock - Date.parse(timestamp)) / 1000)
    const future = deltaSeconds < 0
    const seconds = Math.abs(deltaSeconds)
    if (seconds < 10) return 'just now'
    const [value, unit] = seconds < 60
      ? [seconds, 's']
      : seconds < 3_600
        ? [Math.round(seconds / 60), 'm']
        : seconds < 86_400
          ? [Math.round(seconds / 3_600), 'h']
          : [Math.round(seconds / 86_400), 'd']
    return future ? `in ${value}${unit}` : `${value}${unit} ago`
  }
  const summaryValue = (item: ResourceSummaryItem): string =>
    item.kind === 'timestamp' ? relativeTime(item.value) : String(item.value)
  const refreshInterval = setInterval(() => {
    summaryClock = Date.now()
    if (currentPage.kind === 'workspace' && workspace && !showingComposer) {
      void refreshResources(workspace.id).catch(() => undefined)
    }
  }, 20_000)
  onDestroy(() => clearInterval(refreshInterval))

  void load()
</script>

<svelte:window onmessage={handleWindowMessage} />

{#if currentPage.kind === 'workspace' && workspace}
  <header class="workspace-bar">
    <div class="workspace-identity"><a class="brand" href={`/workspaces/${workspace.id}`}>Leitbild</a><span aria-hidden="true">/</span><span class="workspace-name" title={workspaceTitle}>{workspaceTitle}</span></div>
    <button class="icon-button" type="button" aria-label="Workspace settings" title="Workspace settings" onclick={() => settingsDialog?.showModal()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.42 1.42-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V20h-2v-.09A1.7 1.7 0 0 0 12.38 18a1.7 1.7 0 0 0-1.88.34l-.06.06-1.42-1.42.06-.06A1.7 1.7 0 0 0 9.42 15a1.7 1.7 0 0 0-1.55-1.03H7v-2h.09A1.7 1.7 0 0 0 9 10.94a1.7 1.7 0 0 0-.34-1.88L8.6 9l1.42-1.42.06.06A1.7 1.7 0 0 0 12 8a1.7 1.7 0 0 0 1.03-1.55V6h2v.09A1.7 1.7 0 0 0 16.06 8a1.7 1.7 0 0 0 1.88-.34l.06-.06L19.42 9l-.06.06A1.7 1.7 0 0 0 19.7 11a1.7 1.7 0 0 0 1.55 1.03H22v2h-.09A1.7 1.7 0 0 0 20 15Z" /></svg>
    </button>
  </header>
{:else}
  <header class="topbar"><a class="brand" href="/">Leitbild</a><a href="/workspaces">Workspaces</a></header>
{/if}

<main class:workspace-main={currentPage.kind === 'workspace' && showingComposer}>
  {#if loading}
    <section class="notice">Loading Workspace…</section>
  {:else if error && currentPage.kind === 'workspace' && !workspace}
    <section class="notice error"><h1>Workspace unavailable</h1><p>{error}</p><a href="/workspaces">Back to Workspaces</a></section>
  {:else if currentPage.kind === 'list'}
    <section class="hero"><div><p class="eyebrow">Leitbild</p><h1>Workspaces</h1></div><p>Each Workspace contains World and Agents.</p></section>
    {#if error}<p class="notice error">{error}</p>{/if}
    <section class="panel create-panel"><div><h2>{workspaces.length === 0 ? 'Meet Leitbild' : 'New Workspace'}</h2><p>Names are optional; the UUID is the stable identity.</p></div><label>Name <input bind:value={createName} maxlength="256" placeholder="Optional name" /></label><button class="primary" disabled={busy} onclick={() => void createWorkspace()}>Create Workspace</button></section>
    <section class="workspace-grid">{#each workspaces as item (item.id)}<article class="workspace-card"><div><h2>{item.name ?? item.id}</h2>{#if item.name}<code>{item.id}</code>{/if}</div><div class="chips">{#each coreModuleIds as moduleId}<span>{moduleTitles[moduleId]}</span>{/each}</div><div class="actions"><a class="button primary" href={`/workspaces/${item.id}`}>Open Workspace</a></div></article>{/each}</section>
  {:else if workspace}
    {#if showingComposer}
      <WorkspaceComposer workspaceId={workspace.id} worldRunId={selectedWorldRunId} agentsRoomId={selectedAgentsRoomId} />
    {:else}
      <section class="workspace-home">
        <header class="catalog-hero"><div><p class="eyebrow">{workspaceTitle}</p><h1>What do you want to open?</h1></div><p>Start a reusable definition or continue an existing resource.</p></header>
        {#if error}<p class="notice error">{error}</p>{/if}
        <section class="catalog-section-home scenario-builder-home">
          <header><h2>Create</h2><span>World scenario</span></header>
          {#if scenarioEditorPath}
            <div class="scenario-builder-frame"><button class="builder-close" type="button" onclick={() => { scenarioEditorPath = null }}>Close editor</button><iframe title="World Scenario Editor" src={`${scenarioEditorPath}${scenarioEditorPath.includes('?') ? '&' : '?'}embed=1`}></iframe></div>
          {:else}
            <article class="scenario-builder-launch"><div><h3>Build a scenario</h3><p>Pick World Packs, place assets on the map, and save the result as a reusable scenario.</p></div><button class="primary" onclick={() => { scenarioEditorPath = `/workspaces/${encodeURIComponent(workspace.id)}/world/scenarios/new` }}>Open editor</button></article>
          {/if}
        </section>
        {#if compositions.length > 0}<section class="catalog-section-home"><header><h2>Combined</h2><span>World + Agents</span></header><div class="catalog-grid">{#each compositions as composition (composition.id)}<article class="catalog-card"><div><h3>{composition.title}</h3><p>{composition.description}</p></div><button class="primary" disabled={busy} onclick={() => void startComposition(composition.id)}>Start</button></article>{/each}</div></section>{/if}
        {#each coreModuleIds as moduleId}
          <section class="catalog-section-home"><header><h2>{moduleTitles[moduleId]}</h2><span>{definitionsFor(moduleId).length} definitions</span></header><div class="catalog-grid">
            {#each definitionsFor(moduleId) as definition (`${definition.ref.type}:${definition.ref.id}`)}
              <article class="catalog-card"><div>{#if definition.category}<span class="card-category">{definition.category}</span>{/if}<h3>{definition.title}</h3><p>{definition.description ?? definition.ref.id}</p></div><div class="card-actions">{#if definition.uiPath}<button onclick={() => { scenarioEditorPath = definition.uiPath ?? null }}>Edit</button>{/if}{#each definition.capabilityIds.filter(id => id !== definition.inspectionCapabilityId) as capabilityId}{@const capability = capabilityFor(capabilityId)}{#if capability && acceptsEmptyInput(capability)}<button class:primary={capability.risk !== 'destructive'} class:danger={capability.risk === 'destructive'} disabled={busy} onclick={() => void invokeDefinition(definition, capability)}>{capability.title}</button>{/if}{/each}{#if definition.inspectionCapabilityId}<button disabled={inspectionLoading} onclick={() => void inspect({ kind: 'definition', descriptor: definition })}>Inspect</button>{/if}</div></article>
            {/each}
          </div></section>
        {/each}
        {#if continuableResources.length > 0}
          <section class="catalog-section-home">
            <header><h2>Continue</h2><span>{continuableResources.length} resources</span></header>
            <div class="resource-columns">
              {#each coreModuleIds as moduleId}
                <div><h3>{moduleTitles[moduleId]}</h3>
                  {#each resourcesFor(moduleId) as resource (`${resource.ref.type}:${resource.ref.id}`)}
                    {@const deleteCapability = destructiveCapabilityFor(resource)}
                    <article class="resource-card">
                      <button class="resource-open" onclick={() => openResource(resource)}>
                        <strong>{resource.title}</strong>
                        {#if resource.description}<span class="resource-description">{resource.description}</span>{/if}
                        {#if resource.summary.length > 0}
                          <span class="resource-summary">
                            {#each resource.summary as item (item.key)}
                              <span class="resource-fact" title={item.kind === 'timestamp' ? item.value : undefined}>
                                <small>{item.label}</small><b>{summaryValue(item)}</b>
                              </span>
                            {/each}
                          </span>
                        {/if}
                      </button>
                      <span class="resource-tools">
                        {#if resource.inspectionCapabilityId}<button class="resource-inspect" type="button" aria-label={`Inspect ${resource.title}`} disabled={inspectionLoading} onclick={() => void inspect({ kind: 'resource', descriptor: resource })}>Inspect</button>{/if}
                        {#if deleteCapability}<button class="resource-delete" type="button" aria-label={`${deleteCapability.title}: ${resource.title}`} title={deleteCapability.title} disabled={busy} onclick={() => void invokeResource(resource, deleteCapability)}>×</button>{/if}
                      </span>
                    </article>
                  {/each}
                </div>
              {/each}
            </div>
          </section>
        {/if}
      </section>
    {/if}

    {#if error && showingComposer}<p class="workspace-error">{error}</p>{/if}
    <dialog class="settings-dialog" bind:this={settingsDialog}>
      <header><div><p class="eyebrow">{workspaceTitle}</p><h2>Workspace Settings</h2></div><button class="dialog-close" type="button" aria-label="Close settings" onclick={() => settingsDialog?.close()}>×</button></header>
      <section class="settings-section"><h3>Workspace</h3><label>Name <input bind:value={name} maxlength="256" placeholder="Unnamed Workspace" /></label><div class="settings-actions"><button disabled={busy} onclick={() => void saveName()}>Save name</button><a class="button" href={`/workspaces/${workspace.id}`}>Workspace home</a><a class="button" href="/workspaces">Manage Workspaces</a></div><code>{workspace.id}</code></section>
      <details class="settings-section catalog-section"><summary>Discovery catalog ({definitions.length} definitions, {resources.length} resources, {capabilities.length} capabilities)</summary><ul>{#each capabilities as capability}<li><code>{capability.id}</code> — {capability.title}</li>{/each}</ul></details>
      {#each workspace.modules as moduleState (moduleState.moduleId)}{#if moduleState.status === 'failed'}<section class="settings-section module-failure"><h3>{moduleTitles[moduleState.moduleId] ?? moduleState.moduleId} unavailable</h3><p>{moduleState.failure?.message}</p><button disabled={busy} onclick={() => void retryModule(moduleState.moduleId)}>Retry</button></section>{/if}{/each}
      <section class="settings-section danger-settings"><div><h3>Delete Workspace</h3><p>Deletes all World and Agents state.</p></div><button class="danger" disabled={busy} onclick={() => void deleteWorkspace()}>Delete Workspace</button></section>
    </dialog>
    <dialog class="inspection-dialog" bind:this={inspectionDialog}>
      <header>
        <div><p class="eyebrow">{inspectionSubject?.kind === 'definition' ? 'Reusable definition' : 'Live resource'}</p><h2>{inspectionView?.title ?? inspectionSubject?.descriptor.title ?? 'Inspect'}</h2>{#if inspectionView?.description}<p>{inspectionView.description}</p>{/if}</div>
        <button class="dialog-close" type="button" aria-label="Close inspection" onclick={() => inspectionDialog?.close()}>×</button>
      </header>
      <div class="inspection-toolbar"><span>{inspectionSubject?.descriptor.ref.moduleId} · {inspectionSubject?.descriptor.ref.type}</span><button disabled={inspectionLoading || inspectionView === null} onclick={() => void copyInspection()}>{inspectionCopied ? 'Copied' : 'Copy all JSON'}</button></div>
      {#if inspectionLoading}<section class="inspection-message">Loading configuration and live state…</section>
      {:else if inspectionError}<section class="inspection-message error">{inspectionError}</section>
      {:else if inspectionView && inspectionSubject}
        <section class="inspection-section">
          <details open><summary>Catalog metadata</summary><JsonTree value={inspectionSubject.descriptor} /></details>
        </section>
        {#each inspectionView.sections as section, index (section.id)}
          <section class="inspection-section">
            <details open={index < 2}><summary>{section.title}</summary>{#if section.description}<p>{section.description}</p>{/if}<JsonTree value={section.data} /></details>
          </section>
        {/each}
        <section class="inspection-section">
          <details><summary>Available capabilities ({inspectedCapabilities().length})</summary><JsonTree value={inspectedCapabilities()} /></details>
        </section>
      {/if}
    </dialog>
  {/if}
</main>

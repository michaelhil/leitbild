<script lang="ts">
  import { coreModuleIds, type Workspace } from '@leitbild/contracts'
  import WorkspaceComposer from './WorkspaceComposer.svelte'

  type Page = { readonly kind: 'list' } | { readonly kind: 'workspace'; readonly id: string }
  interface PresetDefinition { readonly id: string; readonly title: string; readonly description: string }
  interface CatalogItem { readonly id?: string; readonly title: string; readonly ref?: { readonly type: string; readonly id: string } }
  const moduleTitles: Readonly<Record<string, string>> = { world: 'World', agents: 'Agents' }

  const page = (): Page => {
    if (location.pathname === '/workspaces') return { kind: 'list' }
    const match = location.pathname.match(/^\/workspaces\/([^/]+)$/)
    if (!match) throw new Error('Unknown Workspace route')
    return { kind: 'workspace', id: decodeURIComponent(match[1] ?? '') }
  }

  const currentPage = page()
  let workspaces = $state<ReadonlyArray<Workspace>>([])
  let workspace = $state<Workspace | null>(null)
  let name = $state('')
  let createName = $state('')
  let loading = $state(true)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let settingsDialog = $state<HTMLDialogElement | null>(null)
  let presets = $state<ReadonlyArray<PresetDefinition>>([])
  let resources = $state<ReadonlyArray<CatalogItem>>([])
  let capabilities = $state<ReadonlyArray<CatalogItem>>([])
  const workspaceTitle = $derived(workspace?.name ?? workspace?.id ?? 'Workspace')

  const request = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(path, options)
    if (response.status === 204) return undefined as T
    const body = await response.json() as T & { error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message ?? `Request failed: ${response.status}`)
    return body
  }

  const load = async (): Promise<void> => {
    loading = true
    error = null
    try {
      if (currentPage.kind === 'list') {
        workspaces = (await request<{ workspaces: ReadonlyArray<Workspace> }>('/api/workspaces')).workspaces
      } else {
        const workspaceId = encodeURIComponent(currentPage.id)
        const [workspaceResponse, presetResponse, resourceResponse, capabilityResponse] = await Promise.all([
          request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`),
          request<{ presets: ReadonlyArray<PresetDefinition> }>('/api/presets'),
          request<{ resources: ReadonlyArray<CatalogItem> }>(`/api/workspaces/${workspaceId}/resources`),
          request<{ capabilities: ReadonlyArray<CatalogItem> }>(`/api/workspaces/${workspaceId}/capabilities`),
        ])
        workspace = workspaceResponse.workspace
        presets = presetResponse.presets
        resources = resourceResponse.resources
        capabilities = capabilityResponse.capabilities
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
    try {
      await action()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }

  const createWorkspace = (): Promise<void> => run(async () => {
    const response = await request<{ workspace: Workspace }>('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: createName.trim() || null }),
    })
    location.href = `/workspaces/${response.workspace.id}`
  })

  const saveName = (): Promise<void> => run(async () => {
    if (!workspace) return
    const response = await request<{ workspace: Workspace }>(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || null }),
    })
    workspace = response.workspace
    name = workspace.name ?? ''
  })

  const retryModule = (moduleId: string): Promise<void> => run(async () => {
    if (!workspace) return
    const response = await request<{ workspace: Workspace }>(
      `/api/workspaces/${workspace.id}/modules/${encodeURIComponent(moduleId)}/retry`,
      { method: 'POST' },
    )
    workspace = response.workspace
  })

  const deleteWorkspace = (): Promise<void> => run(async () => {
    if (!workspace || !confirm('Delete this Workspace and all of its World and Agents state?')) return
    await request(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })
    location.href = '/workspaces'
  })

  const applyPreset = (presetId: string): Promise<void> => run(async () => {
    if (!workspace) return
    const response = await request<{ application: { status: 'applied' | 'partial' | 'failed'; outcomes: ReadonlyArray<{ error?: string }> } }>(
      `/api/workspaces/${workspace.id}/presets/${encodeURIComponent(presetId)}/apply`,
      { method: 'POST' },
    )
    if (response.application.status !== 'applied') {
      throw new Error(response.application.outcomes.flatMap(outcome => outcome.error ? [outcome.error] : []).join('; ') || 'Preset application failed')
    }
    location.reload()
  })

  void load()
</script>

{#if currentPage.kind === 'workspace' && workspace}
  <header class="workspace-bar">
    <div class="workspace-identity">
      <a class="brand" href="/">Leitbild</a>
      <span aria-hidden="true">/</span>
      <span class="workspace-name" title={workspaceTitle}>{workspaceTitle}</span>
    </div>
    <button
      class="icon-button"
      type="button"
      aria-label="Workspace settings"
      title="Workspace settings"
      onclick={() => settingsDialog?.showModal()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.42 1.42-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V20h-2v-.09A1.7 1.7 0 0 0 12.38 18a1.7 1.7 0 0 0-1.88.34l-.06.06-1.42-1.42.06-.06A1.7 1.7 0 0 0 9.42 15a1.7 1.7 0 0 0-1.55-1.03H7v-2h.09A1.7 1.7 0 0 0 9 10.94a1.7 1.7 0 0 0-.34-1.88L8.6 9l1.42-1.42.06.06A1.7 1.7 0 0 0 12 8a1.7 1.7 0 0 0 1.03-1.55V6h2v.09A1.7 1.7 0 0 0 16.06 8a1.7 1.7 0 0 0 1.88-.34l.06-.06L19.42 9l-.06.06A1.7 1.7 0 0 0 19.7 11a1.7 1.7 0 0 0 1.55 1.03H22v2h-.09A1.7 1.7 0 0 0 20 15Z" />
      </svg>
    </button>
  </header>
{:else}
  <header class="topbar">
    <a class="brand" href="/">Leitbild</a>
    <a href="/workspaces">Workspaces</a>
  </header>
{/if}

<main class:workspace-main={currentPage.kind === 'workspace'}>
  {#if loading}
    <section class="notice">Loading Workspaces…</section>
  {:else if error && currentPage.kind === 'workspace' && !workspace}
    <section class="notice error">
      <h1>Workspace unavailable</h1>
      <p>{error}</p>
      <a href="/workspaces">Back to Workspaces</a>
    </section>
  {:else if currentPage.kind === 'list'}
    <section class="hero">
      <div><p class="eyebrow">Leitbild</p><h1>Workspaces</h1></div>
      <p>Each Workspace contains World and Agents.</p>
    </section>

    {#if error}<p class="notice error">{error}</p>{/if}

    <section class="panel create-panel">
      <div><h2>{workspaces.length === 0 ? 'Meet Leitbild' : 'New Workspace'}</h2><p>Names are optional; the UUID is the stable identity.</p></div>
      <label>Name <input bind:value={createName} maxlength="256" placeholder="Optional name" /></label>
      <button class="primary" disabled={busy} onclick={() => void createWorkspace()}>Create Workspace</button>
    </section>

    <section class="workspace-grid">
      {#each workspaces as item (item.id)}
        <article class="workspace-card">
          <div><h2>{item.name ?? item.id}</h2>{#if item.name}<code>{item.id}</code>{/if}</div>
          <div class="chips">{#each coreModuleIds as moduleId}<span>{moduleTitles[moduleId]}</span>{/each}</div>
          <div class="actions"><a class="button primary" href={`/workspaces/${item.id}`}>Open Workspace</a></div>
        </article>
      {/each}
    </section>
  {:else if workspace}
    <WorkspaceComposer workspaceId={workspace.id} />

    {#if error}<p class="workspace-error">{error}</p>{/if}

    <dialog class="settings-dialog" bind:this={settingsDialog}>
      <header>
        <div><p class="eyebrow">{workspaceTitle}</p><h2>Workspace Settings</h2></div>
        <button class="dialog-close" type="button" aria-label="Close settings" onclick={() => settingsDialog?.close()}>×</button>
      </header>

      <section class="settings-section">
        <h3>Applications</h3>
        <div class="settings-links">
          <a class="button primary" href={`/workspaces/${workspace.id}/world`}>Open World</a>
          <a class="button primary" href={`/workspaces/${workspace.id}/agents`}>Open Agents</a>
        </div>
      </section>

      <section class="settings-section">
        <h3>Presets</h3>
        <p>Apply independent World and Agents definitions together. The created runs and rooms remain ordinary resources.</p>
        {#each presets as preset (preset.id)}
          <div class="preset-row">
            <div><strong>{preset.title}</strong><small>{preset.description}</small></div>
            <button disabled={busy} onclick={() => void applyPreset(preset.id)}>Apply</button>
          </div>
        {/each}
      </section>

      <details class="settings-section catalog-section">
        <summary>System Catalog ({resources.length} resources, {capabilities.length} capabilities)</summary>
        <h3>Resources</h3>
        <ul>{#each resources as resource}<li><code>{resource.ref?.type}:{resource.ref?.id}</code> — {resource.title}</li>{/each}</ul>
        <h3>Capabilities</h3>
        <ul>{#each capabilities as capability}<li><code>{capability.id}</code> — {capability.title}</li>{/each}</ul>
      </details>

      <section class="settings-section">
        <h3>Workspace</h3>
        <label>Name <input bind:value={name} maxlength="256" placeholder="Unnamed Workspace" /></label>
        <div class="settings-actions">
          <button disabled={busy} onclick={() => void saveName()}>Save name</button>
          <a class="button" href="/workspaces">Manage Workspaces</a>
        </div>
        <code>{workspace.id}</code>
      </section>

      {#each workspace.modules as moduleState (moduleState.moduleId)}
        {#if moduleState.status === 'failed'}
          <section class="settings-section module-failure">
            <h3>{moduleTitles[moduleState.moduleId] ?? moduleState.moduleId} unavailable</h3>
            <p>{moduleState.failure?.message}</p>
            <button disabled={busy} onclick={() => void retryModule(moduleState.moduleId)}>Retry</button>
          </section>
        {/if}
      {/each}

      <section class="settings-section danger-settings">
        <div><h3>Delete Workspace</h3><p>Deletes all World and Agents state.</p></div>
        <button class="danger" disabled={busy} onclick={() => void deleteWorkspace()}>Delete Workspace</button>
      </section>
    </dialog>
  {/if}
</main>

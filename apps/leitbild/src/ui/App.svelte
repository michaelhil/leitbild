<script lang="ts">
  import { coreModuleIds, type Workspace } from '@leitbild/contracts'

  type Page = { readonly kind: 'list' } | { readonly kind: 'workspace'; readonly id: string }
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
        workspace = (await request<{ workspace: Workspace }>(`/api/workspaces/${encodeURIComponent(currentPage.id)}`)).workspace
        name = workspace.name ?? ''
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally { loading = false }
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    busy = true
    error = null
    try { await action() } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally { busy = false }
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
    await request(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || null }),
    })
    await load()
  })

  const retryModule = (moduleId: string): Promise<void> => run(async () => {
    if (!workspace) return
    await request(`/api/workspaces/${workspace.id}/modules/${encodeURIComponent(moduleId)}/retry`, { method: 'POST' })
    await load()
  })

  const deleteWorkspace = (): Promise<void> => run(async () => {
    if (!workspace || !confirm('Delete this Workspace and all of its World and Agents state?')) return
    await request(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })
    location.href = '/workspaces'
  })

  void load()
</script>

<header class="topbar">
  <a class="brand" href="/">Leitbild</a>
  <a href="/workspaces">Workspaces</a>
</header>

<main>
  {#if loading}
    <section class="notice">Loading Workspaces…</section>
  {:else if error && currentPage.kind === 'workspace' && !workspace}
    <section class="notice error"><h1>Workspace unavailable</h1><p>{error}</p><a href="/workspaces">Back to Workspaces</a></section>
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
    <section class="hero">
      <div><p class="eyebrow"><a href="/workspaces">Workspaces</a> /</p><h1>{workspace.name ?? workspace.id}</h1><code>{workspace.id}</code></div>
      <p>One shared context, three focused working areas.</p>
    </section>

    {#if error}<p class="notice error">{error}</p>{/if}

    <section class="module-grid">
      {#each coreModuleIds as moduleId}
        {@const state = workspace.modules.find(item => item.moduleId === moduleId)}
        <article class="module-card">
          <div><p class="eyebrow">{state?.status ?? 'unavailable'}</p><h2>{moduleTitles[moduleId]}</h2></div>
          {#if state?.status === 'ready'}
            <a class="button primary" href={`/workspaces/${workspace.id}/${moduleId}`}>Open {moduleTitles[moduleId]}</a>
          {:else if state?.failure}
            <p>{state.failure.message}</p><button disabled={busy} onclick={() => void retryModule(moduleId)}>Retry</button>
          {/if}
        </article>
      {/each}
    </section>

    <section class="panel name-panel">
      <div><h2>Name</h2><p>Optional display metadata; links continue to use the UUID.</p></div>
      <input bind:value={name} maxlength="256" placeholder="Unnamed Workspace" />
      <button disabled={busy} onclick={() => void saveName()}>Save</button>
    </section>

    <section class="danger-zone"><div><h2>Delete Workspace</h2><p>Deletes all module-owned state. Failed cleanup remains visible for retry.</p></div><button class="danger" disabled={busy} onclick={() => void deleteWorkspace()}>Delete Workspace</button></section>
  {/if}
</main>

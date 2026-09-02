<script lang="ts">
  import type { Workspace } from '@leitbild/contracts'
  import InlineName from './InlineName.svelte'
  import { request, jsonRequest } from './api.ts'

  let { workspaces }: { workspaces: ReadonlyArray<Workspace> } = $props()
  let createDialog = $state<HTMLDialogElement | null>(null)
  let name = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let createError = $state<string | null>(null)

  const create = async (): Promise<void> => {
    if (busy) return
    busy = true
    createError = null
    try {
      const result = await request<{ workspace: Workspace }>('/api/workspaces', jsonRequest('POST', { name: name.trim() || null }))
      location.href = `/workspaces/${result.workspace.id}`
    } catch (cause) { createError = cause instanceof Error ? cause.message : String(cause) }
    finally { busy = false }
  }
  const rename = async (item: Workspace, name: string): Promise<void> => {
    const result = await request<{ workspace: Workspace }>(`/api/workspaces/${item.id}`, jsonRequest('PATCH', { name: name || null }))
    workspaces = workspaces.map(entry => entry.id === item.id ? result.workspace : entry)
  }
  const remove = async (item: Workspace): Promise<void> => {
    if (busy || !confirm(`Delete workspace “${item.name ?? item.id}”? This permanently deletes all its World runs and Agents content.`)) return
    busy = true
    error = null
    try {
      await request(`/api/workspaces/${item.id}`, { method: 'DELETE' })
      workspaces = workspaces.filter(entry => entry.id !== item.id)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
      // Show the actual lifecycle after partial cleanup; do not hide the card.
      try { workspaces = (await request<{ workspaces: Workspace[] }>('/api/workspaces')).workspaces }
      catch (refreshError) { error += `; refresh failed: ${String(refreshError)}` }
    } finally { busy = false }
  }
</script>

<p class="picker-intro">Open an existing workspace or <button class="text-link" onclick={() => { name = ''; createError = null; createDialog?.showModal() }}>create a new one</button></p>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
<section class="workspace-grid" aria-label="Workspaces">
  {#each workspaces as item (item.id)}
    <article class="workspace-card clickable-card">
      <a class="card-hit-target" href={`/workspaces/${item.id}`} aria-label={`Open workspace ${item.name ?? item.id}`}></a>
      <h2><InlineName value={item.name ?? ''} fallback={item.id} label={`Rename workspace ${item.name ?? item.id}`} onsave={name => rename(item, name)} /></h2>
      {#if item.name}<code>{item.id}</code>{/if}
      {#each item.modules as module (module.moduleId)}
        {#if module.status !== 'ready'}<p class="inline-error">{module.moduleId}: {module.failure?.message ?? module.status}</p>{/if}
      {/each}
      <button class="card-delete card-control" type="button" aria-label={`Delete workspace ${item.name ?? item.id}`} title="Delete workspace" disabled={busy} onclick={() => void remove(item)}>×</button>
    </article>
  {/each}
</section>

<dialog class="create-dialog" bind:this={createDialog}>
  <header><h2>Create a workspace</h2><button class="dialog-close" aria-label="Close" onclick={() => createDialog?.close()}>×</button></header>
  <form onsubmit={event => { event.preventDefault(); void create() }}>
    <label>Name <input bind:value={name} maxlength="256" placeholder="Optional" /></label>
    {#if createError}<p class="inline-error" role="alert">{createError}</p>{/if}
    <button class="primary" disabled={busy}>{busy ? 'Creating…' : 'Create workspace'}</button>
  </form>
</dialog>

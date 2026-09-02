<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { Workspace } from '@leitbild/contracts'
  import InlineName from './InlineName.svelte'
  import { request, jsonRequest } from './api.ts'

  let { workspaces }: { workspaces: ReadonlyArray<Workspace> } = $props()
  let name = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let createError = $state<string | null>(null)
  let copiedId = $state<string | null>(null)
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
  onDestroy(() => clearTimeout(copyTimer))

  const copyLink = async (item: Workspace): Promise<void> => {
    error = null
    try {
      await navigator.clipboard.writeText(new URL(`/workspaces/${item.id}`, location.origin).href)
      copiedId = item.id
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => { copiedId = null }, 2_500)
    } catch (cause) { error = `Could not copy the workspace link: ${cause instanceof Error ? cause.message : String(cause)}` }
  }

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

<div class="picker-intro"><p>Open a workspace and start exploring.</p><span>{workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'}</span></div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
<section class="workspace-grid" aria-label="Workspaces">
  <article class="workspace-card workspace-create">
    <div class="workspace-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg></div>
    <div><h2>A new workspace</h2><p class="workspace-card-hint">A fresh space for your simulations and agents.</p></div>
    <form onsubmit={event => { event.preventDefault(); void create() }}>
      <label class="visually-hidden" for="new-workspace-name">Workspace name (optional)</label>
      <input id="new-workspace-name" bind:value={name} maxlength="256" placeholder="Name (optional)" disabled={busy} />
      {#if createError}<p class="inline-error" role="alert">{createError}</p>{/if}
      <button class="primary" disabled={busy}>{busy ? 'Please wait…' : 'Create Workspace'}<span aria-hidden="true">↗</span></button>
    </form>
  </article>
  {#each workspaces as item (item.id)}
    <article class="workspace-card clickable-card" class:unnamed={item.name === null}>
      <a class="card-hit-target" href={`/workspaces/${item.id}`} aria-label={`Open workspace ${item.name ?? item.id}`}></a>
      <div class="workspace-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" /></svg></div>
      <div class="workspace-card-heading"><h2><InlineName value={item.name ?? ''} fallback={item.id} label={`Rename workspace ${item.name ?? item.id}`} onsave={name => rename(item, name)} /></h2>
        {#if item.name}<code>{item.id}</code>{/if}
      </div>
      {#each item.modules as module (module.moduleId)}
        {#if module.status !== 'ready'}<p class="inline-error">{module.moduleId}: {module.failure?.message ?? module.status}</p>{/if}
      {/each}
      <button class="card-delete card-control" type="button" aria-label={`Delete workspace ${item.name ?? item.id}`} title="Delete workspace" disabled={busy} onclick={() => void remove(item)}>×</button>
      <footer class="workspace-card-footer">
        <time datetime={item.createdAt}>Created {dateFormat.format(new Date(item.createdAt))}</time>
        <span class="workspace-copy-feedback" role="status">{copiedId === item.id ? 'Link copied' : ''}</span>
        <button class="workspace-copy card-control" type="button" aria-label={`Copy link to workspace ${item.name ?? item.id}`} title="Copy workspace link" onclick={() => void copyLink(item)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            {#if copiedId === item.id}<path d="m5 12 4 4L19 6" />{:else}<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 17a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" transform="translate(0 -1) scale(.95)" />{/if}
          </svg>
        </button>
      </footer>
    </article>
  {/each}
</section>

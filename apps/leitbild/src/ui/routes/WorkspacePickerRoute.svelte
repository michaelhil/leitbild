<script lang="ts">
  import { Plus } from 'lucide-svelte'
  import { createWorkspace, listWorkspaces, type WorkspaceListItem } from '../workspace-client.ts'
  import { pathForWorkspace } from '../simulation-run-route.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'

  let workspaces = $state<ReadonlyArray<WorkspaceListItem>>([])
  let defaultWorkspaceId = $state<string | null>(null)
  let displayName = $state('')
  let status = $state('Loading Workspaces')
  let creating = $state(false)

  const load = async (): Promise<void> => {
    try {
      const response = await listWorkspaces()
      workspaces = response.workspaces
      defaultWorkspaceId = response.defaultWorkspaceId
      status = 'Ready'
    } catch (err) {
      status = err instanceof Error ? err.message : 'Unable to load Workspaces'
    }
  }

  const create = async (): Promise<void> => {
    const name = displayName.trim()
    if (!name || creating) return
    creating = true
    status = 'Creating Workspace'
    try {
      const workspace = await createWorkspace(name)
      location.href = pathForWorkspace(workspace.id)
    } catch (err) {
      status = err instanceof Error ? err.message : 'Unable to create Workspace'
      creating = false
    }
  }

  runOnMount(() => {
    void load()
  })
</script>

<main class="workspace-page">
  <section class="workspace-panel">
    <header>
      <div>
        <h1>Leitbild Workspaces</h1>
        <p>Each Workspace owns an independent Scenario library and set of Simulation Runs.</p>
      </div>
      <span class="workspace-status">{status}</span>
    </header>

    <form class="workspace-create" onsubmit={(event) => { event.preventDefault(); void create() }}>
      <input bind:value={displayName} maxlength="256" placeholder="Workspace name" aria-label="Workspace name" />
      <button type="submit" disabled={creating || displayName.trim().length === 0}>
        <Plus size={16} aria-hidden="true" />
        New Workspace
      </button>
    </form>

    <div class="workspace-list">
      {#each workspaces as workspace (workspace.id)}
        <a class="workspace-row" href={pathForWorkspace(workspace.id)}>
          <span>
            <strong>{workspace.displayName}</strong>
            <small>{workspace.id}</small>
          </span>
          <span>{workspace.id === defaultWorkspaceId ? 'Default' : workspace.loaded ? 'Loaded' : 'Open'}</span>
        </a>
      {/each}
    </div>
  </section>
</main>

<style>
  .workspace-page { min-height: 100vh; padding: 4rem 1.25rem; background: var(--color-surface, #10151d); color: var(--color-text, #eef2f6); }
  .workspace-panel { max-width: 880px; margin: 0 auto; display: grid; gap: 1.5rem; }
  header { display: flex; justify-content: space-between; gap: 1rem; align-items: end; }
  h1 { margin: 0; font-size: clamp(2rem, 5vw, 3.5rem); }
  p, small { color: var(--color-text-muted, #94a3b8); }
  .workspace-status { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; }
  .workspace-create { display: flex; gap: .75rem; }
  input { flex: 1; min-width: 0; padding: .85rem 1rem; border: 1px solid #334155; border-radius: .6rem; background: #111827; color: inherit; }
  button { display: inline-flex; gap: .45rem; align-items: center; padding: .8rem 1rem; border: 0; border-radius: .6rem; background: #d6ff52; color: #111827; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .workspace-list { display: grid; gap: .6rem; }
  .workspace-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1rem 1.1rem; border: 1px solid #273449; border-radius: .7rem; color: inherit; text-decoration: none; background: #151d29; }
  .workspace-row:hover { border-color: #d6ff52; }
  .workspace-row span:first-child { display: grid; gap: .25rem; }
  @media (max-width: 600px) { header, .workspace-create { align-items: stretch; flex-direction: column; } }
</style>

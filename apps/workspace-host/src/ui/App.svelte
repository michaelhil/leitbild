<script lang="ts">
  import type {
    ExperienceDescriptor,
    Workspace,
    WorkspaceExperience,
  } from '@samsinn-leitbild/platform-contracts'

  type Page = { readonly kind: 'list' } | { readonly kind: 'workspace'; readonly id: string }

  const page = (): Page => {
    if (location.pathname === '/workspaces') return { kind: 'list' }
    const match = location.pathname.match(/^\/workspaces\/([^/]+)$/)
    if (!match) throw new Error('Unknown Workspace route')
    return { kind: 'workspace', id: decodeURIComponent(match[1] ?? '') }
  }

  const currentPage = page()
  let workspaces = $state<ReadonlyArray<Workspace>>([])
  let installedExperiences = $state<ReadonlyArray<ExperienceDescriptor>>([])
  let workspace = $state<Workspace | null>(null)
  let experiences = $state<ReadonlyArray<WorkspaceExperience>>([])
  let name = $state('')
  let createName = $state('')
  let selectedExperienceIds = $state<string[]>([])
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
      const installed = await request<{ experiences: ReadonlyArray<ExperienceDescriptor> }>('/api/experiences')
      installedExperiences = installed.experiences
      if (currentPage.kind === 'list') {
        workspaces = (await request<{ workspaces: ReadonlyArray<Workspace> }>('/api/workspaces')).workspaces
      } else {
        const [workspaceResponse, experienceResponse] = await Promise.all([
          request<{ workspace: Workspace }>(`/api/workspaces/${encodeURIComponent(currentPage.id)}`),
          request<{ experiences: ReadonlyArray<WorkspaceExperience> }>(`/api/workspaces/${encodeURIComponent(currentPage.id)}/experiences`),
        ])
        workspace = workspaceResponse.workspace
        experiences = experienceResponse.experiences
        name = workspaceResponse.workspace.name ?? ''
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

  const readyExperiences = (item: Workspace): ReadonlyArray<ExperienceDescriptor> =>
    installedExperiences.filter(experience => experience.requiredModules.every(moduleId =>
      item.modules.some(module => module.moduleId === moduleId && module.status === 'ready')))

  const toggleCreateExperience = (id: string): void => {
    selectedExperienceIds = selectedExperienceIds.includes(id)
      ? selectedExperienceIds.filter(candidate => candidate !== id)
      : [...selectedExperienceIds, id]
  }

  const createWorkspace = (): Promise<void> => run(async () => {
    const response = await request<{ workspace: Workspace }>('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: createName.trim() || null, experienceIds: selectedExperienceIds }),
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

  const changeExperience = (experienceId: string, method: 'PUT' | 'DELETE'): Promise<void> => run(async () => {
    if (!workspace) return
    if (method === 'DELETE' && !confirm('Remove this Experience and its unshared Module state?')) return
    await request(`/api/workspaces/${workspace.id}/experiences/${encodeURIComponent(experienceId)}`, { method })
    await load()
  })

  const retryModule = (moduleId: string): Promise<void> => run(async () => {
    if (!workspace) return
    await request(`/api/workspaces/${workspace.id}/modules/${encodeURIComponent(moduleId)}/retry`, { method: 'POST' })
    await load()
  })

  const deleteWorkspace = (): Promise<void> => run(async () => {
    if (!workspace || !confirm('Delete this Workspace and all Module-owned state?')) return
    await request(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })
    location.href = '/workspaces'
  })

  void load()
</script>

<header class="topbar">
  <a class="brand" href="/workspaces">Workspace Platform</a>
  <span>Composable tools, one Workspace identity</span>
</header>

<main>
  {#if loading}
    <section class="notice">Loading Workspaces…</section>
  {:else if error && currentPage.kind === 'workspace' && !workspace}
    <section class="notice error"><h1>Workspace unavailable</h1><p>{error}</p><a href="/workspaces">Back to Workspaces</a></section>
  {:else if currentPage.kind === 'list'}
    <section class="hero">
      <div><p class="eyebrow">Platform</p><h1>Workspaces</h1></div>
      <p>Create one durable container, then add the Experiences you need.</p>
    </section>

    {#if error}<p class="notice error">{error}</p>{/if}

    <section class="panel create-panel">
      <div><h2>New Workspace</h2><p>Names are optional; the UUID remains its identity.</p></div>
      <label>Name <input bind:value={createName} maxlength="256" placeholder="Optional name" /></label>
      <fieldset>
        <legend>Start with</legend>
        {#each installedExperiences as experience (experience.id)}
          <label class="choice"><input type="checkbox" checked={selectedExperienceIds.includes(experience.id)} onchange={() => toggleCreateExperience(experience.id)} /> <span><strong>{experience.title}</strong>{#if experience.description}<small>{experience.description}</small>{/if}</span></label>
        {/each}
      </fieldset>
      <button class="primary" disabled={busy} onclick={() => void createWorkspace()}>Create Workspace</button>
    </section>

    <section class="workspace-grid">
      {#each workspaces as item (item.id)}
        <article class="workspace-card">
          <div><h2>{item.name ?? item.id}</h2>{#if item.name}<code>{item.id}</code>{/if}</div>
          <div class="chips">{#each item.modules as module}<span class:failed={module.status.endsWith('failed')}>{module.moduleId}</span>{/each}</div>
          <div class="actions">
            <a class="button" href={`/workspaces/${item.id}`}>Manage</a>
            {#each readyExperiences(item) as experience (experience.id)}
              <a class="button primary" href={`/workspaces/${item.id}/experiences/${experience.id}`}>Open {experience.title}</a>
            {/each}
          </div>
        </article>
      {:else}
        <p class="notice">No Workspaces yet.</p>
      {/each}
    </section>
  {:else if workspace}
    <section class="hero">
      <div><p class="eyebrow"><a href="/workspaces">Workspaces</a> /</p><h1>{workspace.name ?? workspace.id}</h1><code>{workspace.id}</code></div>
      <p>Experiences compose Modules without merging their domain state.</p>
    </section>

    {#if error}<p class="notice error">{error}</p>{/if}

    <section class="panel name-panel">
      <div><h2>Name</h2><p>Optional display metadata; URLs continue to use the UUID.</p></div>
      <input bind:value={name} maxlength="256" placeholder="Unnamed Workspace" />
      <button disabled={busy} onclick={() => void saveName()}>Save</button>
    </section>

    <section>
      <div class="section-heading"><h2>Experiences</h2><p>Add or remove complete user-facing toolsets.</p></div>
      <div class="experience-grid">
        {#each experiences as experience (experience.id)}
          <article class="experience-card">
            <div><p class="eyebrow">{experience.status}</p><h3>{experience.title}</h3><p>{experience.description ?? 'Specialized Workspace surface'}</p></div>
            <div class="chips">{#each experience.requiredModules as module}<span>{module}</span>{/each}</div>
            <div class="actions">
              {#if experience.status === 'ready'}
                <a class="button primary" href={`/workspaces/${workspace.id}/experiences/${experience.id}`}>Open</a>
                <button class="danger" disabled={busy} onclick={() => void changeExperience(experience.id, 'DELETE')}>Remove</button>
              {:else if experience.status === 'absent'}
                <button class="primary" disabled={busy} onclick={() => void changeExperience(experience.id, 'PUT')}>Add</button>
              {:else}
                <button disabled={busy} onclick={() => void changeExperience(experience.id, 'PUT')}>Complete setup</button>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <details class="panel technical">
      <summary>Technical Modules</summary>
      {#each workspace.modules as module (module.moduleId)}
        <div class="module-row"><span><strong>{module.moduleId}</strong> · {module.status}{#if module.failure}<small>{module.failure.message}</small>{/if}</span>{#if module.failure}<button disabled={busy} onclick={() => void retryModule(module.moduleId)}>Retry</button>{/if}</div>
      {/each}
    </details>

    <section class="danger-zone"><div><h2>Delete Workspace</h2><p>Deletes every Module-owned shard. Failed cleanup stays visible for retry.</p></div><button class="danger" disabled={busy} onclick={() => void deleteWorkspace()}>Delete Workspace</button></section>
  {/if}
</main>

<script lang="ts">
  import type { Workspace } from '@leitbild/contracts'
  import AssistantLauncher from './AssistantLauncher.svelte'
  import { request, jsonRequest } from './api.ts'
  import { wikiAssistantPrompt, type WikiAssistantPage } from './wiki-assistant.ts'

  let { page }: { page: WikiAssistantPage | null } = $props()
  let workspaces = $state<Workspace[]>([])
  let workspaceId = $state('')
  let loaded = $state(false)

  const prepare = async (): Promise<void> => {
    loaded = false
    const result = await request<{ workspaces: Workspace[] }>('/api/workspaces')
    workspaces = result.workspaces
    if (!workspaces.some(item => item.id === workspaceId)) {
      workspaceId = workspaces.length === 1 ? workspaces[0]!.id : ''
    }
    loaded = true
  }

  const ask = async (prompt: string): Promise<void> => {
    if (!loaded || !workspaces.some(item => item.id === workspaceId)) throw new Error('Choose a workspace for this conversation.')
    const response = await request<{ result: { uiPath: string } }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/agents.assistance.open/invoke`,
      jsonRequest('POST', { input: { prompt: wikiAssistantPrompt(prompt, page) }, actor: { kind: 'human' } }),
    )
    location.assign(response.result.uiPath)
  }
</script>

<AssistantLauncher onOpen={prepare} submit={loaded && workspaceId ? ask : undefined}>
  {#snippet details()}
    {#if loaded && workspaces.length === 0}
      <p>Create a <a href="/workspaces">workspace</a> to keep your Assistant conversation.</p>
    {:else if loaded}
      <label>Conversation workspace
        <select bind:value={workspaceId} aria-label="Conversation workspace">
          <option value="" disabled>Choose a workspace…</option>
          {#each workspaces as item (item.id)}<option value={item.id}>{item.name ?? item.id}</option>{/each}
        </select>
      </label>
    {/if}
    {#if page}
      <p class="page-reference">Includes a reference to <strong>{page.title}</strong>, at revision <code title={page.revision}>{page.revision.slice(0, 12)}</code>. The Assistant can read this page and follow links as needed. Your conversation opens in Agents.</p>
    {/if}
  {/snippet}
</AssistantLauncher>

<style>
  select { width: 100%; padding: .6rem; border: 1px solid #bfc9bd; border-radius: 8px; color: #172019; background: white; font: inherit; }
  .page-reference { margin: 0; color: #5e695f; font-size: .8rem; line-height: 1.45; }
</style>

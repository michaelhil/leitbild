<script lang="ts">
  import { Copy, X } from 'lucide-svelte'
  import type { ControlInstanceId } from '../../core/model/index.ts'
  import {
    readProcessPlantArtifact,
    type ProcessPlantArtifact,
    type ProcessPlantArtifactKind,
  } from './process-surface-client.ts'

  interface Props {
    readonly controlInstanceId: ControlInstanceId
    readonly systemId: string
    readonly artifact: ProcessPlantArtifactKind
    readonly close: () => void
  }

  let { controlInstanceId, systemId, artifact, close }: Props = $props()

  let loading = $state(true)
  let error = $state<string | null>(null)
  let data = $state<ProcessPlantArtifact | null>(null)
  let copyStatus = $state<string | null>(null)

  const copyContent = async (): Promise<void> => {
    const content = data?.content
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      copyStatus = 'Copied'
    } catch (err) {
      copyStatus = err instanceof Error ? err.message : String(err)
    }
  }

  $effect(() => {
    const selectedControlInstanceId = controlInstanceId
    const selectedSystemId = systemId
    const selectedArtifact = artifact
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        loading = true
        error = null
        data = null
        copyStatus = null
        const next = await readProcessPlantArtifact(selectedControlInstanceId, selectedSystemId, selectedArtifact)
        if (!cancelled) data = next
      } catch (err) {
        if (!cancelled) error = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) loading = false
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  })
</script>

<div class="process-artifact-backdrop" role="presentation">
  <section class="process-artifact-modal" aria-label="Process plant artifact">
    <header class="process-artifact-header">
      <div>
        <strong>{data?.title ?? (artifact === 'authored-spec' ? 'Plant specification source' : 'Full component graph')}</strong>
        {#if data}
          <span>{data.metadata.componentCount} components · {data.metadata.linkCount} links · {data.metadata.variableCount} variables</span>
        {/if}
      </div>
      <div class="process-artifact-actions">
        <button type="button" aria-label="Copy artifact text" onclick={copyContent} disabled={!data}>
          <Copy size={16} aria-hidden="true" />
        </button>
        <button type="button" aria-label="Close artifact" onclick={close}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>
    </header>
    {#if copyStatus}
      <div class="process-artifact-copy-status">{copyStatus}</div>
    {/if}
    <div class="process-artifact-body">
      {#if loading}
        <div class="process-surface-message">Loading plant artifact...</div>
      {:else if error}
        <div class="process-surface-error">{error}</div>
      {:else if data}
        <pre><code>{data.content}</code></pre>
      {:else}
        <div class="process-surface-error">Plant artifact did not load.</div>
      {/if}
    </div>
  </section>
</div>

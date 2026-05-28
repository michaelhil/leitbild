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
  let renderedSvg = $state<string | null>(null)
  let renderError = $state<string | null>(null)

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
        renderedSvg = null
        renderError = null
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

  $effect(() => {
    const artifactData = data
    let cancelled = false
    renderedSvg = null
    renderError = null

    if (!artifactData || artifactData.language !== 'mermaid') {
      return () => {
        cancelled = true
      }
    }

    const render = async (): Promise<void> => {
      try {
        const mermaid = await import('mermaid')
        mermaid.default.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
            primaryColor: '#f8fafc',
            primaryTextColor: '#101828',
            primaryBorderColor: '#667085',
            lineColor: '#667085',
            secondaryColor: '#eef4ff',
            tertiaryColor: '#ffffff',
          },
        })
        const renderId = `process-plant-graph-${artifactData.systemId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}`
        const result = await mermaid.default.render(renderId, artifactData.content)
        if (!cancelled) renderedSvg = result.svg
      } catch (err) {
        if (!cancelled) renderError = err instanceof Error ? err.message : String(err)
      }
    }

    void render()

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
        {#if data.language === 'mermaid'}
          {#if renderedSvg}
            <div class="process-artifact-diagram">
              {@html renderedSvg}
            </div>
          {:else if renderError}
            <div class="process-artifact-render-error">
              Mermaid render failed: {renderError}
            </div>
            <pre><code>{data.content}</code></pre>
          {:else}
            <div class="process-surface-message">Rendering Mermaid graph...</div>
          {/if}
        {:else}
          <pre><code>{data.content}</code></pre>
        {/if}
      {:else}
        <div class="process-surface-error">Plant artifact did not load.</div>
      {/if}
    </div>
  </section>
</div>

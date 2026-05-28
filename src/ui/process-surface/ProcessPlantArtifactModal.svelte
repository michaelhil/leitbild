<script lang="ts">
  import { Copy, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-svelte'
  import { tick } from 'svelte'
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
  let graphViewport = $state<HTMLDivElement | null>(null)
  let graphSize = $state<{ readonly width: number; readonly height: number } | null>(null)
  let graphScale = $state(1)
  let graphOffset = $state({ x: 0, y: 0 })
  let graphPan = $state<{
    readonly pointerId: number
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: { readonly x: number; readonly y: number }
  } | null>(null)

  const lineCountFor = (content: string): number => {
    const trimmed = content.trimEnd()
    return trimmed.length === 0 ? 0 : trimmed.split(/\r\n|\r|\n/).length
  }

  const contentLineCount = $derived(data ? lineCountFor(data.content) : null)

  const mermaidSvgSize = (svg: string): { readonly width: number; readonly height: number } | null => {
    const viewBox = /\sviewBox="([^"]+)"/.exec(svg)?.[1]?.trim()
    if (!viewBox) return null
    const [, , width, height] = viewBox.split(/\s+/).map(Number)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
    return { width, height }
  }

  const normalizeMermaidSvg = (
    svg: string,
  ): { readonly svg: string; readonly size: { readonly width: number; readonly height: number } | null } => {
    const size = mermaidSvgSize(svg)
    if (!size) return { svg, size: null }
    const cleaned = svg
      .replace(/\swidth="[^"]*"/, '')
      .replace(/\sheight="[^"]*"/, '')
      .replace(/\sstyle="[^"]*"/, '')
    return {
      svg: cleaned.replace('<svg ', `<svg width="${size.width}" height="${size.height}" `),
      size,
    }
  }

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

  const fitGraphView = (): void => {
    const viewport = graphViewport
    const size = graphSize
    if (!viewport || !size) {
      graphScale = 1
      graphOffset = { x: 0, y: 0 }
      graphPan = null
      return
    }
    const padding = 36
    const availableWidth = Math.max(1, viewport.clientWidth - padding * 2)
    const availableHeight = Math.max(1, viewport.clientHeight - padding * 2)
    const nextScale = Math.max(0.04, Math.min(1, Math.min(availableWidth / size.width, availableHeight / size.height)))
    graphScale = nextScale
    graphOffset = {
      x: Math.max(18, (viewport.clientWidth - size.width * nextScale) / 2),
      y: Math.max(18, (viewport.clientHeight - size.height * nextScale) / 2),
    }
    graphPan = null
  }

  const clearGraphView = (): void => {
    graphScale = 1
    graphOffset = { x: 0, y: 0 }
    graphPan = null
  }

  const resetGraphView = (): void => {
    if (graphViewport && graphSize) {
      fitGraphView()
      return
    }
    clearGraphView()
  }

  const zoomGraph = (factor: number): void => {
    const viewport = graphViewport
    const previousScale = graphScale
    const nextScale = Math.max(0.04, Math.min(3, previousScale * factor))
    if (!viewport || nextScale === previousScale) {
      graphScale = nextScale
      return
    }
    const center = {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    }
    graphScale = nextScale
    graphOffset = {
      x: center.x - ((center.x - graphOffset.x) / previousScale) * nextScale,
      y: center.y - ((center.y - graphOffset.y) / previousScale) * nextScale,
    }
  }

  const startGraphPan = (event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const element = event.currentTarget as Element
    element.setPointerCapture(event.pointerId)
    graphPan = {
      pointerId: event.pointerId,
      pointerStart: { x: event.clientX, y: event.clientY },
      origin: graphOffset,
    }
  }

  const updateGraphPan = (event: PointerEvent): void => {
    const pan = graphPan
    if (!pan || pan.pointerId !== event.pointerId) return
    graphOffset = {
      x: pan.origin.x + event.clientX - pan.pointerStart.x,
      y: pan.origin.y + event.clientY - pan.pointerStart.y,
    }
  }

  const finishGraphPan = (event: PointerEvent): void => {
    if (graphPan?.pointerId !== event.pointerId) return
    updateGraphPan(event)
    graphPan = null
  }

  const wheelZoomGraph = (event: WheelEvent): void => {
    event.preventDefault()
    const viewport = graphViewport
    const previousScale = graphScale
    const nextScale = Math.max(0.04, Math.min(3, previousScale * (event.deltaY < 0 ? 1.1 : 1 / 1.1)))
    if (!viewport || nextScale === previousScale) {
      graphScale = nextScale
      return
    }
    const viewportRect = viewport.getBoundingClientRect()
    const focus = {
      x: event.clientX - viewportRect.left,
      y: event.clientY - viewportRect.top,
    }
    graphScale = nextScale
    graphOffset = {
      x: focus.x - ((focus.x - graphOffset.x) / previousScale) * nextScale,
      y: focus.y - ((focus.y - graphOffset.y) / previousScale) * nextScale,
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
        graphSize = null
        clearGraphView()
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
    graphSize = null
    clearGraphView()

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
        const normalized = normalizeMermaidSvg(result.svg)
        if (!cancelled) {
          graphSize = normalized.size
          renderedSvg = normalized.svg
          await tick()
          fitGraphView()
        }
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
          <span>{data.metadata.componentCount} components · {data.metadata.linkCount} links · {data.metadata.variableCount} variables{#if contentLineCount !== null} · {contentLineCount} LOC{/if}</span>
        {/if}
      </div>
      <div class="process-artifact-actions">
        {#if data?.language === 'mermaid' && renderedSvg}
          <button type="button" aria-label="Zoom out graph" onclick={() => zoomGraph(1 / 1.2)}>
            <ZoomOut size={16} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Reset graph view" onclick={resetGraphView}>
            <RotateCcw size={15} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Zoom in graph" onclick={() => zoomGraph(1.2)}>
            <ZoomIn size={16} aria-hidden="true" />
          </button>
        {/if}
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
            <div
              bind:this={graphViewport}
              class="process-artifact-diagram"
              class:panning={graphPan !== null}
              role="application"
              aria-label="Pan and zoom full component graph"
              onwheel={wheelZoomGraph}
              onpointerdown={startGraphPan}
              onpointermove={updateGraphPan}
              onpointerup={finishGraphPan}
              onpointercancel={finishGraphPan}
            >
              <div
                class="process-artifact-diagram-inner"
                style="transform: translate({graphOffset.x}px, {graphOffset.y}px) scale({graphScale});"
              >
                {@html renderedSvg}
              </div>
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

<script lang="ts">
  import type { OperationalObject } from '../../core/model/index.ts'
  import { parseElectricGridObjectData } from '../../packs/electric-grid/model.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'

  interface Props {
    readonly objects: ReadonlyArray<OperationalObject>
  }

  const { objects }: Props = $props()

  interface PanelFrame {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  }

  interface PanelGesture {
    readonly mode: 'move' | 'resize'
    readonly pointerId: number
    readonly startX: number
    readonly startY: number
    readonly startFrame: PanelFrame
  }

  const storageKey = 'leitbild:grid-overview-panel-frame:v1'
  const marginPx = 12
  const minWidthPx = 360
  const minHeightPx = 260

  let panelElement = $state<HTMLElement | null>(null)
  let frame = $state<PanelFrame | null>(null)
  let gesture = $state<PanelGesture | null>(null)

  const gridItems = $derived(objects.flatMap(object => {
    const data = parseElectricGridObjectData(object)
    return data ? [{ object, data }] : []
  }))
  const system = $derived(gridItems.find(item => item.data.type === 'grid_system')?.data)
  const branches = $derived(gridItems
    .filter(item => item.data.type === 'grid_branch')
    .map(item => ({ object: item.object, data: item.data }))
    .sort((left, right) => right.data.loadingPercent - left.data.loadingPercent)
    .slice(0, 4))
  const generators = $derived(gridItems
    .filter(item => item.data.type === 'grid_generator')
    .map(item => ({ object: item.object, data: item.data }))
    .sort((left, right) => right.data.dispatchMw - left.data.dispatchMw))
  const loads = $derived(gridItems
    .filter(item => item.data.type === 'grid_load')
    .map(item => ({ object: item.object, data: item.data }))
    .sort((left, right) => right.data.shedMw - left.data.shedMw)
    .slice(0, 4))

  const frequencyClass = $derived(!system
    ? 'idle'
    : system.frequencyHz < 49.85 || system.frequencyHz > 50.15
      ? 'alert'
      : system.frequencyHz < 49.95 || system.frequencyHz > 50.05
        ? 'watch'
        : 'normal')

  const mw = (value: number): string =>
    value.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })

  const parentSize = (): { readonly width: number; readonly height: number } => {
    const rect = panelElement?.parentElement?.getBoundingClientRect()
    return {
      width: rect?.width ?? window.innerWidth,
      height: rect?.height ?? window.innerHeight,
    }
  }

  const clampFrame = (candidate: PanelFrame): PanelFrame => {
    const size = parentSize()
    const maxWidth = Math.max(minWidthPx, size.width - marginPx * 2)
    const maxHeight = Math.max(minHeightPx, size.height - marginPx * 2)
    const width = Math.min(maxWidth, Math.max(minWidthPx, candidate.width))
    const height = Math.min(maxHeight, Math.max(minHeightPx, candidate.height))
    return {
      left: Math.min(Math.max(marginPx, candidate.left), Math.max(marginPx, size.width - width - marginPx)),
      top: Math.min(Math.max(marginPx, candidate.top), Math.max(marginPx, size.height - height - marginPx)),
      width,
      height,
    }
  }

  const defaultFrame = (): PanelFrame => {
    const size = parentSize()
    const width = Math.min(500, Math.max(minWidthPx, size.width * 0.34))
    const height = Math.min(760, Math.max(420, size.height - 36))
    return clampFrame({
      left: Math.max(marginPx, size.width - width - 18),
      top: 18,
      width,
      height,
    })
  }

  const storedFrame = (): PanelFrame | null => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<PanelFrame>
      if (
        typeof parsed.left !== 'number'
        || typeof parsed.top !== 'number'
        || typeof parsed.width !== 'number'
        || typeof parsed.height !== 'number'
      ) return null
      return clampFrame(parsed as PanelFrame)
    } catch {
      // Local storage is optional UI state; stale/corrupt frames are discarded.
      return null
    }
  }

  const persistFrame = (next: PanelFrame): void => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // Local storage is optional UI state; losing it must not affect operation.
    }
  }

  const applyFrame = (next: PanelFrame): void => {
    const clamped = clampFrame(next)
    frame = clamped
    persistFrame(clamped)
  }

  const ensureFrame = (): void => {
    frame = storedFrame() ?? defaultFrame()
  }

  const startGesture = (event: PointerEvent, mode: PanelGesture['mode']): void => {
    if (!frame || !panelElement) return
    event.preventDefault()
    panelElement.setPointerCapture(event.pointerId)
    gesture = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startFrame: frame,
    }
  }

  const moveGesture = (event: PointerEvent): void => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (gesture.mode === 'move') {
      applyFrame({
        ...gesture.startFrame,
        left: gesture.startFrame.left + dx,
        top: gesture.startFrame.top + dy,
      })
      return
    }
    applyFrame({
      ...gesture.startFrame,
      width: gesture.startFrame.width + dx,
      height: gesture.startFrame.height + dy,
    })
  }

  const stopGesture = (event: PointerEvent): void => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    panelElement?.releasePointerCapture(event.pointerId)
    gesture = null
  }

  const moveFrameByKeyboard = (event: KeyboardEvent): void => {
    if (!frame) return
    const step = event.shiftKey ? 40 : 12
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      applyFrame({ ...frame, left: frame.left - step })
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      applyFrame({ ...frame, left: frame.left + step })
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      applyFrame({ ...frame, top: frame.top - step })
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      applyFrame({ ...frame, top: frame.top + step })
    }
  }

  const panelStyle = $derived(frame
    ? `left: ${frame.left}px; top: ${frame.top}px; width: ${frame.width}px; height: ${frame.height}px;`
    : '')

  runOnMount(() => {
    ensureFrame()
    const parent = panelElement?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(() => {
      frame = clampFrame(frame ?? defaultFrame())
    })
    observer.observe(parent)
    return () => observer.disconnect()
  })
</script>

{#if system}
  <section
    bind:this={panelElement}
    class="grid-overview"
    aria-label="Electric grid overview"
    style={panelStyle}
    onpointermove={moveGesture}
    onpointerup={stopGesture}
    onpointercancel={stopGesture}
  >
    <header
      class="overview-titlebar"
      role="button"
      tabindex="0"
      aria-label="Move grid overview panel"
      onpointerdown={(event) => startGesture(event, 'move')}
      onkeydown={moveFrameByKeyboard}
    >
      <div>
        <p class="eyebrow">Electric grid</p>
        <h2>Norway operating overview</h2>
      </div>
      <div class="frequency" class:alert={frequencyClass === 'alert'} class:watch={frequencyClass === 'watch'}>
        <span>{system.frequencyHz.toFixed(3)}</span>
        <small>Hz</small>
      </div>
    </header>

    <div class="metric-grid">
      <div class="metric">
        <span>Generation</span>
        <strong>{mw(system.totalGenerationMw)} MW</strong>
      </div>
      <div class="metric">
        <span>Served load</span>
        <strong>{mw(system.servedLoadMw)} MW</strong>
      </div>
      <div class="metric">
        <span>Reserve</span>
        <strong>{mw(system.reserveMarginMw)} MW</strong>
      </div>
      <div class="metric">
        <span>Lowest voltage</span>
        <strong>{system.lowestVoltagePu.toFixed(3)} pu</strong>
      </div>
    </div>

    <div class="split">
      <div>
        <h3>Constrained corridors</h3>
        {#each branches as branch}
          <div class="row">
            <span>{branch.object.label}</span>
            <strong>{Math.round(branch.data.loadingPercent)}%</strong>
          </div>
        {/each}
      </div>
      <div>
        <h3>Generation stack</h3>
        {#each generators as generator}
          <div class="row">
            <span>{generator.object.label}</span>
            <strong>{mw(generator.data.dispatchMw)} MW</strong>
          </div>
        {/each}
      </div>
    </div>

    <div class="supply">
      <h3>Consumer supply</h3>
      {#each loads as load}
        <div class="row" class:problem={load.data.serviceState !== 'normal'}>
          <span>{load.object.label}</span>
          <strong>{Math.round(load.data.shedMw)} MW shed</strong>
        </div>
      {/each}
    </div>
    <button
      class="resize-grip"
      type="button"
      aria-label="Resize grid overview panel"
      title="Resize grid overview panel"
      onpointerdown={(event) => startGesture(event, 'resize')}
    ></button>
  </section>
{/if}

<style>
  .grid-overview {
    position: absolute;
    z-index: 12;
    overflow: auto;
    color: #0f172a;
    background: rgba(248, 250, 252, 0.94);
    border: 1px solid rgba(148, 163, 184, 0.55);
    box-shadow: 0 18px 44px rgba(15, 23, 42, 0.18);
    backdrop-filter: blur(14px);
    border-radius: 6px;
    padding: 16px;
    box-sizing: border-box;
    min-width: 360px;
    min-height: 260px;
  }

  :global(.dark) .grid-overview {
    color: #e5e7eb;
    background: rgba(15, 23, 42, 0.92);
    border-color: rgba(71, 85, 105, 0.85);
  }

  .overview-titlebar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 14px;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .overview-titlebar:active {
    cursor: grabbing;
  }

  .eyebrow {
    margin: 0 0 3px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
    color: #64748b;
  }

  h2, h3 {
    margin: 0;
    letter-spacing: 0;
  }

  h2 {
    font-size: 19px;
    line-height: 1.15;
  }

  h3 {
    font-size: 12px;
    text-transform: uppercase;
    color: #475569;
    margin-bottom: 8px;
  }

  :global(.dark) h3,
  :global(.dark) .eyebrow {
    color: #94a3b8;
  }

  .frequency {
    min-width: 108px;
    text-align: right;
    color: #047857;
  }

  .frequency.watch {
    color: #b45309;
  }

  .frequency.alert {
    color: #dc2626;
  }

  .frequency span {
    display: block;
    font-size: 32px;
    line-height: 0.95;
    font-weight: 800;
  }

  .frequency small {
    font-weight: 800;
    font-size: 12px;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 14px;
  }

  .metric {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    padding: 8px;
    min-width: 0;
  }

  .metric span,
  .row span {
    display: block;
    font-size: 11px;
    color: #64748b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.dark) .metric span,
  :global(.dark) .row span {
    color: #94a3b8;
  }

  .metric strong {
    display: block;
    margin-top: 4px;
    font-size: 13px;
  }

  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-bottom: 14px;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: baseline;
    padding: 5px 0;
    border-top: 1px solid rgba(148, 163, 184, 0.22);
  }

  .row strong {
    font-size: 12px;
  }

  .row.problem strong {
    color: #dc2626;
  }

  .resize-grip {
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 20px;
    height: 20px;
    border: 0;
    border-radius: 3px;
    background:
      linear-gradient(135deg, transparent 48%, rgba(100, 116, 139, 0.75) 50%, transparent 52%) 5px 11px / 10px 10px no-repeat,
      linear-gradient(135deg, transparent 48%, rgba(100, 116, 139, 0.55) 50%, transparent 52%) 10px 6px / 10px 10px no-repeat;
    cursor: nwse-resize;
    touch-action: none;
  }

  .resize-grip:hover,
  .resize-grip:focus-visible {
    outline: none;
    background-color: rgba(37, 99, 235, 0.08);
  }

  @media (max-width: 900px) {
    .grid-overview {
      left: 12px;
      top: 12px;
      width: calc(100vw - 24px);
      height: min(70vh, 640px);
      min-width: 0;
    }

    .metric-grid,
    .split {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>

<script lang="ts">
  import type { CompiledProcessSurface, CompiledProcessSurfacePath, CompiledProcessSurfaceWidget, ProcessSurfaceValue } from '../../packs/process-plant/surfaces/index.ts'

  interface Props {
    readonly surface: CompiledProcessSurface
    readonly values: ReadonlyMap<string, ProcessSurfaceValue>
  }

  let { surface, values }: Props = $props()

  const valueFor = (path: string): ProcessSurfaceValue | undefined =>
    values.get(path)

  const numericValueFor = (path: string): number | null => {
    const value = valueFor(path)?.value
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  const bindingRows = (widget: CompiledProcessSurfaceWidget): ReadonlyArray<ProcessSurfaceValue> =>
    Object.values(widget.binds).map(binding => valueFor(binding.path)).filter(value => value !== undefined)

  const levelFractionFor = (widget: CompiledProcessSurfaceWidget): number => {
    const levelBinding = widget.binds.level
    if (!levelBinding) return 0.5
    const value = numericValueFor(levelBinding.path)
    if (value === null) return 0.5
    return Math.max(0, Math.min(1, value > 1 ? value / 100 : value))
  }

  const pathData = (path: CompiledProcessSurfacePath): string =>
    path.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')

  const pathFlowFraction = (path: CompiledProcessSurfacePath): number => {
    const binding = path.binds.flow ?? Object.values(path.binds)[0]
    if (!binding) return 0
    const value = numericValueFor(binding.path)
    if (value === null) return 0
    return Math.max(0.15, Math.min(1, Math.abs(value) / 5_000))
  }

  const serviceClass = (path: CompiledProcessSurfacePath): string =>
    `process-flow ${path.style.service ?? 'support'}`

  const widgetClass = (widget: CompiledProcessSurfaceWidget): string =>
    `process-widget ${widget.type} ${widget.style.tone ?? 'primary'}`
</script>

<div class="process-surface-viewport">
  <svg
    class="process-surface-svg"
    viewBox="0 0 {surface.designSize.width} {surface.designSize.height}"
    role="img"
    aria-label={surface.title}
  >
    <defs>
      <linearGradient id="process-vessel-fill" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.72" />
        <stop offset="100%" stop-color="#93c5fd" stop-opacity="0.38" />
      </linearGradient>
      <marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
        <path d="M 0 0 L 8 4 L 0 8 z" class="process-flow-arrow" />
      </marker>
    </defs>

    {#each surface.paths as path (path.id)}
      <path class="process-flow-casing" d={pathData(path)} />
      <path
        class={serviceClass(path)}
        d={pathData(path)}
        pathLength="1"
        stroke-dasharray="{pathFlowFraction(path)} 0.18"
        marker-end="url(#flow-arrow)"
      />
    {/each}

    {#each surface.widgets as widget (widget.id)}
      <g class={widgetClass(widget)} transform="translate({widget.geometry.x} {widget.geometry.y})">
        {#if widget.type === 'vessel' || widget.type === 'heatExchanger'}
          <rect class="widget-shell" x="0" y="0" width={widget.geometry.width} height={widget.geometry.height} rx="18" />
          <rect
            class="widget-level-fill"
            x="10"
            y={(widget.geometry.height - 10) - (widget.geometry.height - 20) * levelFractionFor(widget)}
            width={widget.geometry.width - 20}
            height={(widget.geometry.height - 20) * levelFractionFor(widget)}
            rx="12"
          />
          {#if widget.type === 'heatExchanger'}
            <path class="widget-coil" d="M {widget.geometry.width * 0.28} {widget.geometry.height * 0.18} C {widget.geometry.width * 0.72} {widget.geometry.height * 0.30}, {widget.geometry.width * 0.28} {widget.geometry.height * 0.44}, {widget.geometry.width * 0.72} {widget.geometry.height * 0.56} S {widget.geometry.width * 0.28} {widget.geometry.height * 0.78}, {widget.geometry.width * 0.72} {widget.geometry.height * 0.88}" />
          {/if}
        {:else if widget.type === 'pump'}
          <circle class="widget-shell" cx={widget.geometry.width / 2} cy={widget.geometry.height / 2} r={Math.min(widget.geometry.width, widget.geometry.height) * 0.42} />
          <circle class="widget-ring" cx={widget.geometry.width / 2} cy={widget.geometry.height / 2} r={Math.min(widget.geometry.width, widget.geometry.height) * 0.34} />
          <path class="widget-impeller" d="M {widget.geometry.width / 2} {widget.geometry.height * 0.22} L {widget.geometry.width * 0.68} {widget.geometry.height * 0.58} L {widget.geometry.width * 0.32} {widget.geometry.height * 0.58} Z" />
        {:else if widget.type === 'valve'}
          <rect class="widget-shell" x="8" y={widget.geometry.height * 0.28} width={widget.geometry.width - 16} height={widget.geometry.height * 0.44} rx="8" />
          <path class="widget-valve" d="M 16 {widget.geometry.height * 0.32} L {widget.geometry.width / 2} {widget.geometry.height / 2} L 16 {widget.geometry.height * 0.68} Z M {widget.geometry.width - 16} {widget.geometry.height * 0.32} L {widget.geometry.width / 2} {widget.geometry.height / 2} L {widget.geometry.width - 16} {widget.geometry.height * 0.68} Z" />
        {:else}
          <rect class="widget-shell" x="0" y="0" width={widget.geometry.width} height={widget.geometry.height} rx="14" />
        {/if}
        <text class="widget-title" x={widget.geometry.width / 2} y="24" text-anchor="middle">{widget.label}</text>
        {#each bindingRows(widget).slice(0, widget.type === 'statusBanner' || widget.type === 'alarmStrip' ? 4 : 3) as row, index (row.path)}
          <text class="widget-readout" x="16" y={widget.geometry.height - 18 - (bindingRows(widget).slice(0, 4).length - index - 1) * 19}>
            {row.label}: {row.formatted}
          </text>
        {/each}
      </g>
    {/each}
  </svg>
</div>

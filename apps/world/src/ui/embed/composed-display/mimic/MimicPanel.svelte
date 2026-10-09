<script lang="ts">
  import type { CompiledMimic, MimicNode } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
  import { formatQuantity } from '../../../../packs/process-plant/displays/display-text.ts'
  import type { ComposedDisplaySample } from '../composed-display-client.ts'
  import { openBridgeIcons } from './openbridge-icons.ts'
  import { chevrons, crossings, flowLook, headerLook, indexSample, levelLook, nodeAlarm, pumpLook, reliefLook, valveLook } from './mimic-state.ts'

  // One SVG in World's fixed geometry, drawn with OpenBridge's symbols and
  // colour tokens. Nothing moves between samples: a sample changes classes,
  // fills and text only. A stale view draws every state as unknown and says so.
  let { mimic, latest, stale }: {
    mimic: CompiledMimic
    latest: ComposedDisplaySample | undefined
    stale: boolean
  } = $props()

  const index = $derived(indexSample(stale ? undefined : latest))
  const alarms = $derived(stale ? [] : latest?.alarms ?? [])
  const headers = $derived(mimic.nodes.filter(node => node.symbol === 'header'))
  const symbols = $derived(mimic.nodes.filter(node => node.symbol !== 'header'))
  const bridges = $derived(crossings(mimic.pipes, headers.map(node => ({ id: node.id, x: node.x, y: node.y + node.height / 2, width: node.width }))))

  const valueText = (path: string, unit: string): string => {
    const value = index.get(path)?.value
    return typeof value === 'number' ? formatQuantity(value, unit) : '—'
  }
  const named = (value: { readonly path: string; readonly unit: string; readonly name?: string }): string =>
    `${value.name === undefined ? '' : `${value.name} `}${valueText(value.path, value.unit)}`
  const points = (list: ReadonlyArray<readonly [number, number]>): string => list.map(([x, y]) => `${x},${y}`).join(' ')
  const centerX = (node: MimicNode): number => node.x + node.width / 2
  const centerY = (node: MimicNode): number => node.y + node.height / 2
  const flapWidth = (kind: string): number => kind === 'trip' ? 30 : 26
</script>

<div class="mimic-panel">
  <svg
    class="mimic"
    viewBox={`0 0 ${mimic.width} ${mimic.height}`}
    width="100%"
    height={mimic.height}
    preserveAspectRatio="xMidYMid meet"
    role="group"
    aria-label={`Equipment mimic: ${mimic.view}, loops ${mimic.loops.join(', ')}`}
  >
    <!-- Pipes: an OpenBridge casing with an inner line; hollow below the no-flow band, dashed when unknown. -->
    {#each mimic.pipes as pipe (pipe.id)}
      {@const flow = flowLook(pipe, index)}
      <g>
        <title>{pipe.linkId}: {pipe.unverified ? 'model flow not verified, not drawn' : flow.value === null ? 'no value' : formatQuantity(flow.value, 'kg/s')}</title>
        <polyline class="casing" points={points(pipe.points)} />
        <polyline class={`inner ${flow.look}`} points={points(pipe.points)} />
        {#if flow.look === 'forward' || flow.look === 'reverse'}
          {#each chevrons(pipe.points) as chevron, at (at)}
            <path class="chevron" d="M-4,-5 L4,0 L-4,5 Z" transform={`translate(${chevron.x} ${chevron.y}) rotate(${chevron.angle + (flow.look === 'reverse' ? 180 : 0)})`} />
          {/each}
        {/if}
      </g>
    {/each}

    {#each headers as node (node.id)}
      {@const look = headerLook(node, index)}
      <rect class="header-casing" x={node.x} y={node.y - 1} width={node.width} height={node.height + 2} />
      <rect class={`header-inner ${look}`} x={node.x} y={node.y} width={node.width} height={node.height} />
      <text class="label" x={node.x + 4} y={node.y - 4}>{node.label}</text>
    {/each}

    <!-- A horizontal run bridges a vertical pipe it crosses, so the crossing never reads as a junction. -->
    {#each bridges as bridge, at (at)}
      <line class="bridge-gap" x1={bridge.x - 5} x2={bridge.x + 5} y1={bridge.y} y2={bridge.y} />
      <line class="bridge" x1={bridge.x - 6} x2={bridge.x + 6} y1={bridge.y} y2={bridge.y} />
    {/each}

    {#each symbols as node (node.id)}
      {@const alarm = nodeAlarm(node, alarms)}
      <g class="node" role="img" aria-label={`${node.label}${alarm === null ? '' : `, ${alarm.kind === 'trip' ? 'trip' : 'alarm'}: ${alarm.title}`}`}>
        {#if node.symbol === 'pump'}
          {@const pump = pumpLook(node, index)}
          {#if pump.look === 'unknown'}
            <rect class="unknown" x={node.x} y={node.y} width={node.width} height={node.height} rx="3" />
            <text class="unknown-mark" x={centerX(node)} y={centerY(node) + 4} text-anchor="middle">?</text>
          {:else}
            <svg x={node.x} y={node.y} width={node.width} height={node.height} viewBox="0 0 24 24">
              {@html openBridgeIcons[node.orientation === 'vertical' ? `pump-${pump.look}-vertical` : `pump-${pump.look}-horizontal`]}
            </svg>
          {/if}
          {#if node.values.length > 0}
            <text class="label" x={node.x + node.width + 5} y={centerY(node) - 2}>{node.label}</text>
            {#each node.values as value (value.path)}
              <text class="value" x={node.x + node.width + 5} y={centerY(node) + 11}>{named(value)}</text>
            {/each}
            {#if pump.mismatch !== null}<text class="mismatch" x={node.x + node.width + 5} y={centerY(node) + 23}>{pump.mismatch}</text>{/if}
          {:else if node.orientation === 'horizontal'}
            <text class="label" x={node.x - 5} y={centerY(node) + 4} text-anchor="end">{node.label}</text>
            {#if pump.mismatch !== null}<text class="mismatch" x={node.x - 5} y={centerY(node) + 16} text-anchor="end">{pump.mismatch}</text>{/if}
          {:else}
            <text class="label" x={centerX(node)} y={node.y + node.height + 12} text-anchor="middle">{node.label}</text>
            {#if pump.mismatch !== null}<text class="mismatch" x={centerX(node)} y={node.y + node.height + 24} text-anchor="middle">{pump.mismatch}</text>{/if}
          {/if}
        {:else if node.symbol === 'valve'}
          {@const valve = valveLook(node, index)}
          <g transform={node.orientation === 'vertical' ? `rotate(90 ${centerX(node)} ${centerY(node)})` : undefined}>
            <svg x={node.x} y={node.y} width={node.width} height={node.height} viewBox="0 0 24 24">
              {@html openBridgeIcons[valve.icon]}
            </svg>
          </g>
          {#each node.values as value (value.path)}
            {@const left = value.side === 'left'}
            {@const textX = left ? node.x - 4 : node.x + node.width + 4}
            {#if node.label !== ''}<text class="label" x={textX} y={centerY(node) - 4} text-anchor={left ? 'end' : 'start'}>{node.label}</text>{/if}
            {#if valve.tagged}<text class="value" x={textX} y={centerY(node) + 9} text-anchor={left ? 'end' : 'start'}>{valve.position === null ? '—' : valueText(value.path, value.unit)}</text>{/if}
            {#if valve.mismatch !== null}<text class="mismatch" x={textX} y={centerY(node) + 21} text-anchor={left ? 'end' : 'start'}>{valve.mismatch.split(' · ')[0]}</text>{/if}
          {/each}
        {:else if node.symbol === 'relief-valve'}
          {@const relief = reliefLook(node, index)}
          <svg x={node.x} y={node.y} width={node.width} height={node.height} viewBox="0 0 24 24">
            {@html openBridgeIcons[relief.icon]}
          </svg>
          <!-- Below the line it sits on, so the text never hides the pipe. -->
          <text class="label" x={node.x} y={node.y + node.height + 12}>{node.label} · POS ?</text>
          {#each node.values as value (value.path)}
            <text class="value" x={node.x} y={node.y + node.height + 25}>{relief.passing === null ? '—' : relief.passing ? `passing ${valueText(value.path, value.unit)}` : 'no flow'}</text>
          {/each}
          {#if relief.mismatch !== null}<text class="mismatch" x={node.x} y={node.y + node.height + 37}>{relief.mismatch}</text>{/if}
        {:else if node.symbol === 'steam-generator' || node.symbol === 'pressurizer' || node.symbol === 'tank'}
          {@const level = levelLook(node, index)}
          {@const radius = Math.min(node.width, node.height) / 2}
          {@const left = node.values[0]?.side === 'left'}
          {@const textX = left ? node.x - 6 : node.x + node.width + 6}
          <rect class="vessel" x={node.x} y={node.y} width={node.width} height={node.height} rx={radius} />
          {#if level.fraction !== null}
            <clipPath id={`level-${node.id}`}><rect x={node.x} y={node.y} width={node.width} height={node.height} rx={radius} /></clipPath>
            <rect class="level" clip-path={`url(#level-${node.id})`} x={node.x} y={node.y + node.height * (1 - level.fraction)} width={node.width} height={node.height * level.fraction} />
          {:else}
            <rect class="unknown" x={node.x} y={node.y} width={node.width} height={node.height} rx={radius} />
          {/if}
          <rect class="vessel-outline" x={node.x} y={node.y} width={node.width} height={node.height} rx={radius} />
          <!-- I&C level limits as short bands on the vessel, named in their titles. -->
          {#each node.limits as limit (limit.name)}
            {@const limitY = node.y + node.height * (1 - limit.value / 100)}
            <line class={`limit ${limit.kind}`} x1={node.x - 3} x2={node.x + 6} y1={limitY} y2={limitY}><title>{limit.name}</title></line>
          {/each}
          {#if node.values.length > 0}
            <text class="label" x={textX} y={node.y + 12} text-anchor={left ? 'end' : 'start'}>{node.label}</text>
            {#each node.values as value, at (value.path)}
              <text class="value" x={textX} y={node.y + 26 + at * 13} text-anchor={left ? 'end' : 'start'}>{named(value)}</text>
            {/each}
            {#if level.offScale !== null}<text class="mismatch" x={textX} y={node.y + 26 + node.values.length * 13} text-anchor={left ? 'end' : 'start'}>{level.offScale === 'high' ? '▲ above span' : '▼ below span'}</text>{/if}
          {/if}
        {:else if node.symbol === 'reactor'}
          <!-- The vessel with a core band; its values sit beside it. -->
          <rect class="vessel" x={node.x} y={node.y} width={node.width} height={node.height} rx="18" />
          <rect class="core" x={node.x + 10} y={node.y + node.height * 0.45} width={node.width - 20} height={node.height * 0.35} rx="3" />
          <rect class="vessel-outline" x={node.x} y={node.y} width={node.width} height={node.height} rx="18" />
          <text class="label" x={centerX(node)} y={node.y + 18} text-anchor="middle">{node.label}</text>
          {#each node.values as value, at (value.path)}
            <text class="label" x={node.x - 8} y={node.y + 14 + at * 30} text-anchor="end">{value.name ?? ''}</text>
            <text class="value" x={node.x - 8} y={node.y + 27 + at * 30} text-anchor="end">{valueText(value.path, value.unit)}</text>
          {/each}
        {:else if node.symbol === 'stub'}
          <!-- Where a drawn pipe leaves the view: named, never drawn as equipment. -->
          <text class="label" x={node.x} y={node.y - 3}>{node.label}</text>
          <line class="stub" x1={node.x} x2={node.x} y1={node.y} y2={node.y + node.height} />
        {/if}
        {#if alarm !== null}
          <rect class={`alarm-frame ${alarm.severity}`} x={node.x - 4} y={node.y - 4} width={node.width + 8} height={node.height + 8} rx="3" />
          <rect class={`alarm-flap ${alarm.severity}`} x={node.x - 4} y={node.y - 18} width={flapWidth(alarm.kind)} height={13} rx="2" />
          <text class="alarm-flap-text" x={node.x - 4 + flapWidth(alarm.kind) / 2} y={node.y - 8} text-anchor="middle">{alarm.kind === 'trip' ? 'TRIP' : 'ALM'}</text>
        {/if}
      </g>
    {/each}
    {#if stale}
      <text class="stale" x={mimic.width - 4} y="12" text-anchor="end">STALE · states not current</text>
    {/if}
  </svg>
  <p class="legend">Simulator values · hollow pipe: no flow · ▸ flow · CMD: command differs from state · POS ?: not measured</p>
</div>

<style>
  .mimic-panel { display: flex; flex-direction: column; gap: 2px; }
  .mimic { display: block; overflow: visible; }
  .legend { margin: 0; font-size: 10.5px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .casing { fill: none; stroke: var(--automation-pipe-tertiary-color); stroke-width: 6; stroke-linejoin: miter; }
  .inner { fill: none; stroke: var(--automation-pipe-primary-color); stroke-width: 4; stroke-linejoin: miter; }
  /* Below the no-flow band the pipe reads empty; an unknown flow is dashed. */
  .inner.none { stroke: var(--automation-pipe-primary-inverted-color); }
  .inner.unknown { stroke: var(--automation-pipe-primary-inverted-color); stroke-dasharray: 3 3; }
  /* Chevrons contrast with the pipe they sit on. */
  .chevron { fill: var(--container-background-color); }
  .header-casing { fill: var(--automation-pipe-tertiary-color); }
  .header-inner { fill: var(--automation-pipe-primary-color); }
  .header-inner.empty { fill: var(--automation-pipe-primary-inverted-color); }
  .header-inner.unknown { fill: var(--automation-pipe-primary-inverted-color); opacity: 0.6; }
  .bridge-gap { stroke: var(--container-background-color); stroke-width: 10; }
  .bridge { stroke: var(--automation-pipe-tertiary-color); stroke-width: 6; }
  .vessel { fill: var(--container-section-color); }
  .vessel-outline { fill: none; stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .core { fill: var(--container-background-color); stroke: var(--element-neutral-color); stroke-width: 1; }
  .level { fill: var(--automation-pipe-primary-color); }
  .limit { stroke-width: 2; }
  .limit.alarm { stroke: var(--element-neutral-color); }
  .limit.trip { stroke: var(--element-active-color); }
  .unknown { fill: none; stroke: var(--element-neutral-color); stroke-dasharray: 3 2; }
  .unknown-mark { fill: var(--element-neutral-color); font-size: 12px; }
  .stub { stroke: var(--element-neutral-color); stroke-width: 2; }
  .label { fill: var(--element-neutral-color); font-size: 11px; }
  .value { fill: var(--element-active-color); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
  /* A command that disagrees with the equipment is stated in words, never by colour alone. */
  .mismatch { fill: var(--element-active-color); font-size: 11px; font-weight: 700; }
  .stale { fill: var(--alert-caution-color); font-size: 11px; font-weight: 700; }
  .alarm-frame { fill: none; stroke-width: 2; }
  .alarm-frame.critical { stroke: var(--alert-alarm-color); }
  .alarm-frame.warning { stroke: var(--alert-warning-color); }
  .alarm-frame.notice, .alarm-frame.info { stroke: var(--alert-caution-color); }
  .alarm-flap.critical { fill: var(--alert-alarm-color); }
  .alarm-flap.warning { fill: var(--alert-warning-color); }
  .alarm-flap.notice, .alarm-flap.info { fill: var(--alert-caution-color); }
  .alarm-flap-text { fill: var(--container-background-color); font-size: 10px; font-weight: 700; }
</style>

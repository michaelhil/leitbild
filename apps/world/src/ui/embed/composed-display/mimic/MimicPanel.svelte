<script lang="ts">
  import type { CompiledMimic, MimicNode } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
  import { formatQuantity } from '../../../../packs/process-plant/displays/display-text.ts'
  import type { ComposedDisplaySample } from '../composed-display-client.ts'
  import { openBridgeIcons } from './openbridge-icons.ts'
  import { chevrons, crossings, flowLook, indexSample, levelLook, nodeAlarm, pumpLook, valveLook } from './mimic-state.ts'

  // One SVG in World's fixed geometry, drawn with OpenBridge's symbols and
  // colour tokens. Nothing moves between samples: a sample changes classes,
  // fills and text only. A stale view draws every state as unknown.
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
  const points = (list: ReadonlyArray<readonly [number, number]>): string => list.map(([x, y]) => `${x},${y}`).join(' ')
  const centerX = (node: MimicNode): number => node.x + node.width / 2
  const centerY = (node: MimicNode): number => node.y + node.height / 2
</script>

<svg
  class="mimic"
  viewBox={`0 0 ${mimic.width} ${mimic.height}`}
  width="100%"
  height={mimic.height}
  preserveAspectRatio="xMidYMid meet"
  role="group"
  aria-label={`Equipment mimic: ${mimic.view}, loops ${mimic.loops.join(', ')}`}
>
  <!-- Pipes: an OpenBridge casing with an inner line; empty when below the no-flow band. -->
  {#each mimic.pipes as pipe (pipe.id)}
    {@const flow = flowLook(pipe, index)}
    <g>
      <title>{pipe.linkId}: {flow.value === null ? 'no value' : formatQuantity(flow.value, 'kg/s')}</title>
      <polyline class="casing" points={points(pipe.points)} />
      <polyline class={`inner ${flow.look}`} points={points(pipe.points)} />
      {#if flow.look === 'forward' || flow.look === 'reverse'}
        {#each chevrons(pipe.points) as chevron, at (at)}
          <path class="chevron" d="M-3.5,-4 L2.5,0 L-3.5,4 Z" transform={`translate(${chevron.x} ${chevron.y}) rotate(${chevron.angle + (flow.look === 'reverse' ? 180 : 0)})`} />
        {/each}
      {/if}
    </g>
  {/each}

  {#each headers as node (node.id)}
    <rect class="header-casing" x={node.x} y={node.y - 1} width={node.width} height={node.height + 2} />
    <rect class="header-inner" x={node.x} y={node.y} width={node.width} height={node.height} />
    <text class="label" x={node.x + 2} y={node.y + (node.id.startsWith('afw') ? 15 : -5)}>{node.label}</text>
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
          <svg x={node.x - 2} y={node.y - 2} width={node.width + 4} height={node.height + 4} viewBox="0 0 24 24">
            {@html openBridgeIcons[node.orientation === 'vertical' ? `pump-${pump.look}-vertical` : `pump-${pump.look}-horizontal`]}
          </svg>
        {/if}
        {#if node.orientation === 'horizontal'}
          <text class="label" x={node.x - 5} y={centerY(node) + 3.5} text-anchor="end">{node.label}</text>
          {#if pump.mismatch !== null}<text class="mismatch" x={node.x - 5} y={centerY(node) + 14} text-anchor="end">{pump.mismatch}</text>{/if}
        {:else}
          <text class="label" x={centerX(node)} y={node.y + node.height + 11} text-anchor="middle">{node.label}</text>
          {#if pump.mismatch !== null}<text class="mismatch" x={centerX(node)} y={node.y + node.height + 22} text-anchor="middle">{pump.mismatch}</text>{/if}
        {/if}
      {:else if node.symbol === 'valve'}
        {@const valve = valveLook(node, index)}
        <g transform={node.orientation === 'vertical' ? `rotate(90 ${centerX(node)} ${centerY(node)})` : undefined}>
          <svg x={node.x - 2} y={node.y - 2} width={node.width + 4} height={node.height + 4} viewBox="0 0 24 24">
            {@html openBridgeIcons[valve.icon]}
          </svg>
        </g>
        {#each valve.tagged ? node.values : [] as value (value.path)}
          {@const left = value.side === 'left'}
          <text class="label" x={left ? node.x - 4 : node.x + node.width + 4} y={centerY(node) - 3} text-anchor={left ? 'end' : 'start'}>{node.label}</text>
          <text class="value" x={left ? node.x - 4 : node.x + node.width + 4} y={centerY(node) + 9} text-anchor={left ? 'end' : 'start'}>{valve.position === null ? '—' : valueText(value.path, value.unit)}</text>
          {#if valve.mismatch !== null}<text class="mismatch" x={left ? node.x - 4 : node.x + node.width + 4} y={centerY(node) + 20} text-anchor={left ? 'end' : 'start'}>{valve.mismatch}</text>{/if}
        {/each}
      {:else if node.symbol === 'steam-generator'}
        {@const level = levelLook(node, index)}
        <rect class="vessel" x={node.x} y={node.y} width={node.width} height={node.height} rx={node.width / 2} />
        {#if level.fraction !== null}
          <clipPath id={`level-${node.id}`}><rect x={node.x} y={node.y} width={node.width} height={node.height} rx={node.width / 2} /></clipPath>
          <rect class="level" clip-path={`url(#level-${node.id})`} x={node.x} y={node.y + node.height * (1 - level.fraction)} width={node.width} height={node.height * level.fraction} />
        {:else}
          <rect class="unknown" x={node.x} y={node.y} width={node.width} height={node.height} rx={node.width / 2} />
        {/if}
        <rect class="vessel-outline" x={node.x} y={node.y} width={node.width} height={node.height} rx={node.width / 2} />
        {#each node.values as value (value.path)}
          <text class="label" x={node.x + node.width + 4} y={node.y + 14}>{node.label}</text>
          <text class="value" x={node.x + node.width + 4} y={node.y + 27}>{valueText(value.path, value.unit)}</text>
          {#if level.offScale !== null}<text class="mismatch" x={node.x + node.width + 4} y={node.y + 38}>{level.offScale === 'high' ? '▲ above span' : '▼ below span'}</text>{/if}
        {/each}
      {/if}
      {#if alarm !== null}
        <rect class={`alarm-frame ${alarm.severity}`} x={node.x - 4} y={node.y - 4} width={node.width + 8} height={node.height + 8} rx="3" />
        <text class={`alarm-flap ${alarm.severity}`} x={node.x - 4} y={node.y - 7}>{alarm.kind === 'trip' ? 'TRIP' : 'ALM'}</text>
      {/if}
    </g>
  {/each}
</svg>

<style>
  .mimic { display: block; overflow: visible; }
  .casing { fill: none; stroke: var(--automation-pipe-tertiary-color); stroke-width: 6; stroke-linejoin: miter; }
  .inner { fill: none; stroke: var(--automation-pipe-primary-color); stroke-width: 4; stroke-linejoin: miter; }
  /* Below the no-flow band the pipe reads empty; an unknown flow is dashed. */
  .inner.none { stroke: var(--automation-pipe-primary-inverted-color); }
  .inner.unknown { stroke: var(--automation-pipe-primary-inverted-color); stroke-dasharray: 3 3; }
  .chevron { fill: var(--automation-pipe-tertiary-color); stroke: var(--automation-pipe-primary-color); stroke-width: 0.75; }
  .header-casing { fill: var(--automation-pipe-tertiary-color); }
  .header-inner { fill: var(--automation-pipe-primary-color); }
  .bridge-gap { stroke: var(--container-background-color); stroke-width: 10; }
  .bridge { stroke: var(--automation-pipe-tertiary-color); stroke-width: 6; }
  .vessel { fill: var(--container-section-color); }
  .vessel-outline { fill: none; stroke: var(--automation-device-tertiary-color); stroke-width: 1.5; }
  .level { fill: var(--automation-pipe-primary-color); }
  .unknown { fill: none; stroke: var(--automation-device-tertiary-color); stroke-dasharray: 3 2; }
  .unknown-mark { fill: var(--element-neutral-color); font-size: 11px; }
  .label { fill: var(--element-neutral-color); font-size: 10px; }
  .value { fill: var(--element-active-color); font-size: 11.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
  /* A command that disagrees with the equipment is stated in words, never by colour alone. */
  .mismatch { fill: var(--element-active-color); font-size: 9.5px; font-weight: 600; }
  .alarm-frame { fill: none; stroke-width: 2; }
  .alarm-frame.critical { stroke: var(--alert-alarm-color); }
  .alarm-frame.warning { stroke: var(--alert-warning-color); }
  .alarm-frame.notice, .alarm-frame.info { stroke: var(--alert-caution-color); }
  .alarm-flap { font-size: 9px; font-weight: 700; }
  .alarm-flap.critical { fill: var(--alert-alarm-color); }
  .alarm-flap.warning { fill: var(--alert-warning-color); }
  .alarm-flap.notice, .alarm-flap.info { fill: var(--alert-caution-color); }
</style>

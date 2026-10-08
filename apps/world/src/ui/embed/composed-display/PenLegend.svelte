<script lang="ts">
  import type { ComposedDisplayPen } from '../../../packs/process-plant/displays/compose.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { penStroke, roleLabel } from './pen-style.ts'
  import { unitLabel, valueDigits } from './trend-geometry.ts'
  import './openbridge.ts'

  let { pens, latest, historyMissing }: {
    pens: ReadonlyArray<ComposedDisplayPen>
    latest: ComposedDisplaySample | undefined
    historyMissing: ReadonlySet<string>
  } = $props()

  const sampled = (path: string) => latest?.values.find(entry => entry.path === path)
</script>

<ul class="legend">
  {#each pens as pen, index (pen.path)}
    {@const entry = sampled(String(pen.path))}
    {@const value = entry?.value}
    {@const liveOnly = historyMissing.has(String(pen.path))}
    <li title={`${pen.label} · ${roleLabel[pen.role]}${liveOnly ? ' · no recorded history; live since this view opened' : ''}`}>
      <svg class="swatch" width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" style={penStroke(pen.role, index)} /></svg>
      <span class="tag">{pen.tagId ?? pen.path}</span>
      <span class="role">{roleLabel[pen.role]}{liveOnly ? ' · live only' : ''}</span>
      <obc-readout
        value={typeof value === 'number' ? value : null}
        off={typeof value !== 'number'}
        offText="—"
        unit={unitLabel(pen.unit)}
        fractionDigits={typeof value === 'number' ? valueDigits(value) : 0}
        size="small"
      ></obc-readout>
      {#if entry?.quality === 'outside-hard-range'}<span class="quality">outside range</span>{/if}
    </li>
  {/each}
</ul>

<style>
  .legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2px 14px; height: 34px; overflow: hidden; }
  li { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .swatch { flex: none; }
  .tag { font-weight: 600; font-variant-numeric: tabular-nums; }
  .role { font-size: 11px; color: var(--element-neutral-color); }
  .quality { font-size: 11px; color: var(--alert-caution-color); }
</style>

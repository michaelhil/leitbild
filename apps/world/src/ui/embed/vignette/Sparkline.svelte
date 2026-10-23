<script lang="ts">
  import type { DrawnSeries } from './trend.ts'
  import { sparkline } from './sparkline.ts'
  import type { AlertTone } from './readout.ts'

  // A reading's last ten minutes beside its value (D-C; register `sparkline`):
  // a neutral line in OpenBridge's mini graph frame, scaled to its own range,
  // broken where nothing was recorded; in its alert's colour, heavier, while
  // its value is coloured. The words carry the range, for the title and for
  // assistive technology. Frozen or doubtful, it fades with its value.
  let { series, now, windowMs, size, tone, text, doubtful }: {
    series: DrawnSeries | undefined
    /** The latest sample's Run time: where the line ends. */
    now: number
    windowMs: number
    size: { readonly width: number; readonly height: number }
    tone: AlertTone | null
    /** What the line shows, for its title and accessible name (rowText). */
    text: (range: { readonly min: number; readonly max: number } | null, broken: boolean) => string
    doubtful: boolean
  } = $props()

  const line = $derived(series === undefined || !Number.isFinite(now) ? null : sparkline(series.points, now, windowMs, size, series.holdMs, series.silentFrom))
  const words = $derived(text(line?.range ?? null, line?.broken === true))
</script>

<svg class={['spark', tone, { doubtful }]} width={size.width} height={size.height} role="img" aria-label={words}>
  <title>{words}</title>
  <rect class="frame" x="0.5" y="0.5" width={size.width - 1} height={size.height - 1} rx="3" />
  {#if line !== null}<path class="line" d={line.path} />{#if line.end !== null}<circle class="end" cx={line.end.x} cy={line.end.y} r="2" />{/if}{/if}
</svg>

<style>
  .spark { display: block; flex: none; }
  /* OpenBridge's mini graph frame (obc-graph-mini), drawn here so the line can break where nothing was recorded. */
  .frame { fill: var(--instrument-frame-primary-color); stroke: var(--instrument-frame-tertiary-color); stroke-width: 1; }
  .line { fill: none; stroke: var(--element-neutral-color); stroke-width: 1.5; stroke-linejoin: round; }
  .end { fill: var(--element-neutral-color); }
  /* Colour and weight both carry the alert, as the value's frame does. */
  .caution .line, .warning .line, .alarm .line, .critical .line { stroke-width: 2; }
  .caution .line { stroke: var(--alert-caution-color); }
  .caution .end { fill: var(--alert-caution-color); }
  .warning .line { stroke: var(--alert-warning-color); }
  .warning .end { fill: var(--alert-warning-color); }
  .alarm .line { stroke: var(--alert-alarm-color); }
  .alarm .end { fill: var(--alert-alarm-color); }
  .critical .line { stroke: var(--alert-critical-color); }
  .critical .end { fill: var(--alert-critical-color); }
  .doubtful { opacity: 0.45; }
</style>

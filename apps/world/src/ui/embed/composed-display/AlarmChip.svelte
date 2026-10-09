<script lang="ts">
  import type { ComposedDisplayThreshold } from '../../../packs/process-plant/displays/ic-thresholds.ts'

  let { threshold }: { threshold: ComposedDisplayThreshold } = $props()
</script>

<!-- Shown only while the threshold's I&C rule is active; colour and text both carry the state. -->
<span class={`chip ${threshold.severity ?? 'warning'}`} title={threshold.label}>{threshold.direction === 'low' ? 'LO' : 'HI'} {threshold.kind === 'trip' ? 'TRIP' : 'ALM'}</span>

<style>
  .chip { font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em; padding: 0 5px; border-radius: 3px; white-space: nowrap; color: var(--container-background-color); }
  /* One severity-to-colour map for chips, limit labels and alarm rows. */
  .chip.critical { background: var(--alert-alarm-color); color: #fff; }
  .chip.warning { background: var(--alert-warning-color); }
  .chip.notice, .chip.info { background: var(--alert-caution-color); }
</style>

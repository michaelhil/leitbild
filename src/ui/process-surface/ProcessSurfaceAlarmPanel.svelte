<script lang="ts">
  import type {
    CompiledProcessSurfaceWidget,
    ProcessSurfaceAlarmLifecycle,
    ProcessSurfaceAlarmSnapshot,
  } from '../../packs/process-plant/surfaces/index.ts'

  interface Props {
    readonly widget: CompiledProcessSurfaceWidget
    readonly geometry: CompiledProcessSurfaceWidget['geometry']
    readonly alarms: ProcessSurfaceAlarmSnapshot
  }

  let { widget, geometry, alarms }: Props = $props()

  const leftWidth = $derived(Math.min(252, Math.max(214, geometry.width * 0.18)))
  const rightWidth = $derived(Math.min(390, Math.max(292, geometry.width * 0.24)))
  const listX = $derived(leftWidth + 26)
  const rightX = $derived(geometry.width - rightWidth - 18)
  const listWidth = $derived(Math.max(260, rightX - listX - 24))
  const maxRows = $derived(Math.max(2, Math.min(5, Math.floor((geometry.height - 30) / 18))))
  const rowTitleLimit = $derived(Math.max(28, Math.floor((listWidth - 166) / 6.2)))

  const visibleAlarms = $derived(alarms.active.slice(0, maxRows))
  const focusAlarm = $derived(alarms.activeFirstOut[0] ?? alarms.active[0] ?? null)
  const panelTone = $derived(alarms.activeTripCount > 0 || alarms.activeHighestSeverity === 'critical'
    ? 'critical'
    : alarms.activeAlarmCount > 0
      ? 'warning'
      : 'normal')

  const shorten = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}...`

  const elapsedLabel = (elapsedMs: number | undefined): string => {
    if (elapsedMs === undefined) return '--:--'
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `T+${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  const kindLabel = (alarm: ProcessSurfaceAlarmLifecycle): string =>
    alarm.kind === 'trip' ? 'TRIP' : alarm.severity === 'critical' ? 'CRIT' : 'ALARM'

  const rowStatus = (alarm: ProcessSurfaceAlarmLifecycle): string =>
    alarm.firstOut ? 'FIRST' : alarm.acknowledged ? 'ACK' : 'UNACK'
</script>

<rect class="alarm-panel-shell {panelTone}" x="0" y="0" width={geometry.width} height={geometry.height} rx="4" />
<text class="alarm-panel-title" x="14" y="20">{widget.label}</text>
<g class="alarm-panel-summary" transform="translate(14 38)">
  <text x="0" y="0">
    <tspan class="alarm-panel-summary-label">Trips</tspan>
    <tspan class="alarm-panel-summary-value" dx="5">{alarms.activeTripCount}</tspan>
  </text>
  <text x="0" y="18">
    <tspan class="alarm-panel-summary-label">Alarms</tspan>
    <tspan class="alarm-panel-summary-value" dx="5">{alarms.activeAlarmCount}</tspan>
  </text>
  <text x="112" y="0">
    <tspan class="alarm-panel-summary-label">Unack</tspan>
    <tspan class="alarm-panel-summary-value" dx="5">{alarms.unacknowledgedCount}</tspan>
  </text>
  <text x="112" y="18">
    <tspan class="alarm-panel-summary-label">First-out</tspan>
    <tspan class="alarm-panel-summary-value" dx="5">{alarms.firstOutCount}</tspan>
  </text>
</g>

<line class="alarm-panel-divider" x1={leftWidth} x2={leftWidth} y1="12" y2={geometry.height - 12} />
<line class="alarm-panel-divider" x1={rightX - 14} x2={rightX - 14} y1="12" y2={geometry.height - 12} />

{#if visibleAlarms.length === 0}
  <text class="alarm-panel-empty" x={listX} y={Math.max(48, geometry.height / 2 + 5)}>
    {alarms.configured ? 'No active alarms or trips' : 'I&C alarm lifecycle unavailable'}
  </text>
{:else}
  <g transform="translate({listX} 18)">
    {#each visibleAlarms as alarm, index (alarm.id)}
      <g class="alarm-panel-row {alarm.severity} {alarm.kind}" transform="translate(0 {index * 18})">
        <rect x="0" y="-12" width={listWidth} height="16" rx="2" />
        <text class="alarm-panel-row-kind" x="6" y="0">{kindLabel(alarm)}</text>
        <text class="alarm-panel-row-title" x="58" y="0">{shorten(alarm.title, rowTitleLimit)}</text>
        <text class="alarm-panel-row-status" x={listWidth - 92} y="0">{rowStatus(alarm)}</text>
        <text class="alarm-panel-row-time" x={listWidth - 8} y="0" text-anchor="end">{elapsedLabel(alarm.firstActiveElapsedMs ?? alarm.lastActiveElapsedMs)}</text>
      </g>
    {/each}
  </g>
{/if}

<g class="alarm-panel-focus" transform="translate({rightX} 20)">
  {#if focusAlarm}
    <text class="alarm-panel-focus-label" x="0" y="0">Priority</text>
    <text class="alarm-panel-focus-title {focusAlarm.severity}" x="0" y="18">{shorten(focusAlarm.title, 38)}</text>
    <text class="alarm-panel-focus-message" x="0" y="36">{shorten(focusAlarm.message, 54)}</text>
    <text class="alarm-panel-focus-meta" x="0" y="54">
      {focusAlarm.annunciator?.system ?? 'process plant'} · {focusAlarm.annunciator?.equipmentId ?? focusAlarm.kind}
    </text>
  {:else}
    <text class="alarm-panel-focus-label" x="0" y="0">Priority</text>
    <text class="alarm-panel-focus-title normal" x="0" y="24">Clear</text>
    <text class="alarm-panel-focus-message" x="0" y="42">No active first-out alarm or trip</text>
  {/if}
</g>

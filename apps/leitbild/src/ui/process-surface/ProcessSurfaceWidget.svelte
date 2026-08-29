<script lang="ts">
  import type { CompiledProcessSurfaceWidget, ProcessSurfaceAlarmSnapshot, ProcessSurfaceValue } from '../../packs/process-plant/surfaces/index.ts'
  import { emptyProcessSurfaceAlarmSnapshot } from './process-surface-client.ts'
  import ProcessSurfaceAlarmPanel from './ProcessSurfaceAlarmPanel.svelte'
  import { bindingRowsFor, levelFractionFor } from './process-surface-rendering.ts'

  interface Props {
    readonly widget: CompiledProcessSurfaceWidget
    readonly geometry: CompiledProcessSurfaceWidget['geometry']
    readonly values: ReadonlyMap<string, ProcessSurfaceValue>
    readonly alarms?: ProcessSurfaceAlarmSnapshot
    readonly dragging?: boolean
    readonly renderScale?: number
    readonly onStartDrag?: (event: PointerEvent, widget: CompiledProcessSurfaceWidget) => void
    readonly onUpdateDrag?: (event: PointerEvent) => void
    readonly onFinishDrag?: (event: PointerEvent) => void
  }

  let {
    widget,
    geometry,
    values,
    alarms = emptyProcessSurfaceAlarmSnapshot,
    dragging = false,
    renderScale = 1,
    onStartDrag,
    onUpdateDrag,
    onFinishDrag,
  }: Props = $props()

  const rows = $derived(bindingRowsFor(widget, values))
  const levelFraction = $derived(levelFractionFor(widget, values))
  const rowLimit = $derived(widget.role === 'steam-generator'
    ? 6
    : widget.type === 'statusBanner' || widget.type === 'alarmStrip' || widget.type === 'alarmPanel' ? 4 : 3)
  const displayRows = $derived(rows.slice(0, rowLimit))
  const widgetClass = $derived(`process-widget ${widget.type} ${widget.role ?? 'generic'} ${widget.style.tone ?? 'primary'} ${dragging ? 'dragging' : ''}`)
  const shortTitle = $derived(widget.label.length > 22 ? `${widget.label.slice(0, 20)}...` : widget.label)
  const detailLevel = $derived(renderScale >= 1.35 ? 'detailed' : renderScale <= 0.64 ? 'compact' : 'normal')
  const metricColumns = $derived(displayRows.length <= 1
    ? 1
    : geometry.width >= 620
      ? Math.min(4, displayRows.length)
      : geometry.width >= 180
        ? 2
        : 1)
  const metricCellWidth = $derived((geometry.width - 28) / Math.max(1, metricColumns))
  const metricCompact = $derived(geometry.height < 76)
  const metricBaseY = $derived(metricCompact ? 32 : geometry.height >= 86 ? 46 : 38)
  const metricRowGap = $derived(metricCompact ? 18 : 24)
  const metricValueOffset = $derived(metricCompact ? 12 : 14)
  const metricLabelFor = (value: string): string =>
    value.length <= 18 ? value : `${value.slice(0, 17)}...`
  const metricXFor = (index: number): number => 14 + (index % metricColumns) * metricCellWidth
  const metricYFor = (index: number): number => metricBaseY + Math.floor(index / metricColumns) * metricRowGap
  const pumpRadius = $derived(Math.min(geometry.width, geometry.height) * 0.36)
  const levelHeight = $derived(Math.max(0, (geometry.height - 34) * levelFraction))
  const levelY = $derived(geometry.height - 18 - levelHeight)
  const rowFor = (key: string): ProcessSurfaceValue | undefined => {
    const binding = widget.binds[key]
    return binding ? values.get(binding.path) : undefined
  }
  const pumpRunning = $derived(rowFor('running')?.value)
  const pumpIsStopped = $derived(pumpRunning === false)
  const pumpFlow = $derived(rowFor('flow'))
  const pumpSpeed = $derived(rowFor('speed'))
  const pumpPrimaryReadout = $derived(pumpIsStopped ? 'TRIPPED' : (pumpFlow?.formatted ?? pumpSpeed?.formatted ?? rows[0]?.formatted))
  const pumpSecondaryReadout = $derived(pumpFlow && pumpSpeed
    ? `${pumpFlow.formatted} / ${pumpSpeed.formatted}`
    : pumpFlow?.formatted ?? pumpSpeed?.formatted)
  const numericValue = (key: string): number | null => {
    const value = rowFor(key)?.value
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
  const booleanStateLabel = (value: unknown, trueLabel: string, falseLabel: string): string => {
    if (value === true) return trueLabel
    if (value === false) return falseLabel
    return 'UNKNOWN'
  }
  const rodInsertionFraction = $derived(clamp(numericValue('rods') ?? 0, 0, 1))
  const rodsInserted = $derived(rodInsertionFraction >= 0.95)
  const tripBreakerAClosed = $derived(rowFor('tripBreakerA')?.value)
  const tripBreakerBClosed = $derived(rowFor('tripBreakerB')?.value)
  const tripBreakerAOpen = $derived(tripBreakerAClosed === false)
  const tripBreakerBOpen = $derived(tripBreakerBClosed === false)
  const reactorProtectionActuated = $derived(rodsInserted || tripBreakerAOpen || tripBreakerBOpen)
  const reactorProtectionStateLabel = $derived(reactorProtectionActuated ? 'RPS TRIP' : 'RPS READY')
  const rodStateLabel = $derived(rodsInserted ? 'INSERTED' : `${(rodInsertionFraction * 100).toFixed(0)}%`)
  const tripBreakerStateLabel = $derived(
    `A ${booleanStateLabel(tripBreakerAClosed, 'CLOSED', 'OPEN')} / B ${booleanStateLabel(tripBreakerBClosed, 'CLOSED', 'OPEN')}`,
  )
  const sgDisplayFor = (key: string): { readonly label: string; readonly formatted: string } | undefined => {
    const binding = widget.binds[key]
    const value = binding ? values.get(binding.path) : undefined
    if (!binding || !value) return undefined
    return { label: binding.label ?? value.label, formatted: value.formatted }
  }
  const sgAlert = $derived((numericValue('radiation') ?? 0) > 1 || levelFraction < 0.22 || levelFraction > 0.84)
  const sgLevelHeight = $derived(Math.max(0, 188 * levelFraction))
  const sgLevelY = $derived(260 - sgLevelHeight)
  const sgReadoutKeys = ['pressure', 'steam', 'feedwater', 'heat']
  const sgLevel = $derived(sgDisplayFor('level'))
  const sgRadiation = $derived(sgDisplayFor('radiation'))
  const sgStateLabel = $derived(sgAlert ? 'CHECK' : 'NORM')
  const sgTrendKeys = ['level', 'steam', 'feedwater', 'pressure'] as const
  type SgTrendKey = typeof sgTrendKeys[number]
  let trendHistory = $state<Record<SgTrendKey, ReadonlyArray<number>>>({
    level: [],
    steam: [],
    feedwater: [],
    pressure: [],
  })
  const collectSgPeerIds = (): ReadonlyArray<string> => {
    const peerIds = new Set<string>()
    for (const key of values.keys()) {
      const componentMatch = key.match(/^sg([A-Za-z0-9_-]+)\./)
      const steamMatch = key.match(/^sg-([A-Za-z0-9_-]+)-steam-to-msiv-\1\.flowKgPerS$/)
      const feedwaterMatch = key.match(/^feedwater-control-valve-([A-Za-z0-9_-]+)-to-sg-\1\.flowKgPerS$/)
      const peerId = componentMatch?.[1] ?? steamMatch?.[1] ?? feedwaterMatch?.[1]
      if (peerId !== undefined && peerId.length > 0) peerIds.add(peerId.toUpperCase())
    }
    return Array.from(peerIds).sort((left, right) => left.localeCompare(right))
  }
  const currentSgPeerId = (): string | null => {
    const suffix = widget.id.match(/^sg-(.+)$/)?.[1]?.toUpperCase()
    return suffix ?? null
  }
  const sgPeerValuePath = (key: 'level' | 'pressure' | 'steam' | 'feedwater' | 'radiation', peerId: string): string => {
    const lower = peerId.toLowerCase()
    if (key === 'level') return `sg${peerId}.levelPercent`
    if (key === 'pressure') return `sg${peerId}.pressureMPa`
    if (key === 'radiation') return `sg${peerId}.secondaryRadiationMSvPerH`
    if (key === 'steam') return `sg-${lower}-steam-to-msiv-${lower}.flowKgPerS`
    return `feedwater-control-valve-${lower}-to-sg-${lower}.flowKgPerS`
  }
  const peerAverageFor = (key: 'level' | 'pressure' | 'steam' | 'feedwater' | 'radiation'): number | null => {
    const currentPeerId = currentSgPeerId()
    const peerValues = collectSgPeerIds()
      .filter(peerId => peerId !== currentPeerId)
      .map(peerId => values.get(sgPeerValuePath(key, peerId))?.value)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (peerValues.length === 0) return null
    return peerValues.reduce((total, value) => total + value, 0) / peerValues.length
  }
  const trendPathFor = (
    key: SgTrendKey,
    x: number,
    y: number,
    width: number,
    height: number,
    min: number,
    max: number,
  ): string => {
    const history = trendHistory[key]
    if (history.length === 0) return ''
    const spread = max - min || 1
    return history
      .map((value, index) => {
        const px = x + (history.length === 1 ? width : (index / (history.length - 1)) * width)
        const py = y + height - clamp((value - min) / spread, 0, 1) * height
        return `${index === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`
      })
      .join(' ')
  }
  const appendTrendSample = (key: SgTrendKey, sample: number): void => {
    const history = trendHistory[key]
    const last = history[history.length - 1]
    if (last !== undefined && Math.abs(last - sample) < 0.0001) return
    trendHistory = {
      ...trendHistory,
      [key]: [...history.slice(-23), sample],
    }
  }
  $effect(() => {
    for (const key of sgTrendKeys) {
      const value = numericValue(key)
      if (value !== null) appendTrendSample(key, value)
    }
  })
  const peerLevelFraction = $derived(clamp((peerAverageFor('level') ?? 50) / 100, 0, 1))
  const peerLevelY = $derived(260 - Math.max(0, 188 * peerLevelFraction))
  const steamFlow = $derived(numericValue('steam') ?? 0)
  const feedwaterFlow = $derived(numericValue('feedwater') ?? 0)
  const flowBalance = $derived(feedwaterFlow - steamFlow)
  const flowBalanceOffset = $derived(clamp(flowBalance / 90, -1, 1))
  const pressureValue = $derived(numericValue('pressure') ?? 6.8)
  const pressureFraction = $derived(clamp((pressureValue - 5.5) / 2.5, 0, 1))
  const peerRadiationValue = $derived(peerAverageFor('radiation') ?? 0.02)
  const sgDetailLevel = $derived(detailLevel)
  const sgTubeApexY = 96
</script>

<g
  class={widgetClass}
  transform="translate({geometry.x} {geometry.y})"
  role="button"
  tabindex="0"
  aria-label="Move {widget.label}"
  onpointerdown={(event) => onStartDrag?.(event, widget)}
  onpointermove={(event) => onUpdateDrag?.(event)}
  onpointerup={(event) => onFinishDrag?.(event)}
  onpointercancel={(event) => onFinishDrag?.(event)}
>
  {#if widget.type === 'statusBanner'}
    <rect class="overview-status-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="4" />
    <text class="overview-status-title" x="16" y="25">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <g transform="translate({220 + index * 300} 0)">
        <text class="overview-status-label" x="0" y="24">{row.label}</text>
        <text class="overview-status-value" x="0" y="50">{row.formatted}</text>
      </g>
    {/each}
  {:else if widget.role === 'reactor-vessel'}
    <rect class="rv-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="3" />
    <text class="widget-title overview-readout-title rv-title" x="16" y="24">{shortTitle}</text>
    <g class="rv-vessel {detailLevel}" transform="translate(36 42)">
      <path class="rv-vessel-body" d="M 44 0 H 84 C 104 0 118 16 118 38 V 176 C 118 199 101 216 78 216 H 50 C 27 216 10 199 10 176 V 38 C 10 16 24 0 44 0 Z" />
      <rect class="rv-coolant-fill" x="18" y="38" width="92" height="170" rx="2" />
      <g class="rv-core">
        <rect x="42" y="72" width="44" height="86" rx="2" />
        <path d="M 50 80 V 150 M 58 80 V 150 M 66 80 V 150 M 74 80 V 150 M 82 80 V 150" />
      </g>
      {#if detailLevel !== 'compact'}
        <path class="rv-flow-guide hot" d="M 118 62 H 154 M 118 104 H 154 M 118 146 H 154 M 118 188 H 154" />
        <path class="rv-flow-guide cold" d="M 10 60 H -24 M 10 102 H -24 M 10 144 H -24 M 10 186 H -24" />
      {/if}
    </g>
    <g class="overview-widget-metrics" transform="translate(16 {geometry.height - 62})">
      {#each displayRows as row, index (row.path)}
        <text class="widget-readout overview-readout" x="0" y={index * 17}>
          <tspan class="widget-readout-label">{row.label}</tspan>
          <tspan dx="5">{row.formatted}</tspan>
        </text>
      {/each}
    </g>
  {:else if widget.role === 'pressurizer'}
    <rect class="pz-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="3" />
    <text class="widget-title overview-readout-title" x="14" y="22">{shortTitle}</text>
    <g transform="translate(18 36)">
      <rect class="pz-vessel" x="0" y="0" width="44" height={geometry.height - 50} rx="18" />
      <rect class="pz-level" x="5" y={(geometry.height - 45) * (1 - levelFraction)} width="34" height={(geometry.height - 55) * levelFraction} rx="12" />
      <line class="pz-target" x1="-5" x2="49" y1={(geometry.height - 50) * 0.45} y2={(geometry.height - 50) * 0.45} />
    </g>
    <g class="overview-widget-metrics" transform="translate(74 48)">
      {#each displayRows as row, index (row.path)}
        <text class="widget-readout overview-readout" x="0" y={index * 18}>
          <tspan class="widget-readout-label">{row.label}</tspan>
          <tspan dx="5">{row.formatted}</tspan>
        </text>
      {/each}
    </g>
  {:else if widget.role === 'steam-generator'}
    <rect class="sg-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="2" class:alert={sgAlert} />
    <rect class="sg-status-rail" x="0" y="0" width="5" height={geometry.height} rx="1" class:alert={sgAlert} />
    <line class="sg-section-rule" x1="0" x2={geometry.width} y1="42" y2="42" />
    <line class="sg-section-rule" x1="0" x2={geometry.width} y1="296" y2="296" />
    <text class="widget-title sg-title" x="12" y="23">{shortTitle}</text>
    <text class="sg-type-label" x="58" y="23">U-TUBE SG</text>
    <rect class="sg-state-pill" x={geometry.width - 58} y="10" width="46" height="17" rx="2" class:alert={sgAlert} />
    <text class="sg-state-text" x={geometry.width - 35} y="22" text-anchor="middle">{sgStateLabel}</text>
    {#if sgRadiation}
      <text class="sg-radiation-text" x={geometry.width - 12} y="56" text-anchor="end">RAD {sgRadiation.formatted}</text>
    {/if}

    <text class="sg-instrument-label" x="15" y="62">LEVEL</text>
    <rect class="sg-level-track" x="16" y="72" width="34" height="188" rx="1" />
    <rect class="sg-peer-band" x="18" y={peerLevelY - 4} width="30" height="8" rx="1" />
    <rect class="sg-level-fill" x="19" y={sgLevelY} width="26" height={sgLevelHeight} rx="1" />
    <path class="sg-trend-tail level" d={trendPathFor('level', 20, 84, 26, 156, 0, 100)} />
    <line class="sg-level-reference" x1="11" x2="53" y1="166" y2="166" />
    <line class="sg-level-reference low" x1="15" x2="49" y1="222" y2="222" />
    {#if sgLevel}
      <text class="sg-level-value" x="32" y="275" text-anchor="middle">{sgLevel.formatted}</text>
    {/if}

    <g class="sg-vessel {sgDetailLevel}" transform="translate(60 54)">
      <path class="sg-vessel-shadow" d="M 38 0 H 82 C 98 0 108 12 108 30 V 199 C 108 216 96 228 80 228 H 40 C 24 228 12 216 12 199 V 30 C 12 12 22 0 38 0 Z" />
      <clipPath id="sg-vessel-clip-{widget.id}">
        <path d="M 38 0 H 82 C 98 0 108 12 108 30 V 199 C 108 216 96 228 80 228 H 40 C 24 228 12 216 12 199 V 30 C 12 12 22 0 38 0 Z" />
      </clipPath>
      <g clip-path="url(#sg-vessel-clip-{widget.id})">
        <rect class="sg-vessel-water" x="12" y={228 - levelFraction * 156} width="96" height={levelFraction * 156} />
        <rect class="sg-peer-vessel-band" x="12" y={228 - peerLevelFraction * 156 - 3} width="96" height="6" />
        <path class="sg-vessel-trend" d={trendPathFor('level', 20, 88, 80, 116, 0, 100)} />
      </g>
      <path class="sg-vessel-outline" d="M 38 0 H 82 C 98 0 108 12 108 30 V 199 C 108 216 96 228 80 228 H 40 C 24 228 12 216 12 199 V 30 C 12 12 22 0 38 0 Z" />
      <path class="sg-vessel-cap" d="M 38 0 H 82 C 98 0 108 12 108 30 H 12 C 12 12 22 0 38 0 Z" />
      <line class="sg-secondary-waterline" x1="21" x2="99" y1={228 - levelFraction * 156} y2={228 - levelFraction * 156} />
      <line class="sg-uncover-threshold" x1="25" x2="95" y1={sgTubeApexY} y2={sgTubeApexY} />
      <path class="sg-u-tube-reference" d="M 43 205 V 126 C 43 {sgTubeApexY - 20}, 77 {sgTubeApexY - 20}, 77 126 V 205" />
      {#if sgDetailLevel !== 'compact'}
        <path class="sg-u-tube-reference secondary" d="M 50 205 V 132 C 50 {sgTubeApexY - 10}, 70 {sgTubeApexY - 10}, 70 132 V 205" />
        <path class="sg-u-tube-reference secondary" d="M 36 205 V 138 C 36 {sgTubeApexY - 4}, 84 {sgTubeApexY - 4}, 84 138 V 205" />
      {/if}
      {#if sgDetailLevel === 'detailed'}
        <g class="sg-separator-bank">
          <rect x="25" y="24" width="70" height="22" rx="1" />
          <path d="M 31 43 L 35 27 L 39 43 M 43 43 L 47 27 L 51 43 M 55 43 L 59 27 L 63 43 M 67 43 L 71 27 L 75 43 M 79 43 L 83 27 L 87 43" />
        </g>
        <path class="sg-downcomer-annulus" d="M 27 56 C 22 92, 22 154, 33 203 M 93 56 C 98 92, 98 154, 87 203" />
        <path class="sg-downcomer-arrow" d="M 29 82 v28 M 91 82 v28 M 31 161 v28 M 89 161 v28" />
        <path class="sg-tube-supports" d="M 33 130 H 87 M 33 158 H 87 M 33 186 H 87" />
      {/if}
      <path class="sg-tube-sheet" d="M 31 205 H 90" />
      <path class="sg-steam-riser" d="M 60 -30 V 0" />
      <path class="sg-feedwater-line" d="M 60 228 V 258" />
      <text class="sg-port-label steam" x="68" y="-16">STEAM</text>
      <text class="sg-port-label feedwater" x="68" y="249">FW</text>
    </g>

    <g class="sg-pressure-gauge" transform="translate({geometry.width - 24} 72)">
      <rect class="sg-pressure-track" x="0" y="0" width="7" height="188" rx="1" />
      <rect class="sg-pressure-fill" x="1.5" y={188 - pressureFraction * 188} width="4" height={pressureFraction * 188} rx="1" />
      <path class="sg-trend-tail pressure" d={trendPathFor('pressure', -52, 14, 44, 62, 5.5, 8)} />
    </g>

    <g class="sg-flow-trends" transform="translate(64 282)">
      <text class="sg-spark-label steam" x="0" y="0">Steam</text>
      <path class="sg-spark-baseline" d="M 44 -3 H 126" />
      <path class="sg-trend-tail steam" d={trendPathFor('steam', 44, -24, 82, 22, 0, 420)} />
      <text class="sg-spark-label feedwater" x="0" y="18">FW</text>
      <path class="sg-spark-baseline" d="M 44 15 H 126" />
      <path class="sg-trend-tail feedwater" d={trendPathFor('feedwater', 44, -6, 82, 22, 0, 420)} />
    </g>

    <g class="sg-balance" transform="translate(14 304)">
      <text class="sg-instrument-label" x="0" y="0">FW - STEAM</text>
      <line class="sg-balance-axis" x1="78" x2="178" y1="-3" y2="-3" />
      <line class="sg-balance-center" x1="128" x2="128" y1="-10" y2="4" />
      <rect
        class="sg-balance-bar"
        x={flowBalanceOffset < 0 ? 128 + flowBalanceOffset * 50 : 128}
        y="-7"
        width={Math.max(2, Math.abs(flowBalanceOffset) * 50)}
        height="8"
        rx="1"
        class:negative={flowBalanceOffset < -0.12}
        class:positive={flowBalanceOffset > 0.12}
      />
    </g>

    <g class="sg-leak-strip" transform="translate(14 326)">
      <text class="sg-instrument-label" x="0" y="0">TUBE LEAK</text>
      <rect class="sg-leak-track" x="78" y="-9" width="100" height="9" rx="1" />
      <rect
        class="sg-leak-fill"
        x="78"
        y="-9"
        width={clamp(((numericValue('radiation') ?? 0) / Math.max(peerRadiationValue * 20, 1)), 0.04, 1) * 100}
        height="9"
        rx="1"
        class:alert={sgAlert}
      />
    </g>

    <g class="sg-metrics" transform="translate(14 344)">
      {#each sgReadoutKeys as key, index (key)}
        {@const row = sgDisplayFor(key)}
        {#if row}
          <g class="sg-metric-cell" transform="translate({(index % 2) * 94} {Math.floor(index / 2) * 30})">
            <text class="widget-readout-label sg-metric-label" x="0" y="0">{row.label}</text>
            <text class="widget-readout sg-readout" x="0" y="15">{row.formatted}</text>
          </g>
        {/if}
      {/each}
    </g>
  {:else if widget.role === 'turbine-generator'}
    <rect class="tg-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="3" />
    <text class="widget-title centered" x={geometry.width / 2} y="18" text-anchor="middle">{shortTitle}</text>
    <g transform="translate({geometry.width / 2} {geometry.height / 2 + 4})">
      <circle class="tg-generator" cx="0" cy="0" r="34" />
      <path class="tg-blades" d="M 0 -25 L 10 -4 L 32 -4 M 0 25 L -10 4 L -32 4 M -22 -14 L -6 -8 L -18 18 M 22 14 L 6 8 L 18 -18" />
    </g>
    {#if displayRows[0]}
      <text class="widget-readout centered tg-output" x={geometry.width / 2} y={geometry.height - 14} text-anchor="middle">{displayRows[0].formatted}</text>
    {/if}
  {:else if widget.role === 'condenser'}
    <rect class="cd-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="3" />
    <text class="widget-title overview-readout-title" x="14" y="22">{shortTitle}</text>
    <g transform="translate(18 36)">
      <rect class="cd-hotwell" x="0" y="36" width={geometry.width - 36} height="52" rx="2" />
      <rect class="cd-hotwell-fill" x="4" y={86 - Math.max(4, levelFraction * 48)} width={geometry.width - 44} height={Math.max(4, levelFraction * 48)} rx="2" />
      <path class="cd-condensate-rain" d="M 24 0 V 28 M 48 0 V 28 M 72 0 V 28 M 96 0 V 28 M 120 0 V 28" />
    </g>
    <g class="overview-widget-metrics">
      {#each displayRows as row, index (row.path)}
        <g class="overview-metric-cell" transform="translate({metricXFor(index)} {metricYFor(index)})">
          <text class="overview-metric-label" x="0" y="0">{metricLabelFor(row.label)}</text>
          <text class="overview-metric-value" x="0" y={metricValueOffset}>{row.formatted}</text>
        </g>
      {/each}
    </g>
  {:else if widget.type === 'alarmPanel'}
    <ProcessSurfaceAlarmPanel {widget} {geometry} {alarms} />
  {:else if widget.role === 'reactor-protection'}
    <rect
      class="rps-shell"
      class:tripped={reactorProtectionActuated}
      x="0"
      y="0"
      width={geometry.width}
      height={geometry.height}
      rx="4"
    />
    <text class="rps-title" x="14" y="18">{shortTitle}</text>
    <g class="rps-state" class:tripped={reactorProtectionActuated} transform="translate({geometry.width - 76} 8)">
      <rect x="0" y="0" width="62" height="20" rx="2" />
      <text x="31" y="14" text-anchor="middle">{reactorProtectionActuated ? 'TRIP' : 'READY'}</text>
    </g>
    <text class="rps-primary" class:tripped={reactorProtectionActuated} x="14" y="39">
      {reactorProtectionStateLabel}
    </text>
    <text class="rps-detail" x="14" y="55">
      Rods {rodStateLabel} · {tripBreakerStateLabel}
    </text>
  {:else if widget.type === 'numericReadout' || widget.type === 'alarmStrip'}
    <rect class="overview-readout-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="4" />
    <text class="widget-title overview-readout-title" x="14" y="21">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <g class="overview-metric-cell" transform="translate({metricXFor(index)} {metricYFor(index)})">
        <text class="overview-metric-label" x="0" y="0">{metricLabelFor(row.label)}</text>
        <text class="overview-metric-value" x="0" y={metricValueOffset}>{row.formatted}</text>
      </g>
    {/each}
  {:else if widget.type === 'vessel'}
    <rect class="widget-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="10" />
    <rect class="widget-level-fill" x="12" y={levelY} width={geometry.width - 24} height={levelHeight} rx="8" />
    <line class="widget-reference-line" x1="12" x2={geometry.width - 12} y1={geometry.height * 0.32} y2={geometry.height * 0.32} />
    <text class="widget-title" x="16" y="22">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <text class="widget-readout" x="16" y={geometry.height - 50 + index * 17}>
        <tspan class="widget-readout-label">{row.label}</tspan>
        <tspan dx="4">{row.formatted}</tspan>
      </text>
    {/each}
  {:else if widget.type === 'heatExchanger'}
    <rect class="widget-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="10" />
    <rect class="widget-level-fill" x="12" y={levelY} width={geometry.width - 24} height={levelHeight} rx="8" />
    <path class="widget-coil" d="M {geometry.width * 0.28} {geometry.height * 0.18} C {geometry.width * 0.72} {geometry.height * 0.30}, {geometry.width * 0.28} {geometry.height * 0.44}, {geometry.width * 0.72} {geometry.height * 0.56} S {geometry.width * 0.28} {geometry.height * 0.78}, {geometry.width * 0.72} {geometry.height * 0.88}" />
    <text class="widget-title" x="16" y="22">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <text class="widget-readout" x="16" y={geometry.height - 48 + index * 16}>
        <tspan class="widget-readout-label">{row.label}</tspan>
        <tspan dx="4">{row.formatted}</tspan>
      </text>
    {/each}
  {:else if widget.type === 'pump'}
    <circle class="pump-shell" cx={geometry.width / 2} cy={geometry.height / 2} r={pumpRadius} />
    <circle class="pump-inner" cx={geometry.width / 2} cy={geometry.height / 2} r={pumpRadius * 0.74} />
    <path class="pump-impeller" class:stopped={pumpIsStopped} d="M {geometry.width / 2} {geometry.height * 0.25} L {geometry.width * 0.66} {geometry.height * 0.60} H {geometry.width * 0.34} Z" />
    <text class="widget-title centered" x={geometry.width / 2} y={geometry.height * 0.18} text-anchor="middle">{shortTitle}</text>
    {#if pumpPrimaryReadout}
      <text class="widget-readout centered pump-state" class:stopped={pumpIsStopped} x={geometry.width / 2} y={geometry.height * 0.76} text-anchor="middle">{pumpPrimaryReadout}</text>
    {/if}
    {#if pumpSecondaryReadout && detailLevel !== 'compact'}
      <text class="widget-readout centered pump-secondary" x={geometry.width / 2} y={geometry.height * 0.91} text-anchor="middle">{pumpSecondaryReadout}</text>
    {/if}
  {:else if widget.type === 'valve'}
    <rect class="widget-shell" x="6" y={geometry.height * 0.30} width={geometry.width - 12} height={geometry.height * 0.40} rx="6" />
    <path class="widget-valve" d="M 16 {geometry.height * 0.33} L {geometry.width / 2} {geometry.height / 2} L 16 {geometry.height * 0.67} Z M {geometry.width - 16} {geometry.height * 0.33} L {geometry.width / 2} {geometry.height / 2} L {geometry.width - 16} {geometry.height * 0.67} Z" />
    <text class="widget-title centered" x={geometry.width / 2} y="18" text-anchor="middle">{shortTitle}</text>
    {#if displayRows[0]}
      <text class="widget-readout centered" x={geometry.width / 2} y={geometry.height - 10} text-anchor="middle">{displayRows[0].formatted}</text>
    {/if}
  {:else}
    <rect class="widget-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="8" />
    <text class="widget-title" x="16" y="22">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <text class="widget-readout" x="16" y={42 + index * 17}>
        <tspan class="widget-readout-label">{row.label}</tspan>
        <tspan dx="4">{row.formatted}</tspan>
      </text>
    {/each}
  {/if}
</g>

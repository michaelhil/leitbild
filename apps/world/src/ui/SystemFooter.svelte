<script lang="ts">
  import { Pause, Play, Settings } from 'lucide-svelte'
  import type { SimulationClockState } from '../core/model/index.ts'
  import IconButton from './components/IconButton.svelte'
  import StatusDot, { type StatusTone } from './components/StatusDot.svelte'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'

  interface Props {
    readonly status: string
    readonly systemStatusTone: StatusTone
    readonly appVersion: string
    readonly clock?: SimulationClockState
    readonly openStatusModal: () => void
    readonly openSettings: () => void
    readonly toggleClockPaused: () => Promise<void>
  }

  let {
    status,
    systemStatusTone,
    appVersion,
    clock,
    openStatusModal,
    openSettings,
    toggleClockPaused,
  }: Props = $props()

  let wallTick = $state(Date.now())

  const clockTime = $derived.by((): Date | null => {
    if (!clock) return null
    const current = Date.parse(clock.currentTime)
    if (!Number.isFinite(current)) return null
    if (clock.paused) return new Date(current)
    const updatedAt = Date.parse(clock.updatedAt)
    if (!Number.isFinite(updatedAt)) return new Date(current)
    return new Date(current + Math.max(0, wallTick - updatedAt) * clock.speed)
  })

  const clockLabel = $derived(clockTime
    ? clockTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--')

  runOnMount(() => {
    const interval = setInterval(() => {
      wallTick = Date.now()
    }, 1000)
    return () => {
      clearInterval(interval)
    }
  })
</script>

<footer class="system-footer">
  <button class="status-dot-button" type="button" aria-label="Show Leitbild status" title={status} onclick={openStatusModal}>
    <StatusDot tone={systemStatusTone} label={status} />
  </button>
  <span class="brand">Leitbild</span>
  <span class="version">v{appVersion}</span>
  <div class="sim-clock" title={clock?.paused ? 'Simulation paused' : 'Simulation running'}>
    <IconButton
      label={clock?.paused ? 'Resume simulation time' : 'Pause simulation time'}
      title={clock?.paused ? 'Resume simulation time' : 'Pause simulation time'}
      icon={clock?.paused ? Play : Pause}
      variant="bare"
      onClick={() => { void toggleClockPaused() }}
    />
    <span>{clockLabel}</span>
  </div>
  <IconButton
    label="Open settings"
    title="Open settings"
    icon={Settings}
    variant="bare"
    onClick={openSettings}
  />
</footer>

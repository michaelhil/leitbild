<script lang="ts">
  import { Moon, RotateCcw, Sun } from 'lucide-svelte'
  import IconButton from './components/IconButton.svelte'
  import StatusDot, { type StatusTone } from './components/StatusDot.svelte'
  import type { ThemeMode } from './theme.ts'

  interface Props {
    readonly status: string
    readonly systemStatusTone: StatusTone
    readonly appVersion: string
    readonly theme: ThemeMode
    readonly toggleTheme: () => void
    readonly resetScenario: () => Promise<void>
    readonly openStatusModal: () => void
  }

  let {
    status,
    systemStatusTone,
    appVersion,
    theme,
    toggleTheme,
    resetScenario,
    openStatusModal,
  }: Props = $props()
</script>

<footer class="system-footer">
  <button class="status-dot-button" type="button" aria-label="Show Leitbild status" title={status} onclick={openStatusModal}>
    <StatusDot tone={systemStatusTone} label={status} />
  </button>
  <span class="brand">Leitbild</span>
  <span class="version">v{appVersion}</span>
  <IconButton
    label="Reset scenario"
    title="Reset scenario"
    icon={RotateCcw}
    variant="bare"
    onClick={() => { void resetScenario() }}
  />
  <IconButton
    label="Toggle light and dark mode"
    title="Toggle light and dark mode"
    icon={theme === 'dark' ? Sun : Moon}
    pressed={theme === 'dark'}
    variant="bare"
    onClick={toggleTheme}
  />
</footer>

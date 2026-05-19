<script lang="ts">
  import { Eye, EyeOff, Moon, RotateCcw, Sun } from 'lucide-svelte'
  import type { ThemeMode } from './theme.ts'
  import type { ScenarioListItem } from './types.ts'
  import IconButton from './components/IconButton.svelte'
  import ModalShell from './components/ModalShell.svelte'

  interface Props {
    readonly theme: ThemeMode
    readonly weatherLayerAvailable: boolean
    readonly weatherLayerVisible: boolean
    readonly scenarios: ReadonlyArray<ScenarioListItem>
    readonly selectedScenarioId: string
    readonly close: () => void
    readonly toggleTheme: () => void
    readonly toggleWeatherLayer: () => void
    readonly resetScenario: () => Promise<void>
    readonly selectScenario: (scenarioId: string) => Promise<void>
  }

  let {
    theme,
    weatherLayerAvailable,
    weatherLayerVisible,
    scenarios,
    selectedScenarioId,
    close,
    toggleTheme,
    toggleWeatherLayer,
    resetScenario,
    selectScenario,
  }: Props = $props()

  const onScenarioChange = (event: Event): void => {
    const target = event.currentTarget
    if (!(target instanceof HTMLSelectElement)) return
    void selectScenario(target.value)
  }
</script>

<ModalShell title="Settings" {close} size="small">
  <div class="settings-stack">
    <section class="settings-row">
      <div>
        <strong>Theme</strong>
        <span>Switch map and interface theme.</span>
      </div>
      <IconButton
        label="Toggle light and dark mode"
        title="Toggle light and dark mode"
        icon={theme === 'dark' ? Sun : Moon}
        pressed={theme === 'dark'}
        variant="ghost"
        onClick={toggleTheme}
      />
    </section>

    {#if weatherLayerAvailable}
      <section class="settings-row">
        <div>
          <strong>Weather overlay</strong>
          <span>Show or hide the weather field layer on the map.</span>
        </div>
        <IconButton
          label={weatherLayerVisible ? 'Hide weather overlay' : 'Show weather overlay'}
          title={weatherLayerVisible ? 'Hide weather overlay' : 'Show weather overlay'}
          icon={weatherLayerVisible ? Eye : EyeOff}
          pressed={weatherLayerVisible}
          variant="ghost"
          onClick={toggleWeatherLayer}
        />
      </section>
    {/if}

    <section class="settings-row">
      <div>
        <strong>Scenario</strong>
        <span>Reset this control instance from a scenario definition.</span>
      </div>
      <select value={selectedScenarioId} onchange={onScenarioChange}>
        {#each scenarios as scenario (scenario.id)}
          <option value={scenario.id}>{scenario.title}</option>
        {/each}
      </select>
    </section>

    <section class="settings-row">
      <div>
        <strong>Reset</strong>
        <span>Recreate the current scenario from its definition.</span>
      </div>
      <IconButton
        label="Reset scenario"
        title="Reset scenario"
        icon={RotateCcw}
        variant="ghost"
        onClick={() => { void resetScenario() }}
      />
    </section>
  </div>
</ModalShell>

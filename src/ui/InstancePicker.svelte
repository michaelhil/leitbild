<script lang="ts">
  import type { ControlInstanceSummary, ScenarioListItem } from './types.ts'

  interface Props {
    readonly scenarios: ReadonlyArray<ScenarioListItem>
    readonly instances: ReadonlyArray<ControlInstanceSummary>
    readonly status: string
    readonly createScenarioRun: (scenarioId: string) => Promise<void>
    readonly openScenarioRun: (scenarioId: string, runId: string) => void
  }

  let { scenarios, instances, status, createScenarioRun, openScenarioRun }: Props = $props()

  const runsForScenario = (scenarioId: string): ReadonlyArray<ControlInstanceSummary> =>
    instances.filter(instance => instance.scenarioId === scenarioId && instance.runId !== null)
</script>

<main class="instance-page">
  <section class="instance-panel">
    <header>
      <div>
        <div class="brand">Leitbild</div>
        <div class="object-meta">{status}</div>
      </div>
    </header>

    {#if scenarios.length === 0}
      <div class="empty-row">No scenarios are available</div>
    {:else}
      <div class="instance-list">
        {#each scenarios as scenario (scenario.id)}
          {@const scenarioRuns = runsForScenario(scenario.id)}
          <section class="scenario-picker-group">
            <header>
              <span>
                <strong>{scenario.title}</strong>
                <span class="object-meta">{scenario.description ?? scenario.id}</span>
              </span>
              <button class="command-button compact" onclick={() => createScenarioRun(scenario.id)}>New run</button>
            </header>
            {#if scenarioRuns.length === 0}
              <div class="empty-row compact">No active or persisted runs</div>
            {:else}
              <div class="scenario-run-list">
                {#each scenarioRuns as instance (instance.id)}
                  <button class="instance-row" onclick={() => instance.runId && openScenarioRun(scenario.id, instance.runId)}>
                    <span>
                      <strong>{instance.runId}</strong>
                      <span class="object-meta">
                        {instance.loaded ? 'Loaded' : 'Persisted'}
                        · {instance.websocketClientCount} {instance.websocketClientCount === 1 ? 'user' : 'users'}
                        {#if instance.objectCount !== null} · {instance.objectCount} objects{/if}
                        {#if instance.snapshotSeq !== null} · seq {instance.snapshotSeq}{/if}
                      </span>
                    </span>
                    <span>Open</span>
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </section>
</main>

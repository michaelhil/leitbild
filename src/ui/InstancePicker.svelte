<script lang="ts">
  import { Play, Trash2 } from 'lucide-svelte'
  import type { ControlInstanceSummary, ScenarioListItem } from './types.ts'

  interface Props {
    readonly scenarios: ReadonlyArray<ScenarioListItem>
    readonly instances: ReadonlyArray<ControlInstanceSummary>
    readonly status: string
    readonly createScenarioRun: (scenarioId: string) => Promise<void>
    readonly openScenarioRun: (scenarioId: string, runId: string) => void
    readonly deleteScenarioRun: (instance: ControlInstanceSummary) => Promise<void>
  }

  let { scenarios, instances, status, createScenarioRun, openScenarioRun, deleteScenarioRun }: Props = $props()

  const runsForScenario = (scenarioId: string): ReadonlyArray<ControlInstanceSummary> =>
    instances.filter(instance => instance.scenarioId === scenarioId && instance.runId !== null)

  const runLabel = (instance: ControlInstanceSummary): string =>
    instance.runId ?? instance.id
</script>

<main class="instance-page">
  <section class="instance-panel">
    <header class="instance-hero">
      <div class="instance-hero-copy">
        <div class="brand">Meet Leitbild</div>
        <h1>An AI-friendly multi-simulation system for command and control research.</h1>
        <p>
          Choose a scenario below, open an existing run, or start a new run. Runs keep moving on the server
          until they are paused, reset, or deleted, so colleagues can join the same operational picture later.
        </p>
        <div class="instance-status">System status: {status}</div>
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
              <button class="command-button compact scenario-new-run" onclick={() => createScenarioRun(scenario.id)}>
                <Play size={15} strokeWidth={2.2} aria-hidden="true" />
                New run
              </button>
            </header>
            {#if scenarioRuns.length === 0}
              <div class="empty-row compact">No active or persisted runs</div>
            {:else}
              <div class="scenario-run-list">
                {#each scenarioRuns as instance (instance.id)}
                  <article class="instance-row">
                    <button class="instance-open-target" onclick={() => instance.runId && openScenarioRun(scenario.id, instance.runId)}>
                      <strong>{runLabel(instance)}</strong>
                      <span class="object-meta">
                        {instance.loaded ? 'Loaded' : 'Persisted'}
                        · {instance.websocketClientCount} {instance.websocketClientCount === 1 ? 'user' : 'users'}
                        {#if instance.objectCount !== null} · {instance.objectCount} objects{/if}
                        {#if instance.snapshotSeq !== null} · seq {instance.snapshotSeq}{/if}
                      </span>
                    </button>
                    <div class="instance-row-actions">
                      <button class="instance-action open" onclick={() => instance.runId && openScenarioRun(scenario.id, instance.runId)}>Open</button>
                      <button
                        class="instance-action delete"
                        disabled={instance.websocketClientCount > 0}
                        title={instance.websocketClientCount > 0 ? 'Cannot delete a run while users are connected' : `Delete ${runLabel(instance)}`}
                        onclick={() => deleteScenarioRun(instance)}
                      >
                        <Trash2 size={15} strokeWidth={2.2} aria-hidden="true" />
                        Delete
                      </button>
                    </div>
                  </article>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </section>
</main>

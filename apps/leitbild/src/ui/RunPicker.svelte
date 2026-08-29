<script lang="ts">
  import { Play, Trash2 } from 'lucide-svelte'
  import type { SimulationRunSummary, ScenarioListItem } from './types.ts'

  interface Props {
    readonly scenarios: ReadonlyArray<ScenarioListItem>
    readonly runs: ReadonlyArray<SimulationRunSummary>
    readonly status: string
    readonly newSimulationRunPath: (scenarioId: string) => string
    readonly simulationRunPath: (id: SimulationRunSummary['id']) => string
    readonly deleteSimulationRun: (run: SimulationRunSummary) => Promise<void>
  }

  let { scenarios, runs, status, newSimulationRunPath, simulationRunPath, deleteSimulationRun }: Props = $props()

  const runsForScenario = (scenarioId: string): ReadonlyArray<SimulationRunSummary> =>
    runs.filter(run => run.scenarioId === scenarioId)

  const runLabel = (run: SimulationRunSummary): string => run.id
</script>

<main class="run-page">
  <section class="run-panel">
    <header class="run-hero">
      <div class="run-hero-copy">
        <h1><strong>Meet Leitbild,</strong> an AI-friendly multi-simulation system for command and control research.</h1>
        <p>
          Choose a scenario below, open an existing run, or start a new run. Runs keep moving on the server
          until they are paused, reset, or deleted, so colleagues can join the same operational picture later.
        </p>
        <div class="run-status">System status: {status}</div>
      </div>
    </header>

    {#if scenarios.length === 0}
      <div class="empty-row">No scenarios are available</div>
    {:else}
      <div class="run-list">
        {#each scenarios as scenario (scenario.id)}
          {@const scenarioRuns = runsForScenario(scenario.id)}
          <section class="scenario-picker-group">
            <header>
              <span>
                <strong>{scenario.title}</strong>
                <span class="object-meta">{scenario.description ?? scenario.id}</span>
              </span>
              <a
                class="command-button compact scenario-new-run"
                href={newSimulationRunPath(scenario.id)}
                aria-label="Start new run for {scenario.title}"
              >
                <Play size={15} strokeWidth={2.2} aria-hidden="true" />
                New run
              </a>
            </header>
            {#if scenarioRuns.length === 0}
              <div class="empty-row compact">No active or persisted runs</div>
            {:else}
              <div class="scenario-run-list">
                {#each scenarioRuns as run (run.id)}
                  <article class="run-row">
                      <a class="run-open-target" href={simulationRunPath(run.id)}>
                        <strong>{runLabel(run)}</strong>
                        <span class="object-meta">
                          {run.loaded ? 'Loaded' : 'Persisted'}
                          · {run.websocketClientCount} {run.websocketClientCount === 1 ? 'user' : 'users'}
                          {#if run.objectCount !== null} · {run.objectCount} objects{/if}
                          {#if run.snapshotSeq !== null} · seq {run.snapshotSeq}{/if}
                        </span>
                      </a>
                    <div class="run-row-actions">
                        <a class="run-action open" href={simulationRunPath(run.id)}>Open</a>
                      <button
                        class="run-action delete"
                        type="button"
                        disabled={run.websocketClientCount > 0}
                        title={run.websocketClientCount > 0 ? 'Cannot delete a run while users are connected' : `Delete ${runLabel(run)}`}
                        onclick={() => deleteSimulationRun(run)}
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

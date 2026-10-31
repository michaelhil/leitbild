<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { procedureDecisionReadInputSchema, procedureDecisionLocator, procedureTransitionDecisionSchema, type ProcedureTransitionDecision } from '../../../features/procedures/transition-receipt.ts'
  import { procedurePlantTime } from '../../procedures/procedure-run-selectors.ts'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()
  let decision = $state.raw<ProcedureTransitionDecision | null>(null)
  let failure = $state<string | null>(null)
  const event = $derived(decision?.event)
  const criterion = $derived(event?.criterion)
  const valueText = (value: number | boolean | undefined, unit?: string): string =>
    value === undefined ? 'unavailable' : `${String(value)}${unit === undefined || unit === 'boolean' ? '' : ` ${unit}`}`

  $effect(() => {
    const shown = envelope
    const abort = new AbortController()
    decision = null; failure = null
    const load = async (): Promise<void> => {
      const input = procedureDecisionReadInputSchema.parse(JSON.parse(shown.state))
      const workspaceId = shown.subject.workspaceId
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/world.procedure.decision.read/invoke`, {
        method: 'POST', cache: 'no-store', signal: abort.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: shown.subject, input, actor: { kind: 'human' } }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? `Recorded decision unavailable (${response.status})`)
      const result = procedureTransitionDecisionSchema.parse(body.result)
      const actual = procedureDecisionLocator(result)
      if (String(result.event.simulationRunId) !== String(shown.subject.id) || Object.entries(input).some(([key, value]) => actual[key as keyof typeof actual] !== value)) {
        throw new Error('Recorded decision identity does not match this view')
      }
      if (!abort.signal.aborted) decision = result
    }
    void load().catch(error => { if (!abort.signal.aborted) failure = error instanceof Error ? error.message : String(error) })
    return () => abort.abort()
  })
</script>

<main>
  {#if failure}
    <p class="embed-failure" role="alert">{failure}</p>
  {:else if decision && event}
    <header>
      <p>{decision.run.scope.label ?? decision.run.scope.plantId} · {decision.run.procedureId}</p>
      <h1>{event.label ?? event.stepId}</h1>
      <p>Recorded {procedurePlantTime(event.simulationTime)} · {event.selectedByLabel ?? event.selectedBy}</p>
    </header>
    <section aria-label="Recorded decision">
      <p><strong>{criterion?.status ?? 'Criterion evidence unavailable'}</strong> · {event.targetKind}: {event.target}</p>
      {#if event.basis}<p>{event.basis}</p>{/if}
      {#each criterion?.reasons ?? [] as reason}<p>{reason}</p>{/each}
      <p class="note">Historical evidence at this decision. Values are not resampled when this view opens.</p>
    </section>
    {#if criterion?.readings.length}
      <section aria-label="Recorded criterion readings">
        <h2>Checks at the decision</h2>
        <div class="table-scroll"><table>
          <thead><tr><th>Check</th><th>Recorded</th><th>Required</th><th>Result</th></tr></thead>
          <tbody>{#each criterion.readings as reading}
            <tr>
              <td><strong>{reading.tagId ?? reading.description ?? reading.source}</strong>{#if reading.sampledAt}<small>{procedurePlantTime(reading.sampledAt)}</small>{/if}</td>
              <td>{valueText(reading.value, reading.unit)}</td>
              <td>{reading.operator ?? ''} {valueText(reading.expected, reading.unit)}</td>
              <td>{reading.status}{#if reading.reason}<small>{reading.reason}</small>{/if}</td>
            </tr>
          {/each}</tbody>
        </table></div>
      </section>
    {/if}
    {#if criterion?.observation}
      <details open><summary>Recorded observation · {criterion.observation.capabilityId}</summary><pre>{JSON.stringify(criterion.observation.result, null, 2)}</pre></details>
    {/if}
    {#if criterion?.condition}<details><summary>Decision rule</summary><pre>{JSON.stringify(criterion.condition, null, 2)}</pre></details>{/if}
    <details><summary>Source and applicability</summary>
      <p>{decision.run.sourcePath}</p><p>Revision {decision.run.sourceRevision}</p>
      {#if criterion?.applicability}<p>{criterion.applicability.description}</p><pre>{JSON.stringify(criterion.applicability, null, 2)}</pre>{/if}
    </details>
    <details><summary>Full recorded proof</summary><pre>{JSON.stringify(decision, null, 2)}</pre></details>
  {:else}
    <p role="status">Reading the recorded decision…</p>
  {/if}
</main>

<style>
  main { height: 100vh; overflow: auto; padding: 18px; color: var(--element-active-color); background: var(--container-background-color); }
  header p, h1 { margin: 0 0 8px; }
  h1 { font-size: 20px; } h2 { font-size: 15px; }
  section, details { margin: 16px 0; }
  .note, small { color: var(--element-neutral-color); font-size: 12px; }
  small { display: block; margin-top: 4px; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 8px; border-bottom: 1px solid var(--border-divider-color); vertical-align: top; }
  th { font-weight: 600; }
  summary { cursor: pointer; font-weight: 600; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
</style>

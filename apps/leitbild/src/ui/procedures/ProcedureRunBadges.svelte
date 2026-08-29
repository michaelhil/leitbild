<script lang="ts">
  import {
    procedureRunSummaryText,
    procedureRunSummaryTitle,
    type ProcedureRunSummary,
    type ProcedureRunSummaryGroup,
  } from './procedure-run-selectors.ts'

  interface Props {
    readonly summaries: ProcedureRunSummaryGroup
    readonly openProcedureId?: string | null
    readonly mode?: 'inline' | 'rail'
    readonly ariaLabel?: string
    readonly onOpen?: (summary: ProcedureRunSummary) => void | Promise<void>
  }

  let {
    summaries,
    openProcedureId = null,
    mode = 'inline',
    ariaLabel = 'Procedure run status',
    onOpen = () => undefined,
  }: Props = $props()

  const hasSummaries = $derived(summaries.active.length > 0 || summaries.completed.length > 0)

  const handleOpen = (event: MouseEvent, summary: ProcedureRunSummary): void => {
    event.stopPropagation()
    void onOpen(summary)
  }
</script>

{#if hasSummaries}
  <span class="procedure-run-badges {mode}" aria-label={ariaLabel}>
    {#each summaries.active as summary, index (summary.run.runId)}
      <button
        type="button"
        class="procedure-run-badge active"
        class:open={summary.procedureId === openProcedureId}
        title={procedureRunSummaryTitle(summary)}
        onpointerdown={(event) => event.stopPropagation()}
        onclick={(event) => handleOpen(event, summary)}
      >
        {procedureRunSummaryText(summary)}
      </button>
      {#if index < summaries.active.length - 1}<span class="procedure-run-comma">,</span>{/if}
    {/each}
    {#if summaries.completed.length > 0}
      <span class="procedure-run-completed-group">
        {#if summaries.active.length > 0}<span>&nbsp;</span>{/if}
        {#each summaries.completed as summary, index (summary.run.runId)}
          <button
            type="button"
            class="procedure-run-badge completed"
            class:open={summary.procedureId === openProcedureId}
            title={procedureRunSummaryTitle(summary)}
            onpointerdown={(event) => event.stopPropagation()}
            onclick={(event) => handleOpen(event, summary)}
          >
            {procedureRunSummaryText(summary)}
          </button>
          {#if index < summaries.completed.length - 1}<span class="procedure-run-comma">,</span>{/if}
        {/each}
      </span>
    {/if}
  </span>
{/if}

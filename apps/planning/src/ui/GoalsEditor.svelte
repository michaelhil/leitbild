<script lang="ts">
  import type { Edit } from '../plan/edit-schema.ts'
  import { draftOf, goalRows, goalsEditOf, goalsFromDraft, goalsLabel, moved, sameGoals, type GoalDraft } from './goals-editor.ts'
  import type { Goal } from './model.ts'
  import type { Context } from './status-text.ts'

  // The goals, in order, as the planner sets them: move a goal up or down, change its threshold or its step,
  // then preview the change like any other edit. Hard rules are not goals and are never traded here.
  // "Restore the goal order" puts back the goals as they were before the first change saved this session.
  let { context, earlier = null, busy = false, onPreview }: {
    context: Context
    /** The goals before the first goal change saved this session; null when there was none. */
    earlier?: readonly Goal[] | null
    busy?: boolean
    onPreview: (edits: readonly Edit[], label: string) => void
  } = $props()

  const saved = $derived(context.inputs.goals)
  // svelte-ignore state_referenced_locally
  let draft = $state<readonly GoalDraft[]>(draftOf(context.inputs.goals))
  let problems = $state<readonly string[]>([])
  const rows = $derived(goalRows(draft, saved, context))
  const built = $derived(goalsFromDraft(draft, saved, context))
  const changed = $derived(!built.ok || !sameGoals(built.goals, saved))
  const restorable = $derived(earlier !== null && !sameGoals(earlier, saved))

  const set = (index: number, field: 'threshold' | 'step', value: string): void => {
    draft = draft.map((row, at) => at === index ? { ...row, [field]: value } : row)
  }
  const preview = (): void => {
    if (!built.ok) { problems = built.problems; return }
    problems = []
    onPreview(goalsEditOf(built.goals), goalsLabel(built.goals, context))
  }
</script>

<section class="goals-editor" aria-labelledby="goals-editor-title">
  <h3 id="goals-editor-title">Goals, in order</h3>
  <p class="hint">Generate compares options on the first goal, then the next. A step makes smaller differences count as equal.</p>
  <ol class="goal-rows">
    {#each rows as row (draft[row.index]!.from)}
      <li class="goal-row">
        <div class="goal-text">
          <strong>{row.short}</strong>
          <span class="hint">{row.full}.</span>
        </div>
        <div class="goal-move" role="group" aria-label="Move {row.short}">
          <button type="button" class="quiet" disabled={busy || row.index === 0} aria-label="Move {row.short} up" onclick={() => { draft = moved(draft, row.index, -1) }}>↑ Up</button>
          <button type="button" class="quiet" disabled={busy || row.index === rows.length - 1} aria-label="Move {row.short} down" onclick={() => { draft = moved(draft, row.index, 1) }}>↓ Down</button>
        </div>
        <div class="field-pair goal-fields">
          {#if row.thresholdUnit !== null}
            <label>Threshold ({row.thresholdUnit})<input inputmode="decimal" value={draft[row.index]!.threshold ?? ''} oninput={(event) => set(row.index, 'threshold', event.currentTarget.value)} disabled={busy} /></label>
          {/if}
          <label>Step ({row.stepUnit})<input inputmode="decimal" value={draft[row.index]!.step} oninput={(event) => set(row.index, 'step', event.currentTarget.value)} disabled={busy} /></label>
        </div>
      </li>
    {/each}
  </ol>
  <div class="actions">
    <button type="button" disabled={busy || !changed} onclick={preview}>Preview the goal change</button>
    {#if changed}<button type="button" class="quiet" disabled={busy} onclick={() => { draft = draftOf(saved); problems = [] }}>Discard these changes</button>{/if}
    {#if restorable && earlier !== null}
      <button type="button" disabled={busy} onclick={() => onPreview(goalsEditOf(earlier), goalsLabel(earlier, context, 'Restore the goal order'))}>Restore the goal order</button>
    {/if}
  </div>
  {#if restorable}<p class="hint">Restore puts back the goals as they were before your first goal change in this session, through the preview.</p>{/if}
  {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
  <p class="hint">After a change, Generate again; “Compare with the earlier options” then says what differs.</p>
</section>

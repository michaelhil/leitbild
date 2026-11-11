<script lang="ts">
  import { goalChoiceWords, planEdits, type GoalChoice, type PlanForm } from './edit-forms.ts'

  // A new plan from empty: name, window, site time zone and goal order. The plan's own currency comes
  // from the Workspace, so the goals are sent once the plan exists.
  let { busy = false, defaultZone, defaultStart, defaultEnd, onCreate, onCancel }: {
    busy?: boolean
    defaultZone: string
    defaultStart: string
    defaultEnd: string
    onCreate: (form: PlanForm) => void
    onCancel: () => void
  } = $props()

  // svelte-ignore state_referenced_locally
  let timeZone = $state(defaultZone)
  // svelte-ignore state_referenced_locally
  let windowStart = $state(defaultStart)
  // svelte-ignore state_referenced_locally
  let windowEnd = $state(defaultEnd)
  let title = $state('')
  let goals = $state<GoalChoice[]>(['finish', 'extra-cost'])
  let problems = $state<readonly string[]>([])
  const all: readonly GoalChoice[] = ['finish', 'extra-cost', 'unavailable-hours', 'lateness']
  // Every zone the browser knows, so the site zone is chosen, never typed.
  // svelte-ignore state_referenced_locally
  const zones = [...new Set([defaultZone, ...Intl.supportedValuesOf('timeZone')])].sort()

  const move = (index: number, by: -1 | 1) => {
    const other = index + by
    if (other < 0 || other >= goals.length) return
    const next = [...goals]
    ;[next[index], next[other]] = [next[other]!, next[index]!]
    goals = next
  }
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const built = planEdits({ title, timeZone, windowStart, windowEnd, goals })
    if (!built.ok) { problems = built.problems; return }
    problems = []
    onCreate({ title, timeZone, windowStart, windowEnd, goals })
  }
</script>

<form class="mini-form new-plan" onsubmit={submit}>
  <h2>New plan</h2>
  <label>Name<input bind:value={title} placeholder="e.g. Week 47 maintenance" /></label>
  <label>Site time zone
    <select bind:value={timeZone}>{#each zones as zone (zone)}<option value={zone}>{zone.replaceAll('_', ' ')}</option>{/each}</select>
  </label>
  <div class="field-pair">
    <label>Window starts<input type="datetime-local" bind:value={windowStart} /></label>
    <label>Window ends<input type="datetime-local" bind:value={windowEnd} /></label>
  </div>
  <fieldset>
    <legend>Goals, most important first</legend>
    <ol class="goal-order">
      {#each goals as goal, index (goal)}
        <li>{goalChoiceWords[goal]}
          <button type="button" class="quiet" disabled={index === 0} onclick={() => move(index, -1)} aria-label="Move {goalChoiceWords[goal]} up">↑</button>
          <button type="button" class="quiet" disabled={index === goals.length - 1} onclick={() => move(index, 1)} aria-label="Move {goalChoiceWords[goal]} down">↓</button>
          <button type="button" class="quiet" disabled={goals.length === 1} onclick={() => { goals = goals.filter(item => item !== goal) }}>Remove</button>
        </li>
      {/each}
    </ol>
    {#each all.filter(goal => !goals.includes(goal)) as goal (goal)}
      <button type="button" class="quiet" onclick={() => { goals = [...goals, goal] }}>Add “{goalChoiceWords[goal]}”</button>
    {/each}
  </fieldset>
  <div class="actions">
    <button type="submit" class="primary" disabled={busy}>Create the plan</button>
    <button type="button" onclick={onCancel}>Cancel</button>
  </div>
  {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
</form>

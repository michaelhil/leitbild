<script lang="ts">
  import type { Edit } from '../plan/edit-schema.ts'
  import { dueMoveEdit, localInputValue } from './edit-forms.ts'
  import MarkTag from './MarkTag.svelte'
  import RuleForm from './RuleForm.svelte'
  import { ruleView, settingViews } from './rules-text.ts'
  import { goalOrderText, type Context } from './status-text.ts'

  // Hard rules in words with their kind and source; the window and one-at-a-time crews as settings;
  // the goals as an ordered policy. Rules are never offered as a trade.
  let { context, busy = false, onPreview }: { context: Context; busy?: boolean; onPreview: (edits: readonly Edit[], label: string) => void } = $props()
  const rules = $derived(context.inputs.rules.map(rule => ruleView(rule, context)))
  const settings = $derived(settingViews(context))
  const goals = $derived(goalOrderText(context.inputs.goals, context))
  let moving = $state<string | null>(null)
  let movedTo = $state('')
  let problems = $state<readonly string[]>([])
  const move = (key: string, words: string) => {
    const built = dueMoveEdit(key, movedTo, context.inputs)
    if (!built.ok) { problems = built.problems; return }
    problems = []
    moving = null
    onPreview(built.edits, `Move the due time of “${words}”`)
  }
  const sourceTone = (shape: string) => shape === '△' ? 'assumption' : shape === '◉' ? 'world' : 'plain'
</script>

<section class="rules" aria-labelledby="rules-title">
  <h2 id="rules-title">Rules</h2>
  <p class="hint">Hard rules always hold. Generate never trades them against goals; changing or removing one needs someone's agreement.</p>
  {#if rules.length === 0}<p class="hint">No rules yet.</p>{/if}
  <ul class="rule-list">
    {#each rules as rule (rule.key)}
      <li id="item-rule-{rule.key}" tabindex="-1">
        <p><MarkTag mark={rule.mark} tone="rule" /> <strong>{rule.kind}.</strong> {rule.words}</p>
        <p class="hint">{rule.covers}</p>
        <p class="hint"><MarkTag mark={rule.source.mark} tone={sourceTone(rule.source.mark.shape)} />{rule.source.note ? ` ${rule.source.note}` : ''}</p>
        <button type="button" class="quiet" disabled={busy} onclick={() => onPreview([{ edit: 'remove', what: 'rule', key: rule.key }], `Remove the rule “${rule.words}”`)}>Remove…</button>
        {#if rule.due !== null}
          {#if moving === rule.key}
            <form class="mini-form" onsubmit={(event) => { event.preventDefault(); move(rule.key, rule.words) }}>
              <label>New latest finish ({context.format.zone})<input type="datetime-local" bind:value={movedTo} /></label>
              <p class="hint">Moving it later weakens the rule: the preview asks who agreed and why.</p>
              <div class="actions"><button type="submit" disabled={busy}>Preview</button><button type="button" onclick={() => { moving = null }}>Cancel</button></div>
              {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
            </form>
          {:else}
            <button type="button" class="quiet" disabled={busy} onclick={() => { moving = rule.key; movedTo = localInputValue(rule.due!, context.format.zone) }}>Move the due time…</button>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
  <h3>Settings</h3>
  <ul class="rule-list">
    {#each settings as setting, index (index)}<li><MarkTag mark={setting.mark} /> <strong>{setting.name}:</strong> {setting.text}</li>{/each}
  </ul>
  <h3>Goals, in order</h3>
  <ol class="goal-order">{#each goals as goal (goal)}<li>{goal.replace(/^\d+\. /, '')}</li>{/each}</ol>
  <RuleForm {context} {busy} {onPreview} />
</section>

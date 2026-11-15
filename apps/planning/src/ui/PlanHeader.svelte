<script lang="ts">
  import Choice from './Choice.svelte'
  import type { GenerateInput } from './api.ts'
  import { crewHourPurchases, requestLabel } from './request.ts'
  import type { Context } from './status-text.ts'

  // The plan's decision context in three lines, and the one action as a toolbar: the method choice, "days
  // only" as a what-if, Generate, and Cancel while it runs. The plan's size is one short line; how the
  // certified size was measured opens on request.
  let { context, title, size, generating = false, busy = false, onGenerate, onCancel }: {
    context: Context
    title: string
    /** "Plan size: 33 jobs · certified up to 33, …" and the measurement behind the certified size. */
    size: { line: string; evidence: string } | null
    generating?: boolean
    busy?: boolean
    onGenerate: (input: GenerateInput) => void
    onCancel: () => void
  } = $props()

  const settings = $derived(context.inputs.settings)
  let daysOnly = $state(false)
  // Every method starts at "Let Generate choose", so the choice always shows a selected answer.
  // svelte-ignore state_referenced_locally
  let fixed = $state<Record<string, string>>(Object.fromEntries(context.inputs.methods.map(method => [method.key, ''])))

  const generate = () => {
    const methods = context.inputs.methods
    const chosen = methods.flatMap(method => fixed[method.key] ? [{ choice: method.key, option: fixed[method.key]! }] : [])
    const buy = daysOnly ? { buy: 'no-extra-crew-hours' as const } : {}
    if (chosen.length > 0) {
      const labels = chosen.map(item => methods.find(method => method.key === item.choice)?.options.find(option => option.key === item.option)?.label ?? 'Chosen method')
      onGenerate({ variants: [{ label: requestLabel(labels, daysOnly), methods: chosen, ...buy }] })
    } else if (daysOnly && methods.length > 0) {
      const method = methods[0]!
      onGenerate({ variants: method.options.map(option => ({ label: requestLabel([option.label], true), methods: [{ choice: method.key, option: option.key }], ...buy })) })
    } else if (daysOnly) {
      onGenerate({ variants: [{ label: requestLabel([], true), ...buy }] })
    } else onGenerate({})
  }
</script>

<header class="plan-header">
  <div class="title-row">
    <h1>{title}</h1>
    <div class="generate" role="group" aria-label="Generate">
      {#each context.inputs.methods as method (method.key)}
        <Choice label={method.label} bind:value={() => fixed[method.key] ?? '', next => { fixed[method.key] = next }} disabled={generating} options={[{ value: '', label: 'Let Generate choose' }, ...method.options.map(option => ({ value: option.key, label: option.label }))]} />
      {/each}
      <!-- Offered only when the plan has crew hours that can be bought, which "days only" would exclude. -->
      {#if crewHourPurchases(context.inputs).length > 0}
        <label class="inline days-only" title="Rebookings and tool days stay allowed"><input type="checkbox" bind:checked={daysOnly} disabled={generating} /> Days only: no overtime or night crews</label>
      {/if}
      {#if generating}
        <button type="button" onclick={onCancel}>Cancel</button><span class="hint" aria-live="polite">Generating… Cancel keeps the best plan found so far.</span>
      {:else}
        <button type="button" class="primary" disabled={busy} onclick={generate}>Generate</button>
      {/if}
    </div>
  </div>
  {#if settings.purpose}<p class="purpose">{settings.purpose}</p>{/if}
  <div class="context-line hint">
    <span>
      {#if settings.window}Window {context.format.when(settings.window.start)} to {context.format.when(settings.window.end)}{:else}No window yet{/if}
      {#if settings.dataDate} · Now {context.format.clock(settings.dataDate)}{/if}
      · {context.format.zoneSet ? `Times in ${context.format.zone}` : 'Times in UTC until the site time zone is set'}
    </span>
    {#if size}
      <span class="plan-size">{size.line}</span>
      <details class="size-evidence"><summary>How the size was measured</summary><p>{size.evidence}</p></details>
    {/if}
  </div>
</header>

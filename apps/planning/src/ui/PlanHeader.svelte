<script lang="ts">
  import type { GenerateInput } from './api.ts'
  import type { Context } from './status-text.ts'

  // The plan's decision context and the one action: Generate, with "days only" and a fixed method as
  // what-ifs, and Cancel while it runs. The certified size is said in words beside it.
  let { context, title, certified, generating = false, busy = false, onGenerate, onCancel }: {
    context: Context
    title: string
    certified: string | null
    generating?: boolean
    busy?: boolean
    onGenerate: (input: GenerateInput) => void
    onCancel: () => void
  } = $props()

  const settings = $derived(context.inputs.settings)
  let daysOnly = $state(false)
  let fixed = $state<Record<string, string>>({})

  const generate = () => {
    const methods = context.inputs.methods
    const chosen = methods.flatMap(method => fixed[method.key] ? [{ choice: method.key, option: fixed[method.key]! }] : [])
    const buy = daysOnly ? { buy: 'no-extra-crew-hours' as const } : {}
    const daysWords = daysOnly ? ', days only' : ''
    if (chosen.length > 0) {
      const label = chosen.map(item => methods.find(method => method.key === item.choice)?.options.find(option => option.key === item.option)?.label ?? 'Chosen method').join(', ')
      onGenerate({ variants: [{ label: `${label}${daysWords}`, methods: chosen, ...buy }] })
    } else if (daysOnly && methods.length > 0) {
      const method = methods[0]!
      onGenerate({ variants: method.options.map(option => ({ label: `${option.label}${daysWords}`, methods: [{ choice: method.key, option: option.key }], ...buy })) })
    } else if (daysOnly) {
      onGenerate({ variants: [{ label: 'Days only', ...buy }] })
    } else onGenerate({})
  }
</script>

<header class="plan-header">
  <div class="title-block">
    <h1>{title}</h1>
    {#if settings.purpose}<p class="purpose">{settings.purpose}</p>{/if}
    <p class="hint">
      {#if settings.window}Window {context.format.when(settings.window.start)} to {context.format.when(settings.window.end)}{:else}No window yet{/if}
      {#if settings.dataDate} · Now {context.format.clock(settings.dataDate)}{/if}
      · {context.format.zoneSet ? `Times in ${context.format.zone}` : 'Times in UTC until the site time zone is set'}
    </p>
  </div>
  <div class="generate">
    <label class="inline"><input type="checkbox" bind:checked={daysOnly} disabled={generating} /> Days only: no overtime or night crews (rebookings and tool days stay allowed)</label>
    {#each context.inputs.methods as method (method.key)}
      <label>{method.label}
        <select bind:value={fixed[method.key]} disabled={generating}>
          <option value="">Let Generate choose</option>
          {#each method.options as option (option.key)}<option value={option.key}>{option.label}</option>{/each}
        </select>
      </label>
    {/each}
    <div class="actions">
      {#if generating}
        <button type="button" onclick={onCancel}>Cancel</button><span class="hint" aria-live="polite">Generating… Cancel keeps the best plan found so far.</span>
      {:else}
        <button type="button" class="primary" disabled={busy} onclick={generate}>Generate</button>
      {/if}
    </div>
    {#if certified}<p class="hint">{certified}</p>{/if}
  </div>
</header>

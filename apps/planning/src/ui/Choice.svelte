<script lang="ts">
  // A choice made with plain clicks and keys. A native select element opens an operating-system menu that some
  // browsers' automation and embedded panes cannot reach (maint's walk T0p-11), so the screen uses none:
  // a few options are radio buttons; a longer list opens in place as buttons, narrowed by typing.
  let { label, options, value = $bindable(), placeholder = 'Choose…', disabled = false }: {
    label: string
    options: ReadonlyArray<{ readonly value: string; readonly label: string }>
    value: string
    placeholder?: string
    disabled?: boolean
  } = $props()

  const id = $props.id()
  let open = $state(false)
  let filter = $state('')
  const current = $derived(options.find(option => option.value === value))
  const shown = $derived(filter.trim() === '' ? options : options.filter(option => option.label.toLowerCase().includes(filter.trim().toLowerCase())))
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') open = false }
  const choose = (next: string) => {
    value = next
    open = false
    filter = ''
  }
</script>

{#if options.length <= 4}
  <fieldset class="choice radios" {disabled}>
    <legend>{label}</legend>
    {#each options as option (option.value)}
      <label class="inline"><input type="radio" name={id} value={option.value} checked={option.value === value} onchange={() => choose(option.value)} /> {option.label}</label>
    {/each}
  </fieldset>
{:else}
  <div class="choice list" role="group" aria-labelledby="{id}-label">
    <span class="choice-label" id="{id}-label">{label}</span>
    <button type="button" class="choice-current" aria-expanded={open} aria-controls="{id}-options" {disabled} onclick={() => { open = !open }} onkeydown={escape}>{current?.label ?? placeholder} <span aria-hidden="true">{open ? '▴' : '▾'}</span></button>
    {#if open}
      <div class="choice-options" id="{id}-options">
        {#if options.length > 8}<input aria-label="Narrow the list of {label.toLowerCase()}" placeholder="Type to narrow the list" bind:value={filter} onkeydown={escape} />{/if}
        <ul>
          {#each shown.slice(0, 60) as option (option.value)}
            <li><button type="button" aria-pressed={option.value === value} onclick={() => choose(option.value)} onkeydown={escape}>{option.label}</button></li>
          {/each}
        </ul>
        {#if shown.length > 60}<p class="hint">{shown.length - 60} more: type to narrow the list.</p>{/if}
        {#if shown.length === 0}<p class="hint">Nothing matches.</p>{/if}
      </div>
    {/if}
  </div>
{/if}

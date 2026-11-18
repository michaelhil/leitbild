<script lang="ts">
  import { runOnMount } from '../../../ui/svelte-lifecycle.svelte.ts'

  interface DecisionAction {
    readonly label: string
    readonly run: () => void
    readonly disabled?: boolean
    readonly reason?: string
    readonly danger?: boolean
  }

  interface Props {
    readonly title: string
    readonly text: string
    readonly actions: readonly DecisionAction[]
    readonly cancel: () => void
  }

  const { title, text, actions, cancel }: Props = $props()
  const id = $props.id()
  let dialog: HTMLDialogElement
  let cancelButton: HTMLButtonElement

  runOnMount(() => {
    dialog.showModal()
    cancelButton.focus()
    return () => { if (dialog.open) dialog.close() }
  })

  const choose = (action: () => void): void => {
    dialog.close()
    action()
  }

  const escape = (event: Event): void => {
    event.preventDefault()
    choose(cancel)
  }
</script>

<dialog
  bind:this={dialog}
  aria-modal="true"
  aria-labelledby={`${id}-title`}
  aria-describedby={`${id}-text`}
  oncancel={escape}
  onkeydown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}
>
  <h2 id={`${id}-title`}>{title}</h2>
  <p id={`${id}-text`}>{text}</p>
  <div class="choices">
    {#each actions as action (action.label)}
      <div class="choice">
        <button
          type="button"
          class:danger={action.danger}
          disabled={action.disabled}
          onclick={() => choose(action.run)}
        >{action.label}</button>
        {#if action.reason !== undefined}<p>{action.reason}</p>{/if}
      </div>
    {/each}
  </div>
  <footer>
    <button bind:this={cancelButton} type="button" onclick={() => choose(cancel)}>Cancel</button>
  </footer>
</dialog>

<style>
  dialog {
    box-sizing: border-box;
    width: min(410px, calc(100% - 32px));
    max-height: calc(100dvh - 32px);
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--panel);
    color: var(--text);
  }

  dialog::backdrop { background: rgb(0 0 0 / 45%); }
  h2 { margin: 0 0 6px; font-size: 17px; line-height: 1.3; overflow-wrap: anywhere; }
  p { margin: 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .choices { display: grid; gap: 8px; margin-top: 16px; }
  .choice button { width: 100%; text-align: left; }
  .choice p { margin-top: 4px; font-size: 12px; }
  footer { display: flex; justify-content: flex-end; margin-top: 12px; }

  button {
    min-height: 44px;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    color: inherit;
    cursor: pointer;
    font: inherit;
  }

  button:hover:enabled { border-color: var(--accent); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  button.danger { color: var(--critical); }
</style>

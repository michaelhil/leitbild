<script lang="ts">
  import { tick } from 'svelte'

  interface Props {
    readonly disabled?: boolean
    readonly submit: (prompt: string) => Promise<void>
  }

  let { disabled = false, submit }: Props = $props()
  let dialog = $state<HTMLDialogElement | null>(null)
  let input = $state<HTMLTextAreaElement | null>(null)
  let prompt = $state('')
  let busy = $state(false)
  let error = $state('')

  const open = async (): Promise<void> => {
    error = ''
    dialog?.showModal()
    await tick()
    input?.focus()
  }

  const send = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    const content = prompt.trim()
    if (busy || content.length === 0) return
    busy = true
    error = ''
    try {
      await submit(content)
      prompt = ''
      dialog?.close()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally { busy = false }
  }

  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      input?.form?.requestSubmit()
    }
  }
</script>

<button
  class="assistant-launch"
  type="button"
  {disabled}
  aria-label="Open Leitbild Assistant"
  title={disabled ? 'Leitbild Assistant is unavailable' : 'Ask Leitbild Assistant'}
  onclick={() => void open()}
>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3zm6 11l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z"/></svg>
</button>

<dialog class="assistant-dialog" bind:this={dialog} onclose={() => { error = '' }}>
  <form onsubmit={send}>
    <header>
      <div><span>Leitbild Assistant</span><h2>How can I help?</h2></div>
      <button class="assistant-close" type="button" aria-label="Close Assistant" disabled={busy} onclick={() => dialog?.close()}>×</button>
    </header>
    <p>Ask about Leitbild, explore the current simulation, or describe a scenario you want to create.</p>
    <textarea bind:this={input} bind:value={prompt} onkeydown={keydown} maxlength="64000" rows="6" placeholder="Make an ambulance and weather scenario centred on Trondheim that escalates after two minutes…"></textarea>
    {#if error}<p class="assistant-error" role="alert">{error}</p>{/if}
    <footer><span>Enter to send · Shift+Enter for a new line</span><button class="primary" type="submit" disabled={busy || prompt.trim().length === 0}>{busy ? 'Opening…' : 'Ask Assistant'}</button></footer>
  </form>
</dialog>

<script lang="ts">
  let {
    path,
    title,
    revision,
  }: { path: string; title: string; revision: string } = $props()
  let dialog = $state<HTMLDialogElement | null>(null)
  let message = $state(''),
    quote = $state(''),
    error = $state('')
  let busy = $state(false),
    receipt = $state<number | null>(null)
  let target = $state({ path: '', title: '', revision: '', section: '' })
  const open = () => {
    message = ''
    target = { path, title, revision, section: location.hash }
    quote = window.getSelection()?.toString() ?? ''
    error = ''
    receipt = null
    dialog?.showModal()
  }
  const submit = async () => {
    if (busy || receipt !== null) return
    busy = true
    error = ''
    try {
      const response = await fetch('/api/system/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Wiki feedback: ${target.title}`.slice(0, 200),
          description: `Document: ${target.path}\nKnowledge revision: ${target.revision}\nSection: ${target.section || '(page)'}\n\nSelected text:\n${quote || '(none)'}\n\nFeedback:\n${message.trim()}`,
        }),
      })
      const body = await response.json()
      if (response.status === 429)
        throw new Error(
          'Too many submissions. Please wait before trying again; your draft is still here.',
        )
      if (!response.ok)
        throw new Error(
          response.status === 503
            ? 'The feedback service is currently unavailable. Your draft is still here; please try later.'
            : response.status === 400 || response.status === 413
              ? 'Please shorten your feedback or quoted text and try again.'
              : 'We could not confirm submission. Your draft is still here. It may have arrived; please avoid immediately resubmitting.',
        )
      if (
        response.status !== 201 ||
        body.ok !== true ||
        !Number.isSafeInteger(body.number) ||
        body.number < 1
      )
        throw new Error(
          'We did not receive a valid submission receipt. Your draft is still here.',
        )
      receipt = body.number
      message = ''
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'We could not confirm submission. Your draft is still here.'
    } finally {
      busy = false
    }
  }
</script>

<button class="feedback-link" onclick={open}>Feedback</button>
<dialog
  bind:this={dialog}
  aria-labelledby="feedback-title"
  oncancel={(event) => {
    if (busy) event.preventDefault()
  }}
>
  <header>
    <h2 id="feedback-title">Feedback on this page</h2>
    <button
      aria-label="Close feedback"
      disabled={busy}
      onclick={() => dialog?.close()}>✕</button
    >
  </header>
  {#if receipt !== null}
    <section role="status" class="success">
      <h3>Thank you — your feedback was submitted.</h3>
      <p>Confirmed receipt #{receipt}.</p>
      <button onclick={() => dialog?.close()}>Done</button>
    </section>
  {:else}
    <form
      onsubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p class="page-title">{target.title}</p>
      <p class="privacy">
        Feedback is recorded in a public issue tracker. Please do not include
        passwords, personal information, or private simulation data.
      </p>
      <label
        >Your feedback<textarea
          bind:value={message}
          required
          maxlength="6000"
          rows="7"
          disabled={busy}
          placeholder="What should we improve or correct?"
        ></textarea></label
      >
      {#if quote}<label
          >Selected text<textarea
            bind:value={quote}
            rows="3"
            disabled={busy}
          ></textarea></label
        >{/if}
      {#if error}<p role="alert" class="error">{error}</p>{/if}
      <div class="actions">
        <button type="button" disabled={busy} onclick={() => dialog?.close()}
          >Cancel</button
        ><button type="submit" disabled={busy || !message.trim()}
          >{busy ? 'Submitting…' : 'Submit feedback'}</button
        >
      </div>
    </form>
  {/if}
</dialog>

<style>
  .feedback-link {
    margin-left: auto;
    flex-shrink: 0;
    font: inherit;
    font-size: 0.8rem;
    color: #276144;
    border: 0;
    background: transparent;
    cursor: pointer;
    padding: 0.35rem 0.5rem;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  dialog {
    width: min(580px, 92vw);
    max-height: 90vh;
    border: 1px solid #b8cbbd;
    border-radius: 12px;
    padding: 0;
    color: #24372e;
    background: #fbfdfa;
    box-shadow: 0 25px 90px #10261a66;
  }
  dialog::backdrop {
    background: #12231b99;
    backdrop-filter: blur(3px);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.3rem;
    border-bottom: 1px solid #dce6df;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0;
  }
  form,
  .success {
    padding: 1.3rem;
  }
  .page-title {
    font-weight: 650;
    margin-top: 0;
  }
  .privacy {
    font-size: 0.82rem;
    line-height: 1.5;
    color: #617366;
  }
  label {
    display: block;
    font-size: 0.9rem;
    font-weight: 600;
    margin: 1rem 0;
  }
  textarea {
    display: block;
    box-sizing: border-box;
    width: 100%;
    margin-top: 0.5rem;
    padding: 0.7rem;
    border: 1px solid #bccdc0;
    border-radius: 7px;
    font: inherit;
    font-weight: 400;
    resize: vertical;
    background: white;
    color: #24372e;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
  }
  button {
    font: inherit;
    cursor: pointer;
    padding: 0.5rem 0.8rem;
    border: 1px solid #bccdc0;
    border-radius: 6px;
    background: #fff;
    color: #28583a;
  }
  button[type='submit'] {
    background: #245c3c;
    color: #fff;
  }
  button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .error {
    padding: 0.8rem;
    background: #fff0eb;
    color: #8f391e;
    line-height: 1.5;
  }
  .success h3 {
    font-size: 1.1rem;
    color: #20613c;
  }
  .success p {
    font-size: 0.9rem;
  }
</style>

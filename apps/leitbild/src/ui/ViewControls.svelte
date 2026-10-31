<script lang="ts">
  import type { UiControlsOfferMessage } from '@leitbild/contracts'
  let { offer, set }: { offer: UiControlsOfferMessage | null; set: (id: string, visible: boolean) => void } = $props()
  let open = $state(false)
  let root = $state<HTMLDivElement | null>(null)
  let trigger = $state<HTMLButtonElement | null>(null)
  let panel = $state<HTMLElement | null>(null)
  let position = $state({ left: 8, top: 0, height: 0 })
  const close = (focus = false): void => { open = false; if (focus) trigger?.focus() }
  const outside = (event: PointerEvent): void => { if (open && event.target instanceof Node && !root?.contains(event.target)) close() }
  const key = (event: KeyboardEvent): void => {
    if (open && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(true) }
  }
  const focusout = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && !root?.contains(event.relatedTarget)) close()
  }
  // The offer belongs to a listening document; loss of that document closes its disclosure.
  $effect(() => { if (!offer) open = false })
  $effect(() => {
    if (!open || !trigger || !panel) return
    const button = trigger, content = panel
    const measure = (): void => {
      const bounds = button.getBoundingClientRect(), width = content.getBoundingClientRect().width
      const top = bounds.bottom + 8
      position = { left: Math.max(8, Math.min(innerWidth - width - 8, bounds.right - width)), top, height: Math.max(0, innerHeight - top - 8) }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(button); observer.observe(content); measure()
    window.addEventListener('resize', measure)
    document.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); document.removeEventListener('scroll', measure, true) }
  })
</script>

<svelte:window onpointerdown={outside} onkeydown={key} onblur={() => close()} />
<!-- Focus leaving closes the disclosure; native checkboxes keep standard keyboard behaviour. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="view-control" bind:this={root} onfocusout={focusout}>
  <button class="view-trigger" bind:this={trigger} type="button" aria-label="View" aria-describedby={offer?.notification ? 'run-view-notification' : undefined}
    aria-expanded={open} aria-controls="run-view-options" disabled={!offer} title={offer ? 'Show or hide Run panels' : 'Run view controls are loading'} onclick={() => open = !open}>
    View{#if offer?.notification && offer.notification.count > 0}<span class="notice" aria-hidden="true" title={offer.notification.label}>{offer.notification.count}</span>{/if}
  </button>
  {#if offer?.notification}<span id="run-view-notification" class="visually-hidden">{offer.notification.label}</span>{/if}
  {#if open && offer}
    <section id="run-view-options" class="view-options" aria-label="Run view" bind:this={panel} style:left={`${position.left}px`} style:top={`${position.top}px`} style:max-height={`${position.height}px`}>
      <strong>Run view</strong>
      {#each offer.controls as control (control.id)}
        <label title={control.disabledReason ?? ''}>
          <input type="checkbox" checked={control.visible} disabled={Boolean(control.disabledReason)} onclick={event => { event.preventDefault(); set(control.id, !control.visible) }} />
          <span>{control.label}{#if control.disabledReason}<small>{control.disabledReason}</small>{/if}</span>
        </label>
      {/each}
      {#if offer.notification}<p class="view-status">{offer.notification.label}</p>{/if}
    </section>
  {/if}
</div>

<style>
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .view-control { position: relative; flex: none; }
  .view-trigger { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 5px 10px; border: 1px solid rgb(255 255 255/.2); border-radius: var(--lb-r-sm); background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  .view-trigger:disabled { opacity: .5; cursor: default; }
  .notice { font-size: 11px; font-weight: 700; min-width: 18px; padding: 1px 4px; text-align: center; background: var(--lb-surface); color: var(--lb-ink); border-radius: 10px; }
  .view-options { position: fixed; z-index: 100; width: min(290px, calc(100vw - 16px)); box-sizing: border-box; overflow: auto; padding: 12px; border: 1px solid var(--lb-line); border-radius: var(--lb-r-md); background: var(--lb-surface); color: var(--lb-ink); box-shadow: var(--lb-shadow-pop); }
  .view-options strong { display: block; margin-bottom: 6px; font-size: 13px; }
  .view-options label { display: flex; gap: 9px; align-items: flex-start; padding: 8px 2px; font-size: 13px; cursor: pointer; }
  .view-options input { margin-top: 2px; accent-color: var(--lb-brand-600); }
  small { display: block; margin-top: 2px; color: var(--lb-ink-3); font-size: 11px; }
  .view-status { margin: 8px 0 0; padding-top: 8px; border-top: 1px solid var(--lb-line); font-size: 12px; color: var(--lb-ink-3); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 3px; }
  @media (pointer: coarse) { .view-trigger { min-height: 44px; }.view-options label { min-height: 44px; align-items: center; } }
</style>

<script lang="ts">
  import type { ScenarioGuidance as ScenarioGuidanceModel } from '../core/model/index.ts'

  interface Props {
    readonly guidance: ScenarioGuidanceModel
    readonly close: () => void
    readonly presented: (id: string) => void
    /** The card's bottom edge in the viewport, measured whenever its size changes: the alarm strip starts below it. */
    bottom?: number
  }

  let { guidance, close, presented, bottom = $bindable(0) }: Props = $props()
  // Laid-out offsets, not the drawn rectangle: the card is fixed, and a startup screen may still hold it off screen.
  const measure = (card: HTMLElement) => {
    presented(guidance.id)
    const observer = new ResizeObserver(() => { bottom = card.offsetTop + card.offsetHeight })
    observer.observe(card)
    return () => observer.disconnect()
  }
</script>

<aside class="scenario-guidance" data-world-disclosure aria-live="polite" {@attach measure}>
  <div>
    <strong class:update-title={guidance.tone === 'update'}>{guidance.title}</strong>
    <p>{guidance.message}</p>
  </div>
  {#if guidance.dismissible}<button type="button" aria-label="Dismiss current guidance" onkeydown={event => event.stopPropagation()} onclick={close}>×</button>{/if}
</aside>

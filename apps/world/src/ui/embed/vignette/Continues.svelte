<script lang="ts">
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame, UNFRAMED_PRESENTATION, visibleRoom, type DisplayPresentation } from '../view-host.ts'
  import type { ScrollEnds } from './scroll-ends.ts'

  // Over a drawing that scrolls (W4.3), in the frame that holds its scroller
  // (each a child of it, `data-continues` naming its way): each edge with
  // more to see fades, and a mark there says the drawing continues that way,
  // clear of the scroller's scrollbars. They stand in the part of the
  // scroller a person sees: inside every box that clips it (a band that
  // scrolls the drawing sideways) and, where a window's body shows only part
  // of the frame (a vignette taller than the window), inside that part.
  let { ends }: { ends: ScrollEnds } = $props()

  let anchor = $state<HTMLElement | null>(null)
  /** How far the part a person sees stands in from each side of the frame, its scrollbars' room included. */
  let hidden = $state.raw({ top: 0, right: 0, bottom: 0, left: 0 })
  /** Marks need a row of the scroller in sight to stand in. */
  let seen = $state(true)
  const right = $derived(Math.max(ends.bars.right, hidden.right))
  const bottom = $derived(Math.max(ends.bars.bottom, hidden.bottom))
  /** The middle of the part seen, from the frame's middle. */
  const middle = $derived((hidden.left - right) / 2)

  runOnMount(() => {
    const holder = anchor?.parentElement
    if (holder === null || holder === undefined) return () => {}
    let presentation: DisplayPresentation = UNFRAMED_PRESENTATION
    const measure = (): void => {
      const box = holder.getBoundingClientRect()
      let { left, right: end, top, bottom: foot } = box
      for (let node = holder.parentElement; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
        const clip = node.getBoundingClientRect()
        if (style.overflowX !== 'visible') { left = Math.max(left, clip.left); end = Math.min(end, clip.right) }
        if (style.overflowY !== 'visible') { top = Math.max(top, clip.top); foot = Math.min(foot, clip.bottom) }
      }
      const room = visibleRoom(presentation, { width: window.innerWidth, height: window.innerHeight })
      left = Math.max(left, room.x - window.scrollX)
      end = Math.min(end, room.x + room.width - window.scrollX)
      top = Math.max(top, room.y - window.scrollY)
      foot = Math.min(foot, room.y + room.height - window.scrollY)
      hidden = { top: Math.max(0, top - box.top), right: Math.max(0, box.right - end), bottom: Math.max(0, box.bottom - foot), left: Math.max(0, left - box.left) }
      seen = foot - top >= 32 && end - left >= 80
    }
    let frame = 0
    const later = (): void => { if (frame === 0) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    const resized = new ResizeObserver(later)
    resized.observe(holder)
    window.addEventListener('resize', later)
    // A box that clips it scrolls (the band's drawing sideways), or the frame does.
    document.addEventListener('scroll', later, { capture: true, passive: true })
    const stop = embeddedDisplayFrame().subscribe(next => { presentation = next; later() })
    measure()
    return () => {
      stop()
      resized.disconnect()
      window.removeEventListener('resize', later)
      document.removeEventListener('scroll', later, { capture: true })
      cancelAnimationFrame(frame)
    }
  })
</script>

<span class="anchor" bind:this={anchor} aria-hidden="true"></span>
{#if seen && ends.left}
  <span class="fade sideways" aria-hidden="true" style:left={`${hidden.left}px`} style:top={`${hidden.top}px`} style:bottom={`${bottom}px`} style:background="linear-gradient(to left, transparent, var(--container-background-color))"></span>
  <span class="continues" data-continues="left" aria-hidden="true" style:left={`${hidden.left + 4}px`} style:top={`${hidden.top + 4}px`}>‹ drawing continues</span>
{/if}
{#if seen && ends.right}
  <span class="fade sideways" aria-hidden="true" style:right={`${right}px`} style:top={`${hidden.top}px`} style:bottom={`${bottom}px`} style:background="linear-gradient(to right, transparent, var(--container-background-color))"></span>
  <span class="continues" data-continues="right" aria-hidden="true" style:right={`${right + 4}px`} style:top={`${hidden.top + 4}px`}>drawing continues ›</span>
{/if}
{#if seen && ends.top}
  <span class="fade along" aria-hidden="true" style:top={`${hidden.top}px`} style:left={`${hidden.left}px`} style:right={`${right}px`} style:background="linear-gradient(to top, transparent, var(--container-background-color))"></span>
  <span class="continues middle" data-continues="up" aria-hidden="true" style:left={`calc(50% + ${middle}px)`} style:top={`${hidden.top + 4}px`}>drawing continues ↑</span>
{/if}
{#if seen && ends.bottom}
  <span class="fade along" aria-hidden="true" style:bottom={`${bottom}px`} style:left={`${hidden.left}px`} style:right={`${right}px`} style:background="linear-gradient(to bottom, transparent, var(--container-background-color))"></span>
  <span class="continues middle" data-continues="down" aria-hidden="true" style:left={`calc(50% + ${middle}px)`} style:bottom={`${bottom + 4}px`}>drawing continues ↓</span>
{/if}

<style>
  .anchor { position: absolute; width: 0; height: 0; }
  .fade { position: absolute; z-index: 1; pointer-events: none; }
  .fade.sideways { width: 32px; }
  .fade.along { height: 32px; }
  .continues { position: absolute; z-index: 2; padding: 0 8px; border: 1px solid var(--border-outline-color); border-radius: 12px; background: var(--container-background-color); color: var(--element-active-color); font-size: 12px; line-height: 20px; white-space: nowrap; pointer-events: none; }
  /* Up and down in the middle of the part seen, clear of the marks for left and right. */
  .continues.middle { transform: translateX(-50%); }
</style>

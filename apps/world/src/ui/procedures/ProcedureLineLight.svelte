<script lang="ts">
  import { procedurePlantTime } from './procedure-run-selectors.ts'
  import type { ProcedureLightRow, ProcedureLightTone } from './procedure-view.ts'

  // One procedure line with its light. Hover, focus, click and tap all open the same readings;
  // a click or tap holds them open until Escape, a second press or a press elsewhere.

  interface Props {
    readonly text: string
    /** Lights read only the current step. On any other the line shows no state. */
    readonly live: boolean
    readonly tone: ProcedureLightTone
    readonly rows: ReadonlyArray<ProcedureLightRow>
    readonly openTag: (tagId: string) => void
  }

  let { text, live, tone, rows, openTag }: Props = $props()

  const words: Readonly<Record<ProcedureLightTone, string>> = { supported: 'Met', contradicted: 'Not met', unknown: 'No valid reading', waiting: 'Waiting' }
  const glyphs: Readonly<Record<ProcedureLightTone, string>> = { supported: '✓', contradicted: '×', unknown: '–', waiting: '' }
  const HOVER_OPEN_MS = 120
  const HOVER_CLOSE_MS = 220

  let open = $state(false)
  let held = $state(false)
  let place = $state('')
  let button = $state<HTMLButtonElement | null>(null)
  let panel = $state<HTMLElement | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  const show = (hold: boolean): void => {
    clearTimeout(timer)
    open = true
    held = hold
  }
  const hide = (refocus = false): void => {
    clearTimeout(timer)
    open = false
    held = false
    if (refocus) button?.focus({ preventScroll: true })
  }
  const later = (action: () => void, ms: number): void => {
    clearTimeout(timer)
    timer = setTimeout(action, ms)
  }

  // Below the line where it fits, else above it, and always wholly on screen. The narrow layout docks it instead, by stylesheet.
  const position = (): void => {
    if (!button || !panel) return
    const anchor = button.getBoundingClientRect()
    const size = panel.getBoundingClientRect()
    const left = Math.min(window.innerWidth - size.width - 8, Math.max(8, anchor.left - 4))
    const below = anchor.bottom + 6
    const above = anchor.top - 6 - size.height
    const top = below + size.height <= window.innerHeight - 8 ? below : above >= 8 ? above : Math.max(8, window.innerHeight - size.height - 8)
    place = `left: ${left}px; top: ${top}px;`
  }
  $effect(() => {
    if (open && panel) position()
  })

  $effect(() => {
    if (!open) return
    const pressElsewhere = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!button?.contains(target) && !panel?.contains(target)) hide()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      hide(true)
    }
    window.addEventListener('pointerdown', pressElsewhere, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', position)
    return () => {
      window.removeEventListener('pointerdown', pressElsewhere, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', position)
    }
  })
  $effect(() => () => clearTimeout(timer))

  const hasLimit = $derived(rows.some(row => row.limit !== undefined))
  const readAt = $derived(rows.find(row => row.sampledAt !== undefined)?.sampledAt)
</script>

<div class="procedure-lit-line">
  {#if live}
    <button
      bind:this={button}
      type="button"
      class="procedure-light"
      aria-label="{text} {words[tone]}. Show readings."
      aria-expanded={open}
      aria-haspopup="dialog"
      onmouseenter={() => later(() => show(held), HOVER_OPEN_MS)}
      onmouseleave={() => { if (!held) later(hide, HOVER_CLOSE_MS) }}
      onfocus={(event) => { if (event.currentTarget.matches(':focus-visible')) show(held) }}
      onblur={(event) => { if (!held && !panel?.contains(event.relatedTarget as Node | null)) hide() }}
      onclick={() => { if (open && held) hide(); else show(true) }}
    ><span class="procedure-light-dot {tone}" aria-hidden="true">{glyphs[tone]}</span></button>
  {:else}
    <span class="procedure-light"><span class="procedure-light-dot idle" aria-hidden="true"></span></span>
  {/if}
  <span class="procedure-lit-text">{text}</span>
  {#if open}
    <div
      bind:this={panel}
      class="procedure-readings"
      role="dialog"
      tabindex="-1"
      aria-label="Readings for {text}"
      style={place}
      onmouseenter={() => clearTimeout(timer)}
      onmouseleave={() => { if (!held) later(hide, HOVER_CLOSE_MS) }}
    >
      <div class="procedure-readings-head">
        <b>{words[tone]}</b>
        <button type="button" class="procedure-readings-close" aria-label="Close readings" onclick={() => hide(true)}>×</button>
      </div>
      <table>
        <thead><tr><th>Reading</th><th>Value</th>{#if hasLimit}<th>Limit</th>{/if}<th>Quality</th></tr></thead>
        <tbody>
          {#each rows as row, index (index)}
            <tr>
              <td><button type="button" class="procedure-basis-link" onclick={() => openTag(row.tagId)}>{row.name}</button></td>
              <td class="procedure-readings-value"><span class="procedure-readings-state {row.state}" aria-hidden="true">{glyphs[row.state]}</span> {row.value}</td>
              {#if hasLimit}<td>{row.limit ?? ''}</td>{/if}
              <td>{row.quality}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if readAt}<small>Read at {procedurePlantTime(readAt)} plant time.</small>{/if}
    </div>
  {/if}
</div>

<script lang="ts">
  // What a screen window (`screen=<id>`) shows of itself, in three states:
  // - badge: its letter, its name and a Fullscreen button, small in a corner
  //   over the page it shows;
  // - Identify: the letter large over everything for a few seconds, when the
  //   Screens panel asks every screen to say which one it is;
  // - Standby: the letter large and why the screen shows nothing, with at
  //   most one link.
  // Fullscreen needs a press inside the window itself; a refusal is said here.
  import { onDestroy, untrack } from 'svelte'
  import type { StandbyText } from './screen-follow.ts'

  let { id, name, identify, standby, notice }: {
    id: string
    /** The screen's name in this browser's setup, or null where the setup does not hold it. */
    name: string | null
    /** Counts the Identify calls this window received. */
    identify: number
    standby: StandbyText | null
    /** Something the person should know about this screen, e.g. that it cannot follow the others. */
    notice: string | null
  } = $props()

  /** How long the letter stays large after Identify. */
  const IDENTIFY_MS = 4_000

  let identifying = $state(false)
  let fullscreen = $state(document.fullscreenElement !== null)
  let refusal = $state<string | null>(null)
  let identifyTimer: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    if (identify === 0) return
    untrack(() => {
      identifying = true
      clearTimeout(identifyTimer)
      identifyTimer = setTimeout(() => { identifying = false }, IDENTIFY_MS)
    })
  })
  onDestroy(() => clearTimeout(identifyTimer))

  const toggleFullscreen = async (): Promise<void> => {
    refusal = null
    try {
      if (document.fullscreenElement !== null) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch (cause) {
      refusal = `Fullscreen was refused: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
</script>

<svelte:document onfullscreenchange={() => { fullscreen = document.fullscreenElement !== null }} />

{#snippet fullscreenButton()}
  <button type="button" disabled={!document.fullscreenEnabled} title={document.fullscreenEnabled ? undefined : 'This browser offers no fullscreen here'}
    onclick={() => void toggleFullscreen()}>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>
{/snippet}

{#if standby}
  <section class="screen-standby" aria-label={`Screen ${id}, standby`}>
    <span class="screen-letter" aria-hidden="true">{id}</span>
    <p class="screen-name">Screen {id}{name === null ? '' : ` · ${name}`}</p>
    <p class="screen-why" role="status">{standby.why}</p>
    {#if standby.link}<a class="lb-btn" href={standby.link.href}>{standby.link.label}</a>{/if}
    {#if notice}<p class="screen-notice">{notice}</p>{/if}
    {#if refusal}<p class="screen-notice" role="alert">{refusal}</p>{/if}
    {@render fullscreenButton()}
  </section>
{:else}
  <aside class="screen-badge" aria-label={`Screen ${id}`}>
    <span class="screen-badge-letter" aria-hidden="true">{id}</span>
    {#if name !== null}<span class="screen-badge-name" title={name}>{name}</span>{/if}
    {#if notice}<span class="screen-badge-notice" title={notice}>Not following</span>{/if}
    {#if refusal}<span class="screen-badge-notice" role="alert">{refusal}</span>{/if}
    {@render fullscreenButton()}
  </aside>
{/if}
{#if identifying}
  <div class="screen-identify" role="status">
    <span class="screen-letter">{id}</span>
    {#if name !== null}<span class="screen-name">{name}</span>{/if}
  </div>
{/if}

<script lang="ts">
  let { navigation, pitch, bearing, onnavigation, ontilt, onturn, onfit, onhome, element = $bindable<HTMLElement | null>(null) }: {
    navigation: 'pan' | 'orbit'; pitch: number; bearing: number; onnavigation: (tool: 'pan' | 'orbit') => void; ontilt: (degrees: number) => void; onturn: (degrees: number) => void; onfit: () => void; onhome: () => void; element?: HTMLElement | null
  } = $props()
  let expanded = $state(false)
  export const dismiss = (): boolean => { if (!expanded) return false; expanded = false; return true }
  const fit = (): void => { expanded = false; onfit() }
  const home = (): void => { expanded = false; onhome() }
</script>
<section class="camera-controls" aria-label="3D navigation" bind:this={element}>
  {#if expanded}<section class="camera-sheet" aria-label="Tilt and turn"><header><strong>Tilt and turn</strong><button type="button" aria-label="Close tilt and turn" onclick={() => expanded = false}>×</button></header><p>Tilt {pitch.toFixed(0)}° · heading {bearing.toFixed(0)}°</p><div class="camera-grid"><button type="button" onclick={() => onturn(-15)}>Turn left</button><button type="button" onclick={() => onturn(15)}>Turn right</button><button type="button" onclick={() => onturn(-bearing)}>North</button><button type="button" onclick={() => ontilt(-90)}>Top view</button><button type="button" onclick={home}>Oblique home</button><button type="button" onclick={fit}>Fit selection</button></div><p>Orbit turns around the focused physical area. Pan moves the view. Native gestures and keyboard arrows also remain available.</p></section>{/if}
  <div class="camera-primary"><button type="button" aria-pressed={navigation === 'pan'} onclick={() => onnavigation('pan')}>Pan</button><button type="button" aria-pressed={navigation === 'orbit'} onclick={() => onnavigation('orbit')}>Orbit</button><button type="button" aria-label="Tilt down" onclick={() => ontilt(-10)}><span>Tilt</span>−</button><button type="button" aria-label="Tilt up" onclick={() => ontilt(10)}><span>Tilt</span>+</button><button type="button" onclick={home}>Home</button></div>
  <button class="expand" type="button" aria-expanded={expanded} onclick={() => expanded = !expanded}>Tilt and turn {expanded ? '▴' : '▾'}</button>
</section>
<style>
  .camera-controls { position: absolute; right: 12px; bottom: 46px; width: min(324px, calc(100% - 24px)); box-sizing: border-box; z-index: 5; padding: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); font: inherit; font-size: 12px; pointer-events: auto; }
  button { min-width: 44px; min-height: 44px; box-sizing: border-box; border: 1px solid var(--border); border-radius: 6px; color: inherit; background: var(--panel); font: inherit; cursor: pointer; }button[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); background: var(--panel-strong); font-weight: 700; }button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .camera-primary { display: flex; gap: 4px; }.camera-primary > button { flex: 1; padding: 4px; }.camera-primary > button span { display: block; font-size: 10px; }.expand { margin-top: 4px; width: 100%; }
  .camera-sheet { position: absolute; bottom: 100%; left: 0; right: 0; display: grid; gap: 6px; margin-bottom: 6px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); max-height: 50dvh; overflow: auto; }.camera-sheet header { display: flex; align-items: center; justify-content: space-between; }.camera-sheet header button { font-size: 20px; }.camera-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }.camera-sheet p { color: var(--muted); line-height: 1.5; font-size: 11px; }
  @container (max-width: 440px) { .camera-controls { right: 8px; width: calc(100% - 16px); } }
</style>

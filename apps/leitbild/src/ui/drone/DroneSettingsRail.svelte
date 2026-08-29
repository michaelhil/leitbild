<script lang="ts">
  import { Activity, Crosshair, Gamepad2, GripVertical, Keyboard, LocateFixed, MousePointer2, PanelRightClose, PanelRightOpen, PlaneLanding, RotateCcw } from 'lucide-svelte'
  import type { OperationalObject } from '../../core/model/index.ts'
  import type { DroneManualAxes, DroneSensorContact } from '../../packs/drone/model.ts'
  import IconButton from '../components/IconButton.svelte'
  import type { DroneScenePerformanceSnapshot } from './drone-performance.ts'
  import {
    formatKeyCode,
    type DroneKeyBindingAction,
    type DroneKeyBindingDefinition,
    type DroneKeyBindingMap,
  } from './drone-key-bindings.ts'

  interface GamepadOption {
    readonly index: number
    readonly id: string
  }

  interface Props {
    readonly collapsed: boolean
    readonly selectedDroneId: string
    readonly droneObjects: ReadonlyArray<OperationalObject>
    readonly liveAxes: DroneManualAxes
    readonly flightBindingDefinitions: ReadonlyArray<DroneKeyBindingDefinition>
    readonly cameraBindingDefinitions: ReadonlyArray<DroneKeyBindingDefinition>
    readonly keyBindings: DroneKeyBindingMap
    readonly bindingCaptureAction: DroneKeyBindingAction | null
    readonly scenePerformance: DroneScenePerformanceSnapshot | null
    readonly lastCommandRoundTripMs: number | null
    readonly commandRateHz: number
    readonly mouseControlEnabled: boolean
    readonly mouseCaptured: boolean
    readonly gamepads: ReadonlyArray<GamepadOption>
    readonly selectedGamepadIndex: number | null
    readonly sensorContacts: ReadonlyArray<DroneSensorContact>
    readonly targetOptions: ReadonlyArray<OperationalObject>
    readonly selectedTargetId: string
    readonly onToggleCollapsed: () => void
    readonly onStartResize: (event: PointerEvent) => void
    readonly onSelectDrone: (event: Event) => void
    readonly onCaptureBinding: (action: DroneKeyBindingAction) => void
    readonly onResetKeyBindings: () => void
    readonly onToggleMouseControl: () => void
    readonly onRequestMouseCapture: () => void
    readonly onCenterMouseStick: () => void
    readonly onSelectGamepad: (event: Event) => void
    readonly onSetMode: (mode: 'hold' | 'land' | 'return_to_launch') => Promise<void>
    readonly onSelectTarget: (event: Event) => void
    readonly onAttackTarget: () => Promise<void>
  }

  let {
    collapsed,
    selectedDroneId,
    droneObjects,
    liveAxes,
    flightBindingDefinitions,
    cameraBindingDefinitions,
    keyBindings,
    bindingCaptureAction,
    scenePerformance,
    lastCommandRoundTripMs,
    commandRateHz,
    mouseControlEnabled,
    mouseCaptured,
    gamepads,
    selectedGamepadIndex,
    sensorContacts,
    targetOptions,
    selectedTargetId,
    onToggleCollapsed,
    onStartResize,
    onSelectDrone,
    onCaptureBinding,
    onResetKeyBindings,
    onToggleMouseControl,
    onRequestMouseCapture,
    onCenterMouseStick,
    onSelectGamepad,
    onSetMode,
    onSelectTarget,
    onAttackTarget,
  }: Props = $props()
</script>

<div class="drone-control-shell" class:collapsed>
  {#if collapsed}
    <button
      class="control-panel-reopen"
      type="button"
      aria-label="Open drone settings rail"
      title="Open drone settings rail"
      onclick={onToggleCollapsed}
    >
      <PanelRightOpen size={18} />
    </button>
  {:else}
    <button
      class="control-panel-resize"
      type="button"
      aria-label="Resize drone settings rail"
      title="Resize drone settings rail"
      data-window-control
      onpointerdown={onStartResize}
    >
      <GripVertical size={16} />
    </button>
    <aside class="drone-control-panel">
      <div class="control-panel-toolbar">
        <IconButton label="Collapse drone settings rail" icon={PanelRightClose} variant="ghost" onClick={onToggleCollapsed} />
      </div>

      <section>
        <h3><LocateFixed size={15} /> Drone</h3>
        <select value={selectedDroneId} aria-label="Controlled drone" onchange={onSelectDrone}>
          {#each droneObjects as droneObject (droneObject.id)}
            <option value={droneObject.id}>{droneObject.label}</option>
          {/each}
        </select>
      </section>

      <section>
        <h3><Keyboard size={15} /> Manual</h3>
        <div class="axis-grid">
          <span>FWD {liveAxes.forward.toFixed(2)}</span>
          <span>RIGHT {liveAxes.right.toFixed(2)}</span>
          <span>VERT {liveAxes.vertical.toFixed(2)}</span>
          <span>YAW {liveAxes.yaw.toFixed(2)}</span>
        </div>
      </section>

      <section>
        <h3><Keyboard size={15} /> Keys</h3>
        <div class="key-binding-grid">
          {#each flightBindingDefinitions as binding (binding.action)}
            <button
              class:capturing={bindingCaptureAction === binding.action}
              type="button"
              onclick={() => onCaptureBinding(binding.action)}
            >
              <span>{binding.label}</span>
              <strong>{bindingCaptureAction === binding.action ? 'Press key' : formatKeyCode(keyBindings[binding.action])}</strong>
            </button>
          {/each}
        </div>
        <div class="key-binding-grid compact">
          {#each cameraBindingDefinitions as binding (binding.action)}
            <button
              class:capturing={bindingCaptureAction === binding.action}
              type="button"
              onclick={() => onCaptureBinding(binding.action)}
            >
              <span>{binding.label}</span>
              <strong>{bindingCaptureAction === binding.action ? 'Press key' : formatKeyCode(keyBindings[binding.action])}</strong>
            </button>
          {/each}
          <button type="button" onclick={onResetKeyBindings}>
            <span>Reset</span>
            <strong>Defaults</strong>
          </button>
        </div>
      </section>

      <section>
        <h3><Activity size={15} /> Performance</h3>
        <div class="perf-grid">
          <span>FPS {scenePerformance ? Math.round(scenePerformance.fps) : '-'}</span>
          <span>P95 {scenePerformance ? Math.round(scenePerformance.frameP95Ms) : '-'} ms</span>
          <span>CPU {scenePerformance ? scenePerformance.frameCpuMs.toFixed(1) : '-'} ms</span>
          <span>RDR {scenePerformance ? scenePerformance.renderMs.toFixed(1) : '-'} ms</span>
          <span>JANK {scenePerformance ? Math.round(scenePerformance.jankPercent) : '-'}%</span>
          <span>DRAW {scenePerformance ? scenePerformance.drawCalls : '-'}</span>
          <span>TRI {scenePerformance ? Math.round(scenePerformance.triangles / 1000) : '-'}k</span>
          <span>GEO {scenePerformance ? scenePerformance.geometries : '-'}</span>
          <span>PR {scenePerformance ? scenePerformance.pixelRatio.toFixed(2) : '-'}</span>
          <span>QL {scenePerformance?.quality ?? '-'}</span>
          <span>SCN {scenePerformance ? scenePerformance.activeScenes : '-'}</span>
          <span>RTT {lastCommandRoundTripMs === null ? '-' : Math.round(lastCommandRoundTripMs)} ms</span>
          <span>CMD {commandRateHz.toFixed(1)} Hz</span>
          <span>LOD {scenePerformance?.worldFeatures.sceneryStage ?? '-'}</span>
          <span>TILE {scenePerformance ? scenePerformance.worldFeatures.tiles : '-'}</span>
          <span>POLY {scenePerformance ? scenePerformance.worldFeatures.polygons : '-'}</span>
          <span>BLD {scenePerformance ? scenePerformance.worldFeatures.buildings : '-'}</span>
          <span>RD {scenePerformance ? scenePerformance.worldFeatures.roads : '-'}</span>
          <span>RDT {scenePerformance ? scenePerformance.worldFeatures.roadOverlayTiles : '-'}</span>
          <span>RDP {scenePerformance ? scenePerformance.worldFeatures.roadOverlayPendingTiles : '-'}</span>
          <span>RTRI {scenePerformance ? Math.round(scenePerformance.worldFeatures.roadOverlayTriangles / 1000) : '-'}k</span>
          <span>RMB {scenePerformance ? Math.round(scenePerformance.worldFeatures.roadOverlayBytes / 1_000_000) : '-'}</span>
          <span>WTR {scenePerformance ? scenePerformance.worldFeatures.water : '-'}</span>
          <span>VEG {scenePerformance ? scenePerformance.worldFeatures.vegetation : '-'}</span>
          <span>LBL {scenePerformance ? scenePerformance.worldFeatures.roadLabels : '-'}</span>
          <span>SRC {scenePerformance?.worldSource ?? '-'}</span>
          <span>MAP {scenePerformance?.worldFeatures.scenerySource ?? '-'}</span>
          <span>TRN {scenePerformance?.worldFeatures.terrain ?? '-'}</span>
          <span>DEM {scenePerformance?.worldFeatures.terrainSurface ?? '-'}</span>
          <span>LOAD {scenePerformance ? Math.round(scenePerformance.worldLoadMs) : '-'} ms</span>
          <span>BUILD {scenePerformance ? Math.round(scenePerformance.worldBuildMs) : '-'} ms</span>
        </div>
      </section>

      <section>
        <h3><MousePointer2 size={15} /> Mouse</h3>
        <div class="command-grid">
          <button class:active={mouseControlEnabled} type="button" onclick={onToggleMouseControl}><MousePointer2 size={15} /> {mouseControlEnabled ? 'On' : 'Enable'}</button>
          <button type="button" disabled={!mouseControlEnabled} onclick={onRequestMouseCapture}><LocateFixed size={15} /> Capture</button>
          <button type="button" onclick={onCenterMouseStick}><RotateCcw size={15} /> Center</button>
        </div>
        <span class="mouse-status">{mouseCaptured ? 'Pointer locked' : mouseControlEnabled ? 'Click scene to fly' : 'Disabled'}</span>
      </section>

      <section>
        <h3><Gamepad2 size={15} /> Controller</h3>
        <select value={selectedGamepadIndex === null ? '' : String(selectedGamepadIndex)} aria-label="Gamepad" onchange={onSelectGamepad}>
          <option value="">Keyboard</option>
          {#each gamepads as pad (pad.index)}
            <option value={pad.index}>{pad.id}</option>
          {/each}
        </select>
      </section>

      <section>
        <h3><LocateFixed size={15} /> Mode</h3>
        <div class="command-grid">
          <button type="button" onclick={() => void onSetMode('hold')}><LocateFixed size={15} /> Hold</button>
          <button type="button" onclick={() => void onSetMode('land')}><PlaneLanding size={15} /> Land</button>
          <button type="button" onclick={() => void onSetMode('return_to_launch')}><RotateCcw size={15} /> Return</button>
        </div>
      </section>

      <section>
        <h3><Crosshair size={15} /> Sensors</h3>
        <div class="contact-list">
          {#each sensorContacts as contact (`${contact.sensorId}:${contact.targetId}`)}
            <span>{contact.targetLabel} · {Math.round(contact.distanceM)} m · {Math.round(contact.confidence * 100)}%</span>
          {:else}
            <span>No contacts</span>
          {/each}
        </div>
      </section>

      <section>
        <h3><Crosshair size={15} /> Effect</h3>
        <select value={selectedTargetId} aria-label="Target object" onchange={onSelectTarget}>
          <option value="">Target</option>
          {#each targetOptions as target (target.id)}
            <option value={target.id}>{target.label}</option>
          {/each}
        </select>
        <button type="button" disabled={!selectedTargetId} onclick={() => void onAttackTarget()}><Crosshair size={15} /> Apply</button>
      </section>
    </aside>
  {/if}
</div>

<style>
  .drone-control-shell {
    position: relative;
    min-width: 0;
    min-height: 0;
    background: #0b1120;
    border-left: 1px solid rgb(148 163 184 / 0.2);
  }

  .drone-control-shell.collapsed {
    display: grid;
    place-items: start center;
    padding-top: 10px;
  }

  .control-panel-reopen,
  .control-panel-resize {
    border: 1px solid rgb(148 163 184 / 0.28);
    background: #1e293b;
    color: #e2e8f0;
  }

  .control-panel-reopen {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 34px;
  }

  .control-panel-resize {
    position: absolute;
    left: -7px;
    top: 0;
    z-index: 2;
    display: grid;
    place-items: center;
    width: 13px;
    height: 100%;
    padding: 0;
    border-top: 0;
    border-bottom: 0;
    cursor: col-resize;
    opacity: 0.68;
    touch-action: none;
  }

  .control-panel-resize:hover,
  .control-panel-resize:focus-visible {
    opacity: 1;
    border-color: #60a5fa;
  }

  .control-panel-toolbar {
    display: flex;
    justify-content: flex-end;
    min-width: 0;
  }

  .drone-control-panel {
    display: grid;
    align-content: start;
    gap: 12px;
    height: 100%;
    box-sizing: border-box;
    padding: 12px;
    overflow: auto;
    background: #0b1120;
  }

  .drone-control-panel section {
    display: grid;
    gap: 8px;
  }

  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: #e5e7eb;
    font-size: 12px;
    letter-spacing: 0;
  }

  .axis-grid,
  .key-binding-grid,
  .perf-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    font-size: 12px;
    color: #cbd5e1;
  }

  .perf-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .axis-grid span,
  .perf-grid span {
    min-width: 0;
    padding: 6px;
    overflow: hidden;
    background: #111827;
    border: 1px solid rgb(148 163 184 / 0.18);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .key-binding-grid.compact {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .key-binding-grid button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px;
    align-items: center;
    justify-content: initial;
    min-width: 0;
    padding: 5px 7px;
    text-align: left;
  }

  .key-binding-grid button.capturing {
    border-color: #facc15;
    background: #334155;
  }

  .key-binding-grid button span,
  .key-binding-grid button strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .key-binding-grid button span {
    color: #cbd5e1;
  }

  .key-binding-grid button strong {
    color: #f8fafc;
    font-weight: 700;
  }

  .contact-list {
    display: grid;
    gap: 5px;
    color: #cbd5e1;
    font-size: 12px;
  }

  .mouse-status {
    color: #93c5fd;
    font-size: 12px;
  }

  .contact-list span {
    min-width: 0;
    padding: 6px;
    overflow: hidden;
    border: 1px solid rgb(148 163 184 / 0.18);
    background: #111827;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  .command-grid button,
  .drone-control-panel section > button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 9px;
    border: 1px solid rgb(148 163 184 / 0.28);
    background: #1e293b;
    color: #e2e8f0;
    font: inherit;
  }

  .drone-control-panel button.active {
    background: #2563eb;
    border-color: #60a5fa;
  }

  .drone-control-panel select {
    width: 100%;
    min-height: 30px;
    padding: 0 8px;
    border: 1px solid rgb(148 163 184 / 0.28);
    background: #1e293b;
    color: #e2e8f0;
    font: inherit;
  }

  .drone-control-panel button:disabled {
    opacity: 0.48;
  }

  @media (max-width: 720px) {
    .drone-control-shell {
      border-top: 1px solid rgb(148 163 184 / 0.2);
      border-left: 0;
    }

    .drone-control-panel {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      max-height: 270px;
    }

    .control-panel-resize {
      display: none;
    }

    .command-grid {
      align-items: stretch;
    }
  }

  @media (max-width: 460px) {
    .drone-control-panel {
      grid-template-columns: 1fr;
      max-height: 300px;
    }
  }
</style>

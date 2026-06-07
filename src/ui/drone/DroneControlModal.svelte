<script lang="ts">
  import { Crosshair, Gamepad2, Keyboard, LocateFixed, PlaneLanding, RotateCcw, X } from 'lucide-svelte'
  import type { ControlInstanceId, ObjectId, OperationalObject } from '../../core/model/index.ts'
  import {
    attackCommandKind,
    manualControlCommandKind,
    setDroneModeCommandKind,
  } from '../../packs/drone/commands.ts'
  import { dronePackDataSchema, type DroneManualAxes } from '../../packs/drone/model.ts'
  import { droneSensorContacts } from '../../packs/drone/query.ts'
  import { sendControlInstanceCommand } from '../control-instance-client.ts'
  import IconButton from '../components/IconButton.svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import { createDroneScene, type DroneSceneHandle, type DroneSceneViewMode } from './drone-scene.ts'

  interface Props {
    readonly controlInstanceId: ControlInstanceId
    readonly object: OperationalObject
    readonly objects: ReadonlyArray<OperationalObject>
    readonly windowOffsetIndex?: number
    readonly close: () => void
  }

  let {
    controlInstanceId,
    object,
    objects,
    windowOffsetIndex = 0,
    close,
  }: Props = $props()

  const viewportMargin = 12
  const offsetStepPx = 28
  const sendIntervalMs = 180
  const activeKeepaliveMs = 360
  const deadband = 0.08
  const zeroAxes: DroneManualAxes = { forward: 0, right: 0, vertical: 0, yaw: 0 }

  let sceneElement = $state<HTMLDivElement | null>(null)
  let sceneHandle: DroneSceneHandle | null = null
  let viewMode = $state<DroneSceneViewMode>('3d')
  let status = $state('Opening flight view')
  let gamepads = $state<ReadonlyArray<{ readonly index: number; readonly id: string }>>([])
  let selectedGamepadIndex = $state<number | null>(null)
  let gamepadSelectionLocked = false
  let selectedTargetId = $state<string>('')
  let liveAxes = $state<DroneManualAxes>(zeroAxes)
  let keys = new Set<string>()
  let lastSendMs = 0
  let lastAxesSignature = '0.00|0.00|0.00|0.00'
  let manualSendInFlight = false
  let animationId = 0

  const data = $derived.by(() => {
    const parsed = dronePackDataSchema.safeParse(object.packData)
    return parsed.success ? parsed.data : null
  })
  const groundSpeedMps = $derived(data ? Math.hypot(data.kinematics.velocityEastMps, data.kinematics.velocityNorthMps) : 0)
  const batteryPercent = $derived(data ? data.energy.remainingWh / data.profile.energy.capacityWh * 100 : 0)
  const sensorContacts = $derived(droneSensorContacts(objects).filter(contact => contact.droneId === object.id).slice(0, 4))

  const windowStyle = $derived.by(() => {
    const offset = windowOffsetIndex * offsetStepPx
    if (typeof window === 'undefined') {
      return `left:${72 + offset}px;top:${72 + offset}px;width:1120px;height:720px`
    }
    const availableWidth = window.innerWidth - 2 * viewportMargin - offset
    const availableHeight = window.innerHeight - 2 * viewportMargin - offset
    const width = Math.min(1180, Math.max(280, availableWidth))
    const height = Math.min(760, Math.max(420, availableHeight))
    const left = Math.max(viewportMargin, Math.round((window.innerWidth - width) / 2) + offset)
    const top = Math.max(viewportMargin, Math.round((window.innerHeight - height) / 2) + offset)
    return `left:${left}px;top:${top}px;width:${width}px;height:${height}px`
  })

  const targetOptions = $derived(objects.filter(candidate => candidate.id !== object.id && (
    candidate.spatial.position?.point !== undefined || candidate.spatial.geometry?.type === 'Point'
  )))

  const refreshGamepads = (): void => {
    if (!navigator.getGamepads) {
      gamepads = []
      selectedGamepadIndex = null
      return
    }
    const connected = navigator.getGamepads()
      .filter((pad): pad is Gamepad => pad !== null)
      .map(pad => ({ index: pad.index, id: pad.id || `Gamepad ${pad.index + 1}` }))
    gamepads = connected
    if (!gamepadSelectionLocked && selectedGamepadIndex === null && connected[0]) selectedGamepadIndex = connected[0].index
    if (selectedGamepadIndex !== null && !connected.some(pad => pad.index === selectedGamepadIndex)) {
      selectedGamepadIndex = gamepadSelectionLocked ? null : connected[0]?.index ?? null
    }
  }

  const selectGamepad = (event: Event): void => {
    gamepadSelectionLocked = true
    const value = event.currentTarget instanceof HTMLSelectElement ? event.currentTarget.value : ''
    const index = Number.parseInt(value, 10)
    selectedGamepadIndex = value === '' || Number.isNaN(index) ? null : index
  }

  const axis = (value: number): number =>
    Math.abs(value) < deadband ? 0 : Math.max(-1, Math.min(1, value))

  const keyboardAxes = (): DroneManualAxes => ({
    forward: (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) + (keys.has('KeyS') || keys.has('ArrowDown') ? -1 : 0),
    right: (keys.has('KeyD') ? 1 : 0) + (keys.has('KeyA') ? -1 : 0),
    vertical: (keys.has('Space') ? 1 : 0) + (keys.has('ShiftLeft') || keys.has('ShiftRight') ? -1 : 0),
    yaw: (keys.has('KeyE') || keys.has('ArrowRight') ? 1 : 0) + (keys.has('KeyQ') || keys.has('ArrowLeft') ? -1 : 0),
  })

  const gamepadAxes = (): DroneManualAxes | null => {
    if (selectedGamepadIndex === null || !navigator.getGamepads) return null
    const pad = navigator.getGamepads()[selectedGamepadIndex]
    if (!pad) return null
    const leftX = axis(pad.axes[0] ?? 0)
    const leftY = axis(pad.axes[1] ?? 0)
    const rightX = axis(pad.axes[2] ?? 0)
    const climb = pad.buttons[7]?.value ?? 0
    const descend = pad.buttons[6]?.value ?? 0
    return {
      forward: axis(-leftY),
      right: leftX,
      vertical: axis(climb - descend),
      yaw: rightX,
    }
  }

  const combinedAxes = (): DroneManualAxes => {
    const keyboard = keyboardAxes()
    const gamepad = gamepadAxes()
    if (!gamepad) return keyboard
    return {
      forward: axis(keyboard.forward + gamepad.forward),
      right: axis(keyboard.right + gamepad.right),
      vertical: axis(keyboard.vertical + gamepad.vertical),
      yaw: axis(keyboard.yaw + gamepad.yaw),
    }
  }

  const axesSignature = (axes: DroneManualAxes): string =>
    [axes.forward, axes.right, axes.vertical, axes.yaw].map(value => value.toFixed(2)).join('|')

  const axesAreActive = (axes: DroneManualAxes): boolean =>
    Math.abs(axes.forward) > 0 || Math.abs(axes.right) > 0 || Math.abs(axes.vertical) > 0 || Math.abs(axes.yaw) > 0

  const sendManualControl = async (axes: DroneManualAxes): Promise<void> => {
    const activeGamepad = selectedGamepadIndex === null ? null : gamepads.find(pad => pad.index === selectedGamepadIndex)
    const source = activeGamepad
      ? { kind: 'gamepad' as const, gamepadIndex: activeGamepad.index, label: activeGamepad.id }
      : { kind: 'keyboard' as const, label: 'Keyboard' }
    const body = await sendControlInstanceCommand(controlInstanceId, {
      kind: manualControlCommandKind,
      targetObjectIds: [object.id],
      payload: {
        droneId: object.id,
        axes,
        inputSource: source,
        commandTtlMs: 650,
      },
    })
    status = body.result.ok ? 'Manual control accepted' : `Rejected: ${body.result.reason ?? 'unknown'}`
  }

  const sendManualControlSafely = async (axes: DroneManualAxes): Promise<void> => {
    try {
      await sendManualControl(axes)
    } catch (err) {
      status = err instanceof Error ? err.message : String(err)
    } finally {
      manualSendInFlight = false
    }
  }

  const setMode = async (mode: 'hold' | 'land' | 'return_to_launch'): Promise<void> => {
    const body = await sendControlInstanceCommand(controlInstanceId, {
      kind: setDroneModeCommandKind,
      targetObjectIds: [object.id],
      payload: {
        droneId: object.id,
        mode,
      },
    })
    status = body.result.ok ? `${mode.replaceAll('_', ' ')} accepted` : `Rejected: ${body.result.reason ?? 'unknown'}`
  }

  const attackTarget = async (): Promise<void> => {
    if (!selectedTargetId) return
    const body = await sendControlInstanceCommand(controlInstanceId, {
      kind: attackCommandKind,
      targetObjectIds: [object.id, selectedTargetId as ObjectId],
      payload: {
        attackerId: object.id,
        targetId: selectedTargetId,
      },
    })
    status = body.result.ok ? 'Attack command accepted' : `Rejected: ${body.result.reason ?? 'unknown'}`
  }

  const pollInput = (): void => {
    refreshGamepads()
    const nowMs = performance.now()
    const axes = combinedAxes()
    const signature = axesSignature(axes)
    const active = axesAreActive(axes)
    if (signature !== axesSignature(liveAxes)) liveAxes = axes
    const changed = signature !== lastAxesSignature
    const keepaliveDue = active && nowMs - lastSendMs >= activeKeepaliveMs
    if (!manualSendInFlight && (changed || keepaliveDue) && nowMs - lastSendMs >= sendIntervalMs) {
      lastSendMs = nowMs
      lastAxesSignature = signature
      manualSendInFlight = true
      void sendManualControlSafely(axes)
    }
    animationId = requestAnimationFrame(pollInput)
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.repeat) return
    if (event.code === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return
    keys.add(event.code)
  }

  const onKeyup = (event: KeyboardEvent): void => {
    keys.delete(event.code)
  }

  runOnMount(() => {
    if (!sceneElement) throw new Error('drone scene element was not mounted')
    sceneHandle = createDroneScene({
      container: sceneElement,
      focusDroneId: object.id,
      getObjects: () => objects,
      getViewMode: () => viewMode,
      onReady: () => {
        status = 'Flight view ready'
      },
      onError: message => {
        status = message
      },
    })
    refreshGamepads()
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('keyup', onKeyup)
    window.addEventListener('gamepadconnected', refreshGamepads)
    window.addEventListener('gamepaddisconnected', refreshGamepads)
    animationId = requestAnimationFrame(pollInput)
    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('keyup', onKeyup)
      window.removeEventListener('gamepadconnected', refreshGamepads)
      window.removeEventListener('gamepaddisconnected', refreshGamepads)
      sceneHandle?.destroy()
      sceneHandle = null
    }
  })
</script>

<section class="drone-window" style={windowStyle} aria-label="Drone flight window">
  <header class="drone-window-header">
    <div>
      <h2>{object.label}</h2>
      <span>{data?.profile.label ?? 'Invalid drone'} · {data?.control.mode ?? object.operational.status} · {data ? Math.round(data.energy.remainingWh / data.profile.energy.capacityWh * 100) : 0}%</span>
    </div>
    <div class="header-actions">
      <button class:active={viewMode === '3d'} type="button" title="3D view" aria-label="3D view" onclick={() => viewMode = '3d'}>3D</button>
      <button class:active={viewMode === 'fpv'} type="button" title="First-person view" aria-label="First-person view" onclick={() => viewMode = 'fpv'}>FPV</button>
      <button class:active={viewMode === '2d'} type="button" title="2D view" aria-label="2D view" onclick={() => viewMode = '2d'}>2D</button>
      <IconButton label="Close drone flight window" icon={X} onClick={close} />
    </div>
  </header>

  <div class="drone-window-body">
    <div class="scene-shell">
      <div bind:this={sceneElement} class="drone-scene"></div>
      {#if data}
        <div class="flight-hud" aria-label="Flight telemetry">
          <div class="hud-row">
            <span>ALT {Math.round(data.kinematics.altitudeM)} m</span>
            <span>SPD {groundSpeedMps.toFixed(1)} m/s</span>
            <span>BAT {Math.round(batteryPercent)}%</span>
          </div>
          <div class="hud-horizon">
            <span></span>
          </div>
          <div class="hud-row">
            <span>HDG {Math.round(data.kinematics.yawDeg)}°</span>
            <span>P {data.kinematics.pitchDeg.toFixed(1)}°</span>
            <span>R {data.kinematics.rollDeg.toFixed(1)}°</span>
          </div>
          <div class="hud-row muted">
            <span>WIND {data.environment.windSpeedMps.toFixed(1)} m/s</span>
            <span>{data.environment.precipitation}</span>
            <span>VIS {Math.round(data.environment.visibilityM / 100) / 10} km</span>
          </div>
        </div>
      {/if}
    </div>
    <aside class="drone-control-panel">
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
        <h3><Gamepad2 size={15} /> Controller</h3>
        <select value={selectedGamepadIndex === null ? '' : String(selectedGamepadIndex)} aria-label="Gamepad" onchange={selectGamepad}>
          <option value="">Keyboard</option>
          {#each gamepads as pad (pad.index)}
            <option value={pad.index}>{pad.id}</option>
          {/each}
        </select>
      </section>

      <section>
        <h3><LocateFixed size={15} /> Mode</h3>
        <div class="command-grid">
          <button type="button" onclick={() => void setMode('hold')}><LocateFixed size={15} /> Hold</button>
          <button type="button" onclick={() => void setMode('land')}><PlaneLanding size={15} /> Land</button>
          <button type="button" onclick={() => void setMode('return_to_launch')}><RotateCcw size={15} /> Return</button>
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
        <select bind:value={selectedTargetId} aria-label="Target object">
          <option value="">Target</option>
          {#each targetOptions as target (target.id)}
            <option value={target.id}>{target.label}</option>
          {/each}
        </select>
        <button type="button" disabled={!selectedTargetId} onclick={() => void attackTarget()}><Crosshair size={15} /> Apply</button>
      </section>
    </aside>
  </div>

  <footer class="drone-window-footer">{status}</footer>
</section>

<style>
  .drone-window {
    position: fixed;
    z-index: 80;
    display: grid;
    grid-template-rows: auto 1fr auto;
    box-sizing: border-box;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--border, #334155), transparent 12%);
    background: #0f172a;
    color: #e2e8f0;
    box-shadow: 0 24px 60px rgb(15 23 42 / 0.38);
  }

  .drone-window-header,
  .drone-window-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    padding: 10px 12px;
    background: #111827;
    border-bottom: 1px solid rgb(148 163 184 / 0.22);
  }

  .drone-window-footer {
    justify-content: flex-start;
    border-top: 1px solid rgb(148 163 184 / 0.22);
    border-bottom: 0;
    color: #cbd5e1;
    font-size: 12px;
  }

  h2,
  h3 {
    margin: 0;
    letter-spacing: 0;
  }

  h2 {
    font-size: 15px;
  }

  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #e5e7eb;
  }

  .drone-window-header span {
    display: block;
    margin-top: 2px;
    color: #94a3b8;
    font-size: 12px;
  }

  .header-actions,
  .command-grid {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .header-actions button,
  .command-grid button,
  .drone-control-panel button,
  .drone-control-panel select {
    min-height: 30px;
    border: 1px solid rgb(148 163 184 / 0.28);
    background: #1e293b;
    color: #e2e8f0;
    font: inherit;
  }

  .header-actions button {
    min-width: 38px;
  }

  .header-actions button.active {
    background: #2563eb;
    border-color: #60a5fa;
  }

  .drone-window-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 280px;
    min-height: 0;
  }

  .drone-scene {
    min-width: 0;
    min-height: 0;
  }

  .scene-shell {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .drone-scene {
    width: 100%;
    height: 100%;
  }

  .drone-scene :global(canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .drone-control-panel {
    display: grid;
    align-content: start;
    gap: 12px;
    padding: 12px;
    overflow: auto;
    background: #0b1120;
    border-left: 1px solid rgb(148 163 184 / 0.2);
  }

  .drone-control-panel section {
    display: grid;
    gap: 8px;
  }

  .axis-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    font-size: 12px;
    color: #cbd5e1;
  }

  .axis-grid span {
    padding: 6px;
    background: #111827;
    border: 1px solid rgb(148 163 184 / 0.18);
  }

  .contact-list {
    display: grid;
    gap: 5px;
    color: #cbd5e1;
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
    flex-wrap: wrap;
  }

  .command-grid button,
  .drone-control-panel section > button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 9px;
  }

  .drone-control-panel select {
    width: 100%;
    padding: 0 8px;
  }

  .drone-control-panel button:disabled {
    opacity: 0.48;
  }

  .flight-hud {
    position: absolute;
    left: 50%;
    bottom: 18px;
    display: grid;
    gap: 7px;
    width: min(520px, calc(100% - 32px));
    transform: translateX(-50%);
    color: #e0f2fe;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 8px rgb(2 6 23 / 0.8);
    pointer-events: none;
  }

  .hud-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .hud-row span {
    min-width: 0;
    padding: 4px 7px;
    overflow: hidden;
    border: 1px solid rgb(125 211 252 / 0.35);
    background: rgb(15 23 42 / 0.42);
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hud-row.muted {
    color: #bae6fd;
    font-size: 11px;
  }

  .hud-horizon {
    position: relative;
    height: 24px;
  }

  .hud-horizon::before,
  .hud-horizon::after {
    position: absolute;
    top: 50%;
    width: calc(50% - 34px);
    height: 1px;
    background: #facc15;
    content: '';
  }

  .hud-horizon::before {
    left: 0;
  }

  .hud-horizon::after {
    right: 0;
  }

  .hud-horizon span {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 16px;
    height: 16px;
    border-top: 2px solid #facc15;
    border-left: 2px solid #facc15;
    transform: translate(-50%, -30%) rotate(45deg);
  }

  @media (max-width: 720px) {
    .drone-window-header {
      align-items: flex-start;
      flex-wrap: wrap;
    }

    .header-actions {
      margin-left: auto;
    }

    .drone-window-body {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(260px, 1fr) auto;
      overflow: hidden;
    }

    .flight-hud {
      bottom: 10px;
      font-size: 10px;
    }

    .drone-control-panel {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      max-height: 270px;
      border-top: 1px solid rgb(148 163 184 / 0.2);
      border-left: 0;
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

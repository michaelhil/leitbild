<script lang="ts">
  import { Activity, Crosshair, Gamepad2, Keyboard, LocateFixed, MousePointer2, PlaneLanding, PlaneTakeoff, RotateCcw, X } from 'lucide-svelte'
  import type { ControlInstanceId, ObjectId, OperationalObject } from '../../core/model/index.ts'
  import {
    armDroneCommandKind,
    attackCommandKind,
    holdDroneCommandKind,
    landDroneCommandKind,
    manualControlCommandKind,
    returnToLaunchDroneCommandKind,
    takeoffDroneCommandKind,
  } from '../../packs/drone/commands.ts'
  import { dronePackDataSchema, type DroneManualAxes } from '../../packs/drone/model.ts'
  import { droneSensorContacts } from '../../packs/drone/query.ts'
  import { sendControlInstanceCommand } from '../control-instance-client.ts'
  import IconButton from '../components/IconButton.svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import {
    actionForKeyCode,
    assignDroneKeyBinding,
    defaultDroneKeyBindings,
    droneKeyBindingDefinitions,
    formatKeyCode,
    readDroneKeyBindings,
    writeDroneKeyBindings,
    type DroneKeyBindingAction,
    type DroneKeyBindingMap,
  } from './drone-key-bindings.ts'
  import { createDroneScene, type DroneSceneHandle, type DroneScenePerformanceSnapshot, type DroneSceneViewMode } from './drone-scene.ts'

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
  const sendIntervalMs = 70
  const activeKeepaliveMs = 140
  const deadband = 0.08
  const zeroAxes: DroneManualAxes = { forward: 0, right: 0, vertical: 0, yaw: 0 }
  const flightBindingDefinitions = droneKeyBindingDefinitions.filter(definition => definition.group === 'flight')
  const cameraBindingDefinitions = droneKeyBindingDefinitions.filter(definition => definition.group === 'camera')

  let sceneElement = $state<HTMLDivElement | null>(null)
  let sceneHandle: DroneSceneHandle | null = null
  let viewMode = $state<DroneSceneViewMode>('3d')
  let selectedDroneId = $state<string>('')
  let sceneStatus = $state('Opening flight view')
  let sceneryStatus = $state('Scenery idle')
  let commandStatus = $state('')
  let gamepads = $state<ReadonlyArray<{ readonly index: number; readonly id: string }>>([])
  let selectedGamepadIndex = $state<number | null>(null)
  let gamepadSelectionLocked = false
  let selectedTargetId = $state<string>('')
  let liveAxes = $state<DroneManualAxes>(zeroAxes)
  let mouseAxes = $state<DroneManualAxes>(zeroAxes)
  let mouseControlEnabled = $state(false)
  let mouseCaptured = $state(false)
  let scenePerformance = $state<DroneScenePerformanceSnapshot | null>(null)
  let keyBindings = $state<DroneKeyBindingMap>(defaultDroneKeyBindings())
  let bindingCaptureAction = $state<DroneKeyBindingAction | null>(null)
  let lastCommandRoundTripMs = $state<number | null>(null)
  let commandRateHz = $state(0)
  let keys = new Set<string>()
  let commandSendTimes: number[] = []
  let lastSendMs = 0
  let lastAxesSignature = '0.00|0.00|0.00|0.00'
  let manualSendInFlight = false
  let animationId = 0
  let lastGamepadRefreshMs = 0
  let gamepadSignature = ''

  const droneObjects = $derived(objects.filter(candidate => dronePackDataSchema.safeParse(candidate.packData).success))
  const selectedObject = $derived.by(() =>
    droneObjects.find(candidate => candidate.id === selectedDroneId)
    ?? droneObjects.find(candidate => candidate.id === object.id)
    ?? droneObjects[0]
    ?? object)
  const data = $derived.by(() => {
    const parsed = dronePackDataSchema.safeParse(selectedObject.packData)
    return parsed.success ? parsed.data : null
  })
  const groundSpeedMps = $derived(data ? Math.hypot(data.velocity.eastMps, data.velocity.northMps) : 0)
  const batteryPercent = $derived(data?.battery.remainingPercent ?? 0)
  const sensorContacts = $derived(droneSensorContacts(objects).filter(contact => contact.droneId === selectedObject.id).slice(0, 4))
  const takeoffAltitudeM = $derived(Math.max(25, Math.ceil((data?.pose.relativeAltitudeM ?? 0) + 20)))
  const footerStatus = $derived.by(() =>
    [commandStatus, sceneryStatus, sceneStatus]
      .filter(part => part.trim().length > 0)
      .join(' · '))

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

  const targetOptions = $derived(objects.filter(candidate => candidate.id !== selectedObject.id && (
    candidate.spatial.position?.point !== undefined || candidate.spatial.geometry?.type === 'Point'
  )))

  $effect(() => {
    const nextSelectedId = selectedObject.id
    if (selectedDroneId !== nextSelectedId) selectedDroneId = nextSelectedId
  })

  const selectDrone = (event: Event): void => {
    const value = event.currentTarget instanceof HTMLSelectElement ? event.currentTarget.value : ''
    const next = droneObjects.find(candidate => candidate.id === value)
    if (!next) return
    selectedDroneId = next.id
    selectedTargetId = selectedTargetId === next.id ? '' : selectedTargetId
    keys = new Set()
    mouseAxes = zeroAxes
    liveAxes = zeroAxes
    commandStatus = `Controlling ${next.label}`
  }

  const refreshGamepads = (force = false): void => {
    const nowMs = performance.now()
    if (!force && nowMs - lastGamepadRefreshMs < 350) return
    lastGamepadRefreshMs = nowMs
    if (!navigator.getGamepads) {
      if (gamepads.length > 0) gamepads = []
      if (selectedGamepadIndex !== null) selectedGamepadIndex = null
      return
    }
    const connected = navigator.getGamepads()
      .filter((pad): pad is Gamepad => pad !== null)
      .map(pad => ({ index: pad.index, id: pad.id || `Gamepad ${pad.index + 1}` }))
    const nextSignature = connected.map(pad => `${pad.index}:${pad.id}`).join('|')
    if (nextSignature !== gamepadSignature) {
      gamepads = connected
      gamepadSignature = nextSignature
    }
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

  const persistKeyBindings = (nextBindings: DroneKeyBindingMap): void => {
    keyBindings = nextBindings
    try {
      writeDroneKeyBindings(localStorage, nextBindings)
    } catch (err) {
      commandStatus = err instanceof Error ? `Key bindings not saved: ${err.message}` : `Key bindings not saved: ${String(err)}`
    }
  }

  const assignKeyBinding = (action: DroneKeyBindingAction, code: string): void => {
    const nextBindings = assignDroneKeyBinding(keyBindings, action, code)
    persistKeyBindings(nextBindings)
    bindingCaptureAction = null
    keys = new Set()
  }

  const resetKeyBindings = (): void => {
    persistKeyBindings(defaultDroneKeyBindings())
    bindingCaptureAction = null
    keys = new Set()
    commandStatus = 'Key bindings reset'
  }

  const isActionPressed = (action: DroneKeyBindingAction): boolean => {
    const code = keyBindings[action]
    return code !== '' && keys.has(code)
  }

  const keyboardAxes = (): DroneManualAxes => ({
    forward: (isActionPressed('flight.forward') ? 1 : 0) + (isActionPressed('flight.backward') ? -1 : 0),
    right: (isActionPressed('flight.right') ? 1 : 0) + (isActionPressed('flight.left') ? -1 : 0),
    vertical: (isActionPressed('flight.climb') ? 1 : 0) + (isActionPressed('flight.descend') ? -1 : 0),
    yaw: (isActionPressed('flight.yawRight') ? 1 : 0) + (isActionPressed('flight.yawLeft') ? -1 : 0),
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

  type ManualInputSourceKind = 'keyboard' | 'mouse' | 'gamepad'

  const combinedAxes = (): { readonly axes: DroneManualAxes; readonly sourceKind: ManualInputSourceKind } => {
    const keyboard = keyboardAxes()
    const mouse = mouseControlEnabled ? mouseAxes : zeroAxes
    const gamepad = gamepadAxes()
    const axes = {
      forward: axis(keyboard.forward + mouse.forward + (gamepad?.forward ?? 0)),
      right: axis(keyboard.right + mouse.right + (gamepad?.right ?? 0)),
      vertical: axis(keyboard.vertical + mouse.vertical + (gamepad?.vertical ?? 0)),
      yaw: axis(keyboard.yaw + mouse.yaw + (gamepad?.yaw ?? 0)),
    }
    const sourceKind = axesAreActive(gamepad ?? zeroAxes)
      ? 'gamepad'
      : axesAreActive(mouse)
        ? 'mouse'
        : 'keyboard'
    return { axes, sourceKind }
  }

  const axesSignature = (axes: DroneManualAxes): string =>
    [axes.forward, axes.right, axes.vertical, axes.yaw].map(value => value.toFixed(2)).join('|')

  const axesAreActive = (axes: DroneManualAxes): boolean =>
    Math.abs(axes.forward) > 0 || Math.abs(axes.right) > 0 || Math.abs(axes.vertical) > 0 || Math.abs(axes.yaw) > 0

  const recordCommandSent = (startedAtMs: number): void => {
    commandSendTimes = [...commandSendTimes, startedAtMs].filter(value => startedAtMs - value <= 2_000)
    commandRateHz = commandSendTimes.length / 2
  }

  const sendManualControl = async (axes: DroneManualAxes, sourceKind: ManualInputSourceKind): Promise<void> => {
    const startedAtMs = performance.now()
    recordCommandSent(startedAtMs)
    const activeGamepad = selectedGamepadIndex === null ? null : gamepads.find(pad => pad.index === selectedGamepadIndex)
    const source = sourceKind === 'gamepad' && activeGamepad
      ? { kind: 'gamepad' as const, gamepadIndex: activeGamepad.index, label: activeGamepad.id }
      : sourceKind === 'mouse'
        ? { kind: 'mouse' as const, label: mouseCaptured ? 'Mouse pointer lock' : 'Mouse' }
        : { kind: 'keyboard' as const, label: 'Keyboard' }
    const body = await sendControlInstanceCommand(controlInstanceId, {
      kind: manualControlCommandKind,
      targetObjectIds: [selectedObject.id],
      payload: {
        droneId: selectedObject.id,
        axes,
        inputSource: source,
        commandTtlMs: 450,
      },
    })
    lastCommandRoundTripMs = performance.now() - startedAtMs
    commandStatus = body.result.ok ? 'Manual input sent to autopilot' : `Rejected: ${body.result.reason ?? 'unknown'}`
  }

  const sendManualControlSafely = async (axes: DroneManualAxes, sourceKind: ManualInputSourceKind): Promise<void> => {
    try {
      await sendManualControl(axes, sourceKind)
    } catch (err) {
      commandStatus = err instanceof Error ? err.message : String(err)
    } finally {
      manualSendInFlight = false
    }
  }

  const setArmed = async (armed: boolean): Promise<void> => {
    const body = await sendControlInstanceCommand(controlInstanceId, {
      kind: armDroneCommandKind,
      targetObjectIds: [selectedObject.id],
      payload: {
        droneId: selectedObject.id,
        armed,
      },
    })
    commandStatus = body.result.ok ? `${armed ? 'Arm' : 'Disarm'} accepted` : `Rejected: ${body.result.reason ?? 'unknown'}`
  }

  const takeoff = async (): Promise<void> => {
    const body = await sendControlInstanceCommand(controlInstanceId, {
      kind: takeoffDroneCommandKind,
      targetObjectIds: [selectedObject.id],
      payload: {
        droneId: selectedObject.id,
        altitudeM: takeoffAltitudeM,
      },
    })
    commandStatus = body.result.ok ? `Takeoff to ${takeoffAltitudeM} m accepted` : `Rejected: ${body.result.reason ?? 'unknown'}`
  }

  const setMode = async (mode: 'hold' | 'land' | 'return_to_launch'): Promise<void> => {
    const kind = mode === 'hold'
      ? holdDroneCommandKind
      : mode === 'land'
        ? landDroneCommandKind
        : returnToLaunchDroneCommandKind
    const body = await sendControlInstanceCommand(controlInstanceId, {
      kind,
      targetObjectIds: [selectedObject.id],
      payload: {
        droneId: selectedObject.id,
      },
    })
    commandStatus = body.result.ok ? `${mode.replaceAll('_', ' ')} accepted` : `Rejected: ${body.result.reason ?? 'unknown'}`
  }

  const attackTarget = async (): Promise<void> => {
    if (!selectedTargetId) return
    const body = await sendControlInstanceCommand(controlInstanceId, {
      kind: attackCommandKind,
      targetObjectIds: [selectedObject.id, selectedTargetId as ObjectId],
      payload: {
        attackerId: selectedObject.id,
        targetId: selectedTargetId,
      },
    })
    commandStatus = body.result.ok ? 'Attack command accepted' : `Rejected: ${body.result.reason ?? 'unknown'}`
  }

  const pollInput = (): void => {
    refreshGamepads()
    const nowMs = performance.now()
    const activeCommandTimes = commandSendTimes.filter(value => nowMs - value <= 2_000)
    if (activeCommandTimes.length !== commandSendTimes.length) {
      commandSendTimes = activeCommandTimes
      commandRateHz = activeCommandTimes.length / 2
    }
    const sample = combinedAxes()
    const axes = sample.axes
    const signature = axesSignature(axes)
    const active = axesAreActive(axes)
    if (signature !== axesSignature(liveAxes)) liveAxes = axes
    const changed = signature !== lastAxesSignature
    const keepaliveDue = active && nowMs - lastSendMs >= activeKeepaliveMs
    if (!manualSendInFlight && (changed || keepaliveDue) && nowMs - lastSendMs >= sendIntervalMs) {
      lastSendMs = nowMs
      lastAxesSignature = signature
      manualSendInFlight = true
      void sendManualControlSafely(axes, sample.sourceKind)
    }
    animationId = requestAnimationFrame(pollInput)
  }

  const resetManualInputs = (): void => {
    keys = new Set()
    mouseAxes = zeroAxes
  }

  const keyboardEventTargetIsTextInput = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement

  const handleCameraKeyAction = (action: DroneKeyBindingAction | null): boolean => {
    if (action === 'camera.view3d') {
      viewMode = '3d'
      return true
    }
    if (action === 'camera.viewFpv') {
      viewMode = 'fpv'
      return true
    }
    if (action === 'camera.view2d') {
      viewMode = '2d'
      return true
    }
    return false
  }

  const handledKeyboardEvent = (event: KeyboardEvent): boolean =>
    bindingCaptureAction !== null || actionForKeyCode(keyBindings, event.code) !== null

  const onKeydown = (event: KeyboardEvent): void => {
    if (bindingCaptureAction !== null) {
      event.preventDefault()
      if (event.repeat) return
      if (event.code === 'Escape') {
        bindingCaptureAction = null
        return
      }
      if (event.code === 'Backspace' || event.code === 'Delete') {
        assignKeyBinding(bindingCaptureAction, '')
        return
      }
      assignKeyBinding(bindingCaptureAction, event.code)
      return
    }
    if (keyboardEventTargetIsTextInput(event.target)) return
    const handled = handledKeyboardEvent(event)
    if (handled) event.preventDefault()
    if (event.repeat) return
    if (event.code === 'Escape') {
      event.preventDefault()
      if (mouseCaptured) {
        document.exitPointerLock()
        return
      }
      close()
      return
    }
    const action = actionForKeyCode(keyBindings, event.code)
    if (handleCameraKeyAction(action)) return
    if (handled) keys.add(event.code)
  }

  const onKeyup = (event: KeyboardEvent): void => {
    if (keyboardEventTargetIsTextInput(event.target)) return
    if (handledKeyboardEvent(event)) event.preventDefault()
    keys.delete(event.code)
  }

  const onWindowBlur = (): void => {
    resetManualInputs()
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') resetManualInputs()
  }

  const onPointerLockChange = (): void => {
    mouseCaptured = document.pointerLockElement === sceneElement
    if (!mouseCaptured) mouseAxes = zeroAxes
  }

  const requestMouseCapture = (): void => {
    if (!mouseControlEnabled || !sceneElement) return
    try {
      sceneElement.focus()
      sceneElement.requestPointerLock()
      commandStatus = 'Mouse flight requested'
    } catch (err) {
      commandStatus = err instanceof Error ? err.message : String(err)
    }
  }

  const toggleMouseControl = (): void => {
    mouseControlEnabled = !mouseControlEnabled
    mouseAxes = zeroAxes
    if (!mouseControlEnabled && mouseCaptured) document.exitPointerLock()
    commandStatus = mouseControlEnabled ? 'Mouse flight armed; click the scene' : 'Mouse flight disabled'
  }

  const centerMouseStick = (): void => {
    mouseAxes = zeroAxes
  }

  const onScenePointerDown = (event: PointerEvent): void => {
    if (!mouseControlEnabled || event.button !== 0) return
    event.preventDefault()
    requestMouseCapture()
  }

  const onSceneWheel = (event: WheelEvent): void => {
    if (!mouseControlEnabled) return
    event.preventDefault()
    const delta = event.deltaY < 0 ? 0.18 : -0.18
    mouseAxes = {
      ...mouseAxes,
      vertical: axis(mouseAxes.vertical + delta),
    }
  }

  const onMouseMove = (event: MouseEvent): void => {
    if (!mouseCaptured || !mouseControlEnabled) return
    mouseAxes = {
      ...mouseAxes,
      forward: axis(mouseAxes.forward - event.movementY * 0.0035),
      yaw: axis(mouseAxes.yaw + event.movementX * 0.0045),
    }
  }

  const onGamepadConnectionChange = (): void => {
    refreshGamepads(true)
  }

  runOnMount(() => {
    if (!sceneElement) throw new Error('drone scene element was not mounted')
    try {
      keyBindings = readDroneKeyBindings(localStorage)
    } catch (err) {
      commandStatus = err instanceof Error ? `Key bindings reset: ${err.message}` : `Key bindings reset: ${String(err)}`
      keyBindings = defaultDroneKeyBindings()
    }
    sceneHandle = createDroneScene({
      container: sceneElement,
      getFocusDroneId: () => selectedObject.id,
      getObjects: () => objects,
      getViewMode: () => viewMode,
      onReady: () => {
        if (sceneStatus === 'Opening flight view') sceneStatus = 'Flight view ready'
      },
      onError: message => {
        sceneStatus = message
      },
      onWorldStatus: message => {
        sceneryStatus = message
      },
      onPerformance: snapshot => {
        scenePerformance = snapshot
      },
    })
    refreshGamepads(true)
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('keyup', onKeyup)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('mousemove', onMouseMove)
    document.addEventListener('visibilitychange', onVisibilityChange)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    window.addEventListener('gamepadconnected', onGamepadConnectionChange)
    window.addEventListener('gamepaddisconnected', onGamepadConnectionChange)
    animationId = requestAnimationFrame(pollInput)
    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('keyup', onKeyup)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      window.removeEventListener('gamepadconnected', onGamepadConnectionChange)
      window.removeEventListener('gamepaddisconnected', onGamepadConnectionChange)
      if (mouseCaptured) document.exitPointerLock()
      sceneHandle?.destroy()
      sceneHandle = null
    }
  })
</script>

<section class="drone-window" style={windowStyle} aria-label="Drone flight window">
  <header class="drone-window-header">
    <div>
      <h2>{selectedObject.label}</h2>
      <span>{data?.vehicle.modelLabel ?? 'Invalid drone'} · {data?.navigation.mode ?? selectedObject.operational.status} · {data?.link.state ?? 'unknown'} · {Math.round(batteryPercent)}%</span>
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
      <div
        bind:this={sceneElement}
        class="drone-scene"
        role="application"
        aria-label="Drone 3D flight scene"
        tabindex="-1"
        onpointerdown={onScenePointerDown}
        onwheel={onSceneWheel}
      ></div>
      {#if data}
        <div class="flight-hud" aria-label="Flight telemetry">
          <div class="hud-row">
            <span>ALT {Math.round(data.pose.altitudeM)} m</span>
            <span>SPD {groundSpeedMps.toFixed(1)} m/s</span>
            <span>BAT {Math.round(batteryPercent)}%</span>
          </div>
          <div class="hud-horizon">
            <span></span>
          </div>
          <div class="hud-row">
            <span>HDG {Math.round(data.pose.headingDeg)}°</span>
            <span>P {data.attitude.pitchDeg.toFixed(1)}°</span>
            <span>R {data.attitude.rollDeg.toFixed(1)}°</span>
          </div>
          <div class="hud-row muted">
            <span>{data.autopilot}</span>
            <span>{data.arming.state}</span>
            <span>{data.link.state}</span>
          </div>
        </div>
      {/if}
    </div>
    <aside class="drone-control-panel">
      <section>
        <h3><LocateFixed size={15} /> Drone</h3>
        <select value={selectedDroneId} aria-label="Controlled drone" onchange={selectDrone}>
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
              onclick={() => bindingCaptureAction = binding.action}
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
              onclick={() => bindingCaptureAction = binding.action}
            >
              <span>{binding.label}</span>
              <strong>{bindingCaptureAction === binding.action ? 'Press key' : formatKeyCode(keyBindings[binding.action])}</strong>
            </button>
          {/each}
          <button type="button" onclick={resetKeyBindings}>
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
          <button class:active={mouseControlEnabled} type="button" onclick={toggleMouseControl}><MousePointer2 size={15} /> {mouseControlEnabled ? 'Armed' : 'Arm'}</button>
          <button type="button" disabled={!mouseControlEnabled} onclick={requestMouseCapture}><LocateFixed size={15} /> Capture</button>
          <button type="button" onclick={centerMouseStick}><RotateCcw size={15} /> Center</button>
        </div>
        <span class="mouse-status">{mouseCaptured ? 'Pointer locked' : mouseControlEnabled ? 'Click scene to fly' : 'Disabled'}</span>
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
          <button type="button" onclick={() => void setArmed(!(data?.arming.armed ?? false))}><LocateFixed size={15} /> {data?.arming.armed ? 'Disarm' : 'Arm'}</button>
          <button type="button" onclick={() => void takeoff()}><PlaneTakeoff size={15} /> Takeoff</button>
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

  <footer class="drone-window-footer">{footerStatus}</footer>
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

  .drone-control-panel button.active {
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

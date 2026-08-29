<script lang="ts">
  import { Maximize2, X } from 'lucide-svelte'
  import type { SimulationRunId, ObjectId, OperationalObject } from '../../core/model/index.ts'
  import {
    attackCommandKind,
    holdDroneCommandKind,
    landDroneCommandKind,
    manualControlCommandKind,
    returnToLaunchDroneCommandKind,
  } from '../../packs/drone/commands.ts'
  import { dronePackDataSchema, type DroneManualAxes } from '../../packs/drone/model.ts'
  import { droneManualIntentRealtimeInputType, type DroneMotionFrame } from '../../packs/drone/realtime.ts'
  import { droneSensorContacts } from '../../packs/drone/query.ts'
  import { sendSimulationRunCommand, type SimulationRunCommandRequest } from '../simulation-run-client.ts'
  import type { RuntimeInputRequest } from '../app/realtime-connection.ts'
  import type { CommandResponse } from '../types.ts'
  import IconButton from '../components/IconButton.svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import {
    actionForKeyCode,
    assignDroneKeyBinding,
    defaultDroneKeyBindings,
    droneKeyBindingDefinitions,
    droneManualAxesForPressedKeys,
    droneRuntimeAxesForPilotIntent,
    readDroneKeyBindings,
    writeDroneKeyBindings,
    type DroneKeyBindingAction,
    type DroneKeyBindingMap,
  } from './drone-key-bindings.ts'
  import { advanceDroneCameraOrbit } from './drone-camera-controls.ts'
  import {
    createDroneManualCommandStream,
    droneManualAxesSignature,
    type DroneManualInputSourceKind,
  } from './drone-manual-command-stream.ts'
  import type { DroneScenePerformanceSnapshot } from './drone-performance.ts'
  import type { DroneSceneCameraOrbit, DroneSceneHandle, DroneSceneViewMode } from './drone-scene-types.ts'
  import DroneFlightHud from './DroneFlightHud.svelte'
  import DroneSettingsRail from './DroneSettingsRail.svelte'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly object: OperationalObject
    readonly objects: ReadonlyArray<OperationalObject>
    readonly sendRealtimeCommand?: (command: SimulationRunCommandRequest) => Promise<CommandResponse>
    readonly sendRealtimeInput?: (input: RuntimeInputRequest) => void
    readonly subscribeMotionFrames?: (consumer: DroneMotionFrameConsumer) => () => void
    readonly windowOffsetIndex?: number
    readonly close: () => void
  }

  interface WindowBounds {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  }

  interface WindowPointerDrag {
    readonly pointerId: number
    readonly startX: number
    readonly startY: number
    readonly startBounds: WindowBounds
  }

  interface ControlPanelResizeDrag {
    readonly pointerId: number
    readonly startX: number
    readonly startWidth: number
  }

  interface ManualControlDeliveryResult {
    readonly transport: 'runtime-input' | 'command'
    readonly result: {
      readonly ok: boolean
      readonly reason?: string
    }
  }

  type DroneMotionFrameConsumer = (frames: ReadonlyArray<DroneMotionFrame>) => void

  let {
    simulationRunId,
    object,
    objects,
    sendRealtimeCommand,
    sendRealtimeInput,
    subscribeMotionFrames,
    windowOffsetIndex = 0,
    close,
  }: Props = $props()

  const viewportMargin = 12
  const offsetStepPx = 28
  const minWindowWidth = 680
  const minWindowHeight = 460
  const defaultWindowWidth = 1180
  const defaultWindowHeight = 760
  const minControlPanelWidth = 230
  const maxControlPanelWidth = 520
  const collapsedControlPanelWidth = 42
  const sendIntervalMs = 50
  const activeKeepaliveMs = 100
  const maxManualCommandInFlight = 3
  const commandRateUpdateIntervalMs = 250
  const realtimeStatusUpdateIntervalMs = 600
  const deadband = 0.08
  const zeroAxes: DroneManualAxes = { forward: 0, right: 0, vertical: 0, yaw: 0 }
  const defaultCameraOrbit: DroneSceneCameraOrbit = { yawOffsetRad: 0, pitchOffsetRad: 0.4, distanceM: 82 }
  const cameraOrbitKeyCodes = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const
  const flightBindingDefinitions = droneKeyBindingDefinitions.filter(definition => definition.group === 'flight')
  const cameraBindingDefinitions = droneKeyBindingDefinitions.filter(definition => definition.group === 'camera')

  let sceneElement = $state<HTMLDivElement | null>(null)
  let sceneHandle: DroneSceneHandle | null = null
  let unsubscribeMotionFrames: (() => void) | null = null
  let windowBounds = $state<WindowBounds | null>(null)
  let windowDrag = $state<WindowPointerDrag | null>(null)
  let windowResize = $state<WindowPointerDrag | null>(null)
  let controlPanelResize = $state<ControlPanelResizeDrag | null>(null)
  let controlPanelWidth = $state(320)
  let controlPanelCollapsed = $state(false)
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
  let cameraOrbit = $state<DroneSceneCameraOrbit>(defaultCameraOrbit)
  let mouseControlEnabled = $state(false)
  let mouseCaptured = $state(false)
  let scenePerformance = $state<DroneScenePerformanceSnapshot | null>(null)
  let keyBindings = $state<DroneKeyBindingMap>(defaultDroneKeyBindings())
  let bindingCaptureAction = $state<DroneKeyBindingAction | null>(null)
  let lastCommandRoundTripMs = $state<number | null>(null)
  let commandRateHz = $state(0)
  let keys = new Set<string>()
  let cameraKeys = new Set<string>()
  let commandSendTimes: number[] = []
  let lastCameraOrbitAtMs = 0
  let cameraShiftModifier = false
  let animationId = 0
  let lastGamepadRefreshMs = 0
  let gamepadSignature = ''
  let lastCommandRateUpdateMs = 0
  let lastRealtimeStatusUpdateMs = 0
  let pendingMotionFrames: ReadonlyArray<DroneMotionFrame> = []

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
  const footerStatus = $derived.by(() =>
    [commandStatus, sceneryStatus, sceneStatus]
      .filter(part => part.trim().length > 0)
      .join(' · '))

  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value))

  const defaultWindowBoundsForViewport = (): WindowBounds => {
    const offset = windowOffsetIndex * offsetStepPx
    if (typeof window === 'undefined') {
      return { left: 72 + offset, top: 72 + offset, width: 1120, height: 720 }
    }
    const availableWidth = window.innerWidth - 2 * viewportMargin - offset
    const availableHeight = window.innerHeight - 2 * viewportMargin - offset
    const width = Math.min(defaultWindowWidth, Math.max(minWindowWidth, availableWidth))
    const height = Math.min(defaultWindowHeight, Math.max(minWindowHeight, availableHeight))
    const left = Math.max(viewportMargin, Math.round((window.innerWidth - width) / 2) + offset)
    const top = Math.max(viewportMargin, Math.round((window.innerHeight - height) / 2) + offset)
    return { left, top, width, height }
  }

  const clampWindowBounds = (bounds: WindowBounds): WindowBounds => {
    if (typeof window === 'undefined') return bounds
    const maxWidth = Math.max(minWindowWidth, window.innerWidth - 2 * viewportMargin)
    const maxHeight = Math.max(minWindowHeight, window.innerHeight - 2 * viewportMargin)
    const width = clamp(bounds.width, minWindowWidth, maxWidth)
    const height = clamp(bounds.height, minWindowHeight, maxHeight)
    return {
      width,
      height,
      left: clamp(bounds.left, viewportMargin, Math.max(viewportMargin, window.innerWidth - viewportMargin - width)),
      top: clamp(bounds.top, viewportMargin, Math.max(viewportMargin, window.innerHeight - viewportMargin - height)),
    }
  }

  const currentWindowBounds = (): WindowBounds =>
    windowBounds ?? defaultWindowBoundsForViewport()

  const setWindowBounds = (bounds: WindowBounds): void => {
    windowBounds = clampWindowBounds(bounds)
  }

  const setControlPanelWidth = (width: number): void => {
    controlPanelWidth = clamp(width, minControlPanelWidth, maxControlPanelWidth)
  }

  const windowStyle = $derived.by(() => {
    const bounds = currentWindowBounds()
    return `left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px;--drone-control-panel-width:${controlPanelCollapsed ? collapsedControlPanelWidth : controlPanelWidth}px`
  })

  const bodyStyle = $derived.by(() =>
    `grid-template-columns:minmax(0,1fr) ${controlPanelCollapsed ? collapsedControlPanelWidth : controlPanelWidth}px`)

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
    manualCommandStream.reset()
    commandStatus = `Controlling ${next.label}`
  }

  const eventTargetIsWindowControl = (target: EventTarget | null): boolean =>
    target instanceof Element
    && target.closest('button,select,input,textarea,a,[data-window-control]') !== null

  const startWindowDrag = (event: PointerEvent): void => {
    if (event.button !== 0 || eventTargetIsWindowControl(event.target)) return
    event.preventDefault()
    windowDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBounds: currentWindowBounds(),
    }
  }

  const startWindowResize = (event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    windowResize = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBounds: currentWindowBounds(),
    }
  }

  const startControlPanelResize = (event: PointerEvent): void => {
    if (event.button !== 0 || controlPanelCollapsed) return
    event.preventDefault()
    event.stopPropagation()
    controlPanelResize = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: controlPanelWidth,
    }
  }

  const toggleControlPanel = (): void => {
    controlPanelCollapsed = !controlPanelCollapsed
  }

  const onWindowPointerMove = (event: PointerEvent): void => {
    if (windowDrag && event.pointerId === windowDrag.pointerId) {
      setWindowBounds({
        ...windowDrag.startBounds,
        left: windowDrag.startBounds.left + event.clientX - windowDrag.startX,
        top: windowDrag.startBounds.top + event.clientY - windowDrag.startY,
      })
      return
    }
    if (windowResize && event.pointerId === windowResize.pointerId) {
      setWindowBounds({
        ...windowResize.startBounds,
        width: windowResize.startBounds.width + event.clientX - windowResize.startX,
        height: windowResize.startBounds.height + event.clientY - windowResize.startY,
      })
      return
    }
    if (controlPanelResize && event.pointerId === controlPanelResize.pointerId) {
      setControlPanelWidth(controlPanelResize.startWidth - (event.clientX - controlPanelResize.startX))
    }
  }

  const onWindowPointerUp = (event: PointerEvent): void => {
    if (windowDrag?.pointerId === event.pointerId) windowDrag = null
    if (windowResize?.pointerId === event.pointerId) windowResize = null
    if (controlPanelResize?.pointerId === event.pointerId) controlPanelResize = null
  }

  const clampWindowToViewport = (): void => {
    setWindowBounds(currentWindowBounds())
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

  const selectTarget = (event: Event): void => {
    selectedTargetId = event.currentTarget instanceof HTMLSelectElement ? event.currentTarget.value : ''
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

  const keyboardAxes = (): DroneManualAxes =>
    droneManualAxesForPressedKeys(keyBindings, keys)

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

  const combinedAxes = (): { readonly axes: DroneManualAxes; readonly sourceKind: DroneManualInputSourceKind } => {
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

  const axesAreActive = (axes: DroneManualAxes): boolean =>
    Math.abs(axes.forward) > 0 || Math.abs(axes.right) > 0 || Math.abs(axes.vertical) > 0 || Math.abs(axes.yaw) > 0

  const setCommandStatus = (nextStatus: string): void => {
    if (commandStatus !== nextStatus) commandStatus = nextStatus
  }

  const updateCommandRate = (nowMs: number, force = false): void => {
    commandSendTimes = commandSendTimes.filter(value => nowMs - value <= 2_000)
    if (!force && nowMs - lastCommandRateUpdateMs < commandRateUpdateIntervalMs) return
    lastCommandRateUpdateMs = nowMs
    const nextRateHz = commandSendTimes.length / 2
    if (nextRateHz !== commandRateHz) commandRateHz = nextRateHz
  }

  const recordCommandSent = (startedAtMs: number): void => {
    commandSendTimes.push(startedAtMs)
    updateCommandRate(startedAtMs)
  }

  const sendManualControl = async (
    axes: DroneManualAxes,
    sourceKind: DroneManualInputSourceKind,
    sequence: number,
    startedAtMs: number,
  ): Promise<ManualControlDeliveryResult> => {
    const activeGamepad = selectedGamepadIndex === null ? null : gamepads.find(pad => pad.index === selectedGamepadIndex)
    const source = sourceKind === 'gamepad' && activeGamepad
      ? { kind: 'gamepad' as const, gamepadIndex: activeGamepad.index, label: activeGamepad.id }
      : sourceKind === 'mouse'
        ? { kind: 'mouse' as const, label: mouseCaptured ? 'Mouse pointer lock' : 'Mouse' }
        : { kind: 'keyboard' as const, label: 'Keyboard' }
    const commandPayload = {
      droneId: selectedObject.id,
      axes: droneRuntimeAxesForPilotIntent(axes),
      inputSource: source,
      commandTtlMs: 450,
    }
    if (sendRealtimeInput) {
      try {
        sendRealtimeInput({
          type: droneManualIntentRealtimeInputType,
          payload: {
            ...commandPayload,
            sampledAtMs: startedAtMs,
            sequence,
          },
        })
        return { transport: 'runtime-input', result: { ok: true } }
      } catch (err) {
        commandStatus = err instanceof Error ? `${err.message}; falling back to command path` : 'Realtime input failed; falling back to command path'
      }
    }
    const command: SimulationRunCommandRequest = {
      kind: manualControlCommandKind,
      targetObjectIds: [selectedObject.id],
      payload: commandPayload,
    }
    try {
      const response = sendRealtimeCommand
        ? await sendRealtimeCommand(command)
        : await sendSimulationRunCommand(simulationRunId, command)
      return { transport: 'command', result: response.result }
    } catch (err) {
      if (!sendRealtimeCommand) throw err
      const response = await sendSimulationRunCommand(simulationRunId, command)
      return { transport: 'command', result: response.result }
    }
  }

  const manualCommandStream = createDroneManualCommandStream<ManualControlDeliveryResult>({
    sendIntervalMs,
    activeKeepaliveMs,
    maxInFlight: maxManualCommandInFlight,
    send: async input => await sendManualControl(input.axes, input.sourceKind, input.sequence, input.startedAtMs),
    onSend: event => {
      recordCommandSent(event.startedAtMs)
    },
    onResult: event => {
      if (event.stale) return
      const settledAtMs = event.startedAtMs + event.roundTripMs
      if (!event.value.result.ok) {
        lastCommandRoundTripMs = event.roundTripMs
        setCommandStatus(`Rejected: ${event.value.result.reason ?? 'unknown'}`)
        return
      }
      if (event.value.transport === 'runtime-input') {
        if (settledAtMs - lastRealtimeStatusUpdateMs >= realtimeStatusUpdateIntervalMs) {
          lastRealtimeStatusUpdateMs = settledAtMs
          setCommandStatus('Manual intent streamed')
        }
        return
      }
      lastCommandRoundTripMs = event.roundTripMs
      setCommandStatus('Manual velocity sent')
    },
    onError: event => {
      if (event.stale) return
      lastCommandRoundTripMs = event.roundTripMs
      setCommandStatus(event.error instanceof Error ? event.error.message : String(event.error))
    },
    onBlocked: event => {
      setCommandStatus(`Rejected: ${event.reason}`)
    },
  })

  const setMode = async (mode: 'hold' | 'land' | 'return_to_launch'): Promise<void> => {
    const kind = mode === 'hold'
      ? holdDroneCommandKind
      : mode === 'land'
        ? landDroneCommandKind
        : returnToLaunchDroneCommandKind
    const body = await sendSimulationRunCommand(simulationRunId, {
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
    const body = await sendSimulationRunCommand(simulationRunId, {
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
    advanceCameraOrbit(nowMs)
    updateCommandRate(nowMs)
    const sample = combinedAxes()
    const axes = sample.axes
    const signature = droneManualAxesSignature(axes)
    if (signature !== droneManualAxesSignature(liveAxes)) liveAxes = axes
    manualCommandStream.update({
      axes,
      sourceKind: sample.sourceKind,
      nowMs,
      blockReason: axesAreActive(axes) && data === null ? 'selected object is not a drone' : undefined,
    })
    animationId = requestAnimationFrame(pollInput)
  }

  const resetManualInputs = (): void => {
    keys = new Set()
    mouseAxes = zeroAxes
  }

  const resetCameraInputs = (): void => {
    cameraKeys = new Set()
    cameraShiftModifier = false
    lastCameraOrbitAtMs = 0
  }

  const keyboardEventTargetIsTextInput = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement

  const isCameraOrbitKeyCode = (code: string): boolean =>
    cameraOrbitKeyCodes.some(candidate => candidate === code)

  const setCameraOrbitKey = (code: string, pressed: boolean): boolean => {
    if (!isCameraOrbitKeyCode(code)) return false
    const next = new Set(cameraKeys)
    if (pressed) next.add(code)
    else next.delete(code)
    cameraKeys = next
    return true
  }

  const updateCameraShiftModifier = (event: KeyboardEvent, pressed: boolean): void => {
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      cameraShiftModifier = pressed || event.shiftKey
      return
    }
    cameraShiftModifier = event.shiftKey
  }

  const advanceCameraOrbit = (nowMs: number): void => {
    if (lastCameraOrbitAtMs === 0) {
      lastCameraOrbitAtMs = nowMs
      return
    }
    const dtSeconds = (nowMs - lastCameraOrbitAtMs) / 1_000
    lastCameraOrbitAtMs = nowMs
    if (cameraKeys.size === 0) return

    const nextOrbit = advanceDroneCameraOrbit(cameraOrbit, {
      orbitLeft: cameraKeys.has('ArrowLeft'),
      orbitRight: cameraKeys.has('ArrowRight'),
      orbitUp: cameraKeys.has('ArrowUp'),
      orbitDown: cameraKeys.has('ArrowDown'),
      zoomModifier: cameraShiftModifier,
    }, dtSeconds)
    if (
      nextOrbit.yawOffsetRad === cameraOrbit.yawOffsetRad
      && nextOrbit.pitchOffsetRad === cameraOrbit.pitchOffsetRad
      && nextOrbit.distanceM === cameraOrbit.distanceM
    ) return
    cameraOrbit = nextOrbit
  }

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

  const handleCameraOrbitKeydown = (event: KeyboardEvent): boolean => {
    if (!setCameraOrbitKey(event.code, true)) return false
    updateCameraShiftModifier(event, true)
    event.preventDefault()
    return true
  }

  const handledKeyboardEvent = (event: KeyboardEvent): boolean =>
    bindingCaptureAction !== null
    || actionForKeyCode(keyBindings, event.code) !== null
    || isCameraOrbitKeyCode(event.code)

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
    updateCameraShiftModifier(event, true)
    if (handleCameraOrbitKeydown(event)) return
    const handled = handledKeyboardEvent(event)
    if (handled) event.preventDefault()
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
    if (event.repeat) return
  }

  const onKeyup = (event: KeyboardEvent): void => {
    if (keyboardEventTargetIsTextInput(event.target)) return
    updateCameraShiftModifier(event, false)
    if (setCameraOrbitKey(event.code, false)) {
      event.preventDefault()
      return
    }
    if (handledKeyboardEvent(event)) event.preventDefault()
    keys.delete(event.code)
  }

  const onWindowBlur = (): void => {
    resetManualInputs()
    resetCameraInputs()
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      resetManualInputs()
      resetCameraInputs()
    }
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
    commandStatus = mouseControlEnabled ? 'Mouse flight enabled; click the scene' : 'Mouse flight disabled'
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
    let disposed = false
    windowBounds = clampWindowBounds(defaultWindowBoundsForViewport())
    try {
      keyBindings = readDroneKeyBindings(localStorage)
    } catch (err) {
      commandStatus = err instanceof Error ? `Key bindings reset: ${err.message}` : `Key bindings reset: ${String(err)}`
      keyBindings = defaultDroneKeyBindings()
    }
    unsubscribeMotionFrames = subscribeMotionFrames?.(frames => {
      pendingMotionFrames = frames
      sceneHandle?.ingestMotionFrames(frames)
    }) ?? null
    sceneStatus = 'Loading flight renderer'
    sceneryStatus = 'Waiting for renderer'
    void (async (): Promise<void> => {
      try {
        const module = await import('./drone-scene.ts')
        if (disposed || !sceneElement) return
        sceneStatus = 'Starting Babylon flight renderer'
        sceneHandle = module.createDroneScene({
          container: sceneElement,
          getFocusDroneId: () => selectedObject.id,
          getObjects: () => objects,
          getViewMode: () => viewMode,
          getCameraOrbit: () => cameraOrbit,
          onReady: () => {
            if (sceneStatus === 'Opening flight view' || sceneStatus === 'Loading flight renderer' || sceneStatus === 'Starting Babylon flight renderer') {
              sceneStatus = 'Flight view ready'
            }
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
        if (pendingMotionFrames.length > 0) sceneHandle.ingestMotionFrames(pendingMotionFrames)
      } catch (err) {
        if (!disposed) sceneStatus = err instanceof Error ? err.message : String(err)
      }
    })()
    refreshGamepads(true)
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('keyup', onKeyup)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('resize', clampWindowToViewport)
    window.addEventListener('pointermove', onWindowPointerMove)
    window.addEventListener('pointerup', onWindowPointerUp)
    window.addEventListener('pointercancel', onWindowPointerUp)
    window.addEventListener('mousemove', onMouseMove)
    document.addEventListener('visibilitychange', onVisibilityChange)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    window.addEventListener('gamepadconnected', onGamepadConnectionChange)
    window.addEventListener('gamepaddisconnected', onGamepadConnectionChange)
    animationId = requestAnimationFrame(pollInput)
    return () => {
      disposed = true
      cancelAnimationFrame(animationId)
      manualCommandStream.reset()
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('keyup', onKeyup)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('resize', clampWindowToViewport)
      window.removeEventListener('pointermove', onWindowPointerMove)
      window.removeEventListener('pointerup', onWindowPointerUp)
      window.removeEventListener('pointercancel', onWindowPointerUp)
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      window.removeEventListener('gamepadconnected', onGamepadConnectionChange)
      window.removeEventListener('gamepaddisconnected', onGamepadConnectionChange)
      if (mouseCaptured) document.exitPointerLock()
      unsubscribeMotionFrames?.()
      unsubscribeMotionFrames = null
      pendingMotionFrames = []
      sceneHandle?.destroy()
      sceneHandle = null
    }
  })
</script>

<section
  class="drone-window"
  class:dragging={windowDrag !== null}
  class:resizing={windowResize !== null || controlPanelResize !== null}
  style={windowStyle}
  aria-label="Drone flight window"
>
  <header class="drone-window-header" role="toolbar" aria-label="Drone flight window title bar" tabindex="0" onpointerdown={startWindowDrag}>
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

  <div class="drone-window-body" class:control-panel-collapsed={controlPanelCollapsed} style={bodyStyle}>
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
        <DroneFlightHud {data} {groundSpeedMps} {batteryPercent} />
      {/if}
    </div>
    <DroneSettingsRail
      collapsed={controlPanelCollapsed}
      {selectedDroneId}
      {droneObjects}
      {liveAxes}
      {flightBindingDefinitions}
      {cameraBindingDefinitions}
      {keyBindings}
      {bindingCaptureAction}
      {scenePerformance}
      {lastCommandRoundTripMs}
      {commandRateHz}
      {mouseControlEnabled}
      {mouseCaptured}
      {gamepads}
      {selectedGamepadIndex}
      {sensorContacts}
      {targetOptions}
      {selectedTargetId}
      onToggleCollapsed={toggleControlPanel}
      onStartResize={startControlPanelResize}
      onSelectDrone={selectDrone}
      onCaptureBinding={(action) => bindingCaptureAction = action}
      onResetKeyBindings={resetKeyBindings}
      onToggleMouseControl={toggleMouseControl}
      onRequestMouseCapture={requestMouseCapture}
      onCenterMouseStick={centerMouseStick}
      onSelectGamepad={selectGamepad}
      onSetMode={setMode}
      onSelectTarget={selectTarget}
      onAttackTarget={attackTarget}
    />
  </div>

  <footer class="drone-window-footer">{footerStatus}</footer>
  <button
    class="window-resize-grip"
    type="button"
    aria-label="Resize drone flight window"
    title="Resize drone flight window"
    data-window-control
    onpointerdown={startWindowResize}
  >
    <Maximize2 size={14} />
  </button>
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

  .drone-window.dragging,
  .drone-window.resizing {
    user-select: none;
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

  .drone-window-header {
    cursor: move;
    touch-action: none;
  }

  .drone-window-footer {
    justify-content: flex-start;
    border-top: 1px solid rgb(148 163 184 / 0.22);
    border-bottom: 0;
    color: #cbd5e1;
    font-size: 12px;
  }

  h2 {
    margin: 0;
    letter-spacing: 0;
    font-size: 15px;
  }

  .drone-window-header span {
    display: block;
    margin-top: 2px;
    color: #94a3b8;
    font-size: 12px;
  }

  .header-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .header-actions button,
  .window-resize-grip {
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


  .window-resize-grip {
    position: absolute;
    right: 0;
    bottom: 0;
    z-index: 3;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border-right: 0;
    border-bottom: 0;
    cursor: nwse-resize;
    touch-action: none;
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
      grid-template-columns: 1fr !important;
      grid-template-rows: minmax(260px, 1fr) auto;
      overflow: hidden;
    }

  }
</style>

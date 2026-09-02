<script lang="ts">
  import { Save, X } from 'lucide-svelte'
  import type { SimulationRunId, OperationalObject } from '../../core/model/index.ts'
  import { configureDroneVehicleModelCommandKind } from '../../packs/drone/commands.ts'
  import { dronePackDataSchema, droneVehicleModelSchema, type DroneCapability, type DronePayload } from '../../packs/drone/model.ts'
  import { invokeSimulationRunCapability } from '../simulation-run-client.ts'
  import IconButton from '../components/IconButton.svelte'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly object: OperationalObject
    readonly windowOffsetIndex?: number
    readonly close: () => void
  }

  let {
    simulationRunId,
    object,
    windowOffsetIndex = 0,
    close,
  }: Props = $props()

  const data = $derived.by(() => {
    const parsed = dronePackDataSchema.safeParse(object.packData)
    return parsed.success ? parsed.data : null
  })

  let loadedObjectId = $state<string | null>(null)
  let label = $state('')
  let flightEnvelopeJson = $state('{}')
  let capabilityKinds = $state('')
  let payloadsJson = $state('[]')
  let color = $state('#2563eb')
  let accentColor = $state('#f8fafc')
  let scale = $state(1)
  let status = $state('Loading vehicle model')

  const windowStyle = $derived.by(() => {
    const offset = windowOffsetIndex * 28
    return `left:${100 + offset}px;top:${96 + offset}px;width:min(720px,calc(100vw - 24px));max-height:calc(100vh - ${120 + offset}px)`
  })

  $effect(() => {
    if (loadedObjectId === object.id) return
    const initial = data
    loadedObjectId = object.id
    label = initial?.vehicle.modelLabel ?? object.label
    flightEnvelopeJson = JSON.stringify(initial?.vehicle.flightEnvelope ?? {}, null, 2)
    capabilityKinds = initial?.vehicle.capabilities.map(capability => capability.kind).join(', ') ?? ''
    payloadsJson = JSON.stringify(initial?.vehicle.payloads ?? [], null, 2)
    color = initial?.vehicle.visual.color ?? '#2563eb'
    accentColor = initial?.vehicle.visual.accentColor ?? '#f8fafc'
    scale = initial?.vehicle.visual.scale ?? 1
    status = initial ? 'Ready' : 'Invalid drone vehicle data'
  })

  const capabilitiesFromText = (): ReadonlyArray<DroneCapability> =>
    capabilityKinds
      .split(',')
      .map(kind => kind.trim())
      .filter(kind => kind.length > 0)
      .map(kind => ({
        id: kind.replaceAll(/[^a-zA-Z0-9._:-]/g, '-').toLowerCase(),
        kind,
        label: kind.replaceAll('_', ' '),
        level: 1,
        source: 'operator_declared',
        tags: [],
      }))

  const payloadsFromJson = (): ReadonlyArray<DronePayload> => {
    const value = JSON.parse(payloadsJson) as unknown
    if (!Array.isArray(value)) throw new Error('payloads must be a JSON array')
    return value.map(payload => payload as DronePayload)
  }

  const flightEnvelopeFromJson = (): unknown => JSON.parse(flightEnvelopeJson) as unknown

  const save = async (): Promise<void> => {
    const current = data
    if (!current) return
    try {
      const model = droneVehicleModelSchema.parse({
        id: current.vehicle.modelId,
        label,
        airframe: current.vehicle.airframe,
        flightEnvelope: flightEnvelopeFromJson(),
        capabilities: capabilitiesFromText(),
        sensors: current.vehicle.sensors,
        payloads: payloadsFromJson(),
        visual: { color, accentColor, scale },
      })
      const body = await invokeSimulationRunCapability(simulationRunId, {
        capabilityId: configureDroneVehicleModelCommandKind,
        input: {
          droneId: object.id,
          model,
        },
      })
      if (body.kind !== 'command') throw new Error(`${configureDroneVehicleModelCommandKind} is not a command`)
      status = body.result.ok ? 'Vehicle model saved' : `Rejected: ${body.result.reason ?? 'unknown'}`
    } catch (err) {
      status = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<section class="profile-window" style={windowStyle} aria-label="Drone vehicle model editor">
  <header>
    <div>
      <h2>{object.label} vehicle model</h2>
      <span>{data?.vehicle.modelId ?? 'invalid'}</span>
    </div>
    <IconButton label="Close vehicle model editor" icon={X} onClick={close} />
  </header>

  <div class="profile-body">
    <label>
      <span>Label</span>
      <input bind:value={label} />
    </label>

    <div class="field-grid">
      <label><span>Scale</span><input type="number" min="0.1" max="10" step="0.05" bind:value={scale} /></label>
      <label><span>Color</span><input bind:value={color} /></label>
      <label><span>Accent</span><input bind:value={accentColor} /></label>
    </div>

    <label>
      <span>Flight envelope JSON</span>
      <textarea bind:value={flightEnvelopeJson}></textarea>
    </label>

    <label>
      <span>Capabilities</span>
      <input bind:value={capabilityKinds} />
    </label>

    <label>
      <span>Payloads JSON</span>
      <textarea bind:value={payloadsJson}></textarea>
    </label>
  </div>

  <footer>
    <span>{status}</span>
    <button type="button" onclick={() => void save()}><Save size={15} /> Save</button>
  </footer>
</section>

<style>
  .profile-window {
    position: fixed;
    z-index: 82;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    overflow: hidden;
    background: #f8fafc;
    color: #0f172a;
    border: 1px solid #cbd5e1;
    box-shadow: 0 22px 60px rgb(15 23 42 / 0.28);
  }

  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    background: #e2e8f0;
    border-bottom: 1px solid #cbd5e1;
  }

  footer {
    border-top: 1px solid #cbd5e1;
    border-bottom: 0;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    letter-spacing: 0;
  }

  header span,
  footer span {
    color: #475569;
    font-size: 12px;
  }

  .profile-body {
    display: grid;
    gap: 12px;
    padding: 12px;
    overflow: auto;
  }

  label {
    display: grid;
    gap: 5px;
    color: #334155;
    font-size: 12px;
  }

  input,
  textarea {
    width: 100%;
    min-height: 32px;
    padding: 6px 8px;
    border: 1px solid #cbd5e1;
    background: #ffffff;
    color: #0f172a;
    font: inherit;
  }

  textarea {
    min-height: 150px;
    resize: vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .field-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  footer button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: #ffffff;
    font: inherit;
  }

  @media (max-width: 760px) {
    .field-grid {
      grid-template-columns: 1fr;
    }
  }
</style>

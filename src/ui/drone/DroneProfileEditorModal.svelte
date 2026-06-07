<script lang="ts">
  import { Save, X } from 'lucide-svelte'
  import type { ControlInstanceId, OperationalObject } from '../../core/model/index.ts'
  import { configureDroneProfileCommandKind } from '../../packs/drone/commands.ts'
  import { dronePackDataSchema, droneProfileSchema, type DroneCapability, type DronePayload } from '../../packs/drone/model.ts'
  import { sendControlInstanceCommand } from '../control-instance-client.ts'
  import IconButton from '../components/IconButton.svelte'

  interface Props {
    readonly controlInstanceId: ControlInstanceId
    readonly object: OperationalObject
    readonly windowOffsetIndex?: number
    readonly close: () => void
  }

  let {
    controlInstanceId,
    object,
    windowOffsetIndex = 0,
    close,
  }: Props = $props()

  const profile = $derived.by(() => {
    const parsed = dronePackDataSchema.safeParse(object.packData)
    return parsed.success ? parsed.data.profile : null
  })

  let loadedObjectId = $state<string | null>(null)
  let label = $state('')
  let maxHorizontalSpeedMps = $state(18)
  let maxVerticalSpeedMps = $state(5)
  let maxAccelerationMps2 = $state(7)
  let maxYawRateDegPerSec = $state(160)
  let serviceCeilingM = $state(500)
  let capacityWh = $state(95)
  let reserveWh = $state(18)
  let hoverPowerW = $state(390)
  let cruisePowerW = $state(520)
  let capabilityKinds = $state('')
  let payloadsJson = $state('[]')
  let status = $state('Loading profile')

  const windowStyle = $derived.by(() => {
    const offset = windowOffsetIndex * 28
    return `left:${100 + offset}px;top:${96 + offset}px;width:min(760px,calc(100vw - 24px));max-height:calc(100vh - ${120 + offset}px)`
  })

  $effect(() => {
    if (loadedObjectId === object.id) return
    const initial = profile
    loadedObjectId = object.id
    label = initial?.label ?? object.label
    maxHorizontalSpeedMps = initial?.dynamics.maxHorizontalSpeedMps ?? 18
    maxVerticalSpeedMps = initial?.dynamics.maxVerticalSpeedMps ?? 5
    maxAccelerationMps2 = initial?.dynamics.maxAccelerationMps2 ?? 7
    maxYawRateDegPerSec = initial?.dynamics.maxYawRateDegPerSec ?? 160
    serviceCeilingM = initial?.dynamics.serviceCeilingM ?? 500
    capacityWh = initial?.energy.capacityWh ?? 95
    reserveWh = initial?.energy.reserveWh ?? 18
    hoverPowerW = initial?.energy.hoverPowerW ?? 390
    cruisePowerW = initial?.energy.cruisePowerW ?? 520
    capabilityKinds = initial?.capabilities.map(capability => capability.kind).join(', ') ?? ''
    payloadsJson = JSON.stringify(initial?.payloads ?? [], null, 2)
    status = initial ? 'Ready' : 'Invalid drone profile'
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
        tags: [],
      }))

  const payloadsFromJson = (): ReadonlyArray<DronePayload> => {
    const value = JSON.parse(payloadsJson) as unknown
    if (!Array.isArray(value)) throw new Error('payloads must be a JSON array')
    return value.map(payload => payload as DronePayload)
  }

  const save = async (): Promise<void> => {
    const current = profile
    if (!current) return
    try {
      const profile = droneProfileSchema.parse({
        ...current,
        label,
        dynamics: {
          ...current.dynamics,
          maxHorizontalSpeedMps,
          maxVerticalSpeedMps,
          maxAccelerationMps2,
          maxYawRateDegPerSec,
          serviceCeilingM,
        },
        energy: {
          ...current.energy,
          capacityWh,
          reserveWh,
          hoverPowerW,
          cruisePowerW,
        },
        capabilities: capabilitiesFromText(),
        payloads: payloadsFromJson(),
      })
      const body = await sendControlInstanceCommand(controlInstanceId, {
        kind: configureDroneProfileCommandKind,
        targetObjectIds: [object.id],
        payload: {
          droneId: object.id,
          profile,
        },
      })
      status = body.result.ok ? 'Profile saved' : `Rejected: ${body.result.reason ?? 'unknown'}`
    } catch (err) {
      status = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<section class="profile-window" style={windowStyle} aria-label="Drone profile editor">
  <header>
    <div>
      <h2>{object.label} profile</h2>
      <span>{profile?.id ?? 'invalid'}</span>
    </div>
    <IconButton label="Close profile editor" icon={X} onClick={close} />
  </header>

  <div class="profile-body">
    <label>
      <span>Label</span>
      <input bind:value={label} />
    </label>

    <div class="field-grid">
      <label><span>Horizontal m/s</span><input type="number" min="1" max="160" step="0.5" bind:value={maxHorizontalSpeedMps} /></label>
      <label><span>Vertical m/s</span><input type="number" min="1" max="60" step="0.5" bind:value={maxVerticalSpeedMps} /></label>
      <label><span>Acceleration m/s2</span><input type="number" min="1" max="80" step="0.5" bind:value={maxAccelerationMps2} /></label>
      <label><span>Yaw deg/s</span><input type="number" min="1" max="720" step="5" bind:value={maxYawRateDegPerSec} /></label>
      <label><span>Ceiling m</span><input type="number" min="1" max="20000" step="10" bind:value={serviceCeilingM} /></label>
      <label><span>Capacity Wh</span><input type="number" min="1" max="100000" step="1" bind:value={capacityWh} /></label>
      <label><span>Reserve Wh</span><input type="number" min="0" max="100000" step="1" bind:value={reserveWh} /></label>
      <label><span>Hover W</span><input type="number" min="1" max="100000" step="10" bind:value={hoverPowerW} /></label>
      <label><span>Cruise W</span><input type="number" min="1" max="150000" step="10" bind:value={cruisePowerW} /></label>
    </div>

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
    font-size: 12px;
    color: #475569;
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
    font-size: 12px;
    color: #334155;
  }

  input,
  textarea {
    width: 100%;
    min-height: 32px;
    border: 1px solid #cbd5e1;
    background: #ffffff;
    color: #0f172a;
    font: inherit;
    padding: 6px 8px;
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
    border: 1px solid #2563eb;
    background: #2563eb;
    color: #ffffff;
    padding: 0 12px;
    font: inherit;
  }

  @media (max-width: 760px) {
    .field-grid {
      grid-template-columns: 1fr;
    }
  }
</style>

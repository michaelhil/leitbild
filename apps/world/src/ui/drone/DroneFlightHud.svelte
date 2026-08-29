<script lang="ts">
  import type { DronePackData } from '../../packs/drone/model.ts'

  interface Props {
    readonly data: DronePackData
    readonly groundSpeedMps: number
    readonly batteryPercent: number
  }

  let { data, groundSpeedMps, batteryPercent }: Props = $props()
</script>

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
    <span>{data.vehicle.modelLabel}</span>
    <span>{data.navigation.mode}</span>
    <span>{data.link.state}</span>
  </div>
</div>

<style>
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
    .flight-hud {
      bottom: 10px;
      font-size: 10px;
    }
  }
</style>

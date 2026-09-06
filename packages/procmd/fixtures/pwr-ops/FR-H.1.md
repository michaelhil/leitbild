---
type: procedure
procedure-md: 0.7
procedure-id: FR-H.1
title: Response to Loss of Secondary Heat Sink
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [heat-sink]
entry-triggers: [csf-red-path]
---

# FR-H.1 — Response to Loss of Secondary Heat Sink

**CSF heat sink — RED path.** Entered on total loss of feedwater to all
SGs — main feedwater isolated, all motor-driven AFW pumps unavailable,
turbine-driven AFW pump unavailable. The reactor decay heat must still
go somewhere; without secondary cooling that destination is the RCS,
which heats up and pressurizes against the PORVs / safeties. The only
operational alternative is **bleed-and-feed** primary cooling — opening
the pressurizer PORVs to vent steam from the RCS while high-head SI
makes up the inventory, sending decay heat to containment via the
pressurizer relief tank and ultimately the sump. This is irreversible
from a containment-cleanup perspective; see Vogtle UFSAR §15.2.7
(loss-of-normal-feedwater analysis).

CSF: heat-sink

## Step 1 [id: verify-loss]
Check: AFW pumps «AFW-PUMP-A» / «AFW-PUMP-B» / «AFW-PUMP-T» status (all stopped or faulted); main feedwater isolation «MFW-A-CV» status; SG narrow-range levels «SG-A-LVL-NR» / «SG-B-LVL-NR» / «SG-C-LVL-NR» / «SG-D-LVL-NR» below low-low setpoint and falling
Within: 2 minutes — establish the loss-of-heat-sink diagnosis before AFW recovery efforts diverge into too many parallel paths
Caution: a single non-running AFW pump is NOT loss of heat sink; criterion requires ALL feedwater paths unavailable simultaneously
- All feedwater confirmed lost AND SG levels falling on all SGs → #establish-bleed-feed
  Because: bleed-and-feed must be established BEFORE the heat sink is fully lost — waiting until SG dryout greatly extends RCS heatup
- AFW recoverable (one path identified as restorable within minutes) → #restore-afw
  Because: AFW restoration is far preferable to bleed-and-feed; pursue in parallel with bleed-and-feed preparation

## Step 2 [id: restore-afw]
Within: 5 minutes — AFW restoration is time-critical; bleed-and-feed remains the fallback
Action: dispatch operators to restore TDAFW «AFW-PUMP-T» if steam supply available (turbine-driven AFW survives station blackout because it runs on SG steam)
Action: if motor-driven AFW available on any train, restart and align to at least one SG
Action: if all primary AFW paths failed, attempt alternate feedwater: condensate booster pump, condensate transfer pump cross-tie, or any other condensate-source-to-SG path documented in the plant's loss-of-feedwater procedures
- AFW or alternate feedwater restored, flow to at least one SG → [[E-0]]
  Because: heat sink restored to GREEN; return to diagnostic flow at E-0
- AFW restoration unsuccessful → #establish-bleed-feed
  Because: bleed-and-feed becomes the operating cooling method

## Step 3 [id: establish-bleed-feed]
Within: 10 minutes of total feedwater loss — RCS heatup at decay-heat power saturates the RCS within ~15-20 min from start of feedwater loss; bleed-and-feed must be in service before pressurizer relief valves lift on their own
Action: verify ALL SI pumps «SI-PUMP-A» / «SI-PUMP-B» running and aligned for RCS injection from RWST «RWST-LVL»
Action: open BOTH pressurizer PORVs «PORV-456A» AND «PORV-456B» and lock them open via control-room signal; verify block valves «BLOCK-456A» / «BLOCK-456B» OPEN
Action: ensure containment sump «CTMT-SUMP-LVL» level is monitored — confirms the bleed path is intact
Caution: bleed-and-feed at full SI flow + open PORVs consumes RWST inventory at ~3000 gpm; ES-1.3 cold-leg recirculation transfer MUST be ready before RWST low-low — coordinate sump recirculation alignment in parallel with bleed-and-feed
Caution: this action delivers the entire RWST contents into containment sump as borated water; containment radiological consequences are significant but the alternative is core damage
- Bleed-and-feed established (PORVs open, SI injecting, sump level rising) → #verify-cooling
  Because: establishment confirmed; verify it produces cooling
- Cannot establish bleed-and-feed (SI unavailable OR PORVs cannot open) → [[FR-C.1]]
  Because: without bleed-and-feed the next failure mode is inadequate core cooling — RED-path core-cooling response takes precedence

## Step 4 [id: verify-cooling]
Check: RCS temperatures (T_hot via «TE-411-HOT»; T_cold trends) stable or decreasing; pressurizer pressure «PT-455» stable or decreasing; subcooling margin «SUB-MARGIN» maintained
Within: hold this step for ≥10 min of stable, improving trends — bleed-and-feed thermodynamics take longer to stabilize than valve actions suggest
- RCS temperatures stable or trending down → #monitor
  Because: bleed-and-feed is performing the heat-sink function; transition to monitoring loop
- Temperatures continuing to rise or pressurizer pressure rising despite open PORVs → [[FR-C.1]]
  Because: bleed-and-feed insufficient — escalating toward inadequate core cooling

## Step 5 [id: monitor]
Check: feedwater restoration status (any AFW or alternate feedwater path restored); bleed-and-feed performance; ES-1.3 recirculation transfer readiness
Within: re-evaluate every 15 minutes; RWST depletion is the critical timeline driver
- AFW or alternate feedwater restored and flow established to ≥1 SG → [[E-0]]
  Because: secondary heat sink restored; return to diagnostic flow (bleed-and-feed can be terminated per E-0 / ES-1.1)
- Bleed-and-feed continuing, RWST trending toward low-low → [[ES-1.3]]
  Because: cold-leg recirculation transfer must occur before RWST exhaustion
- Continuing on bleed-and-feed, no AFW prospect, recirc not yet needed → #monitor
  Because: stable operating loop on the bleed-and-feed alternative; continue monitoring

## Tags

- id: AFW-PUMP-A
  description: motor-driven AFW pump A status
  sim-path: afw.pump.a.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: AFW-PUMP-B
  description: motor-driven AFW pump B status
  sim-path: afw.pump.b.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: AFW-PUMP-T
  description: turbine-driven AFW pump status
  sim-path: afw.pump.tdafw.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: MFW-A-CV
  description: SG-A main feedwater control valve position
  sim-path: secondary.mfw.a.cv_position
  units: percent
  equipment: mfw-system
  source: Vogtle UFSAR §10.4.7

- id: SG-A-LVL-NR
  description: SG-A narrow-range level
  sim-path: secondary.sg.a.level_nr
  units: percent
  equipment: sg-a
  source: Vogtle UFSAR §10.3

- id: SG-B-LVL-NR
  description: SG-B narrow-range level
  sim-path: secondary.sg.b.level_nr
  units: percent
  equipment: sg-b
  source: Vogtle UFSAR §10.3

- id: SG-C-LVL-NR
  description: SG-C narrow-range level
  sim-path: secondary.sg.c.level_nr
  units: percent
  equipment: sg-c
  source: Vogtle UFSAR §10.3

- id: SG-D-LVL-NR
  description: SG-D narrow-range level
  sim-path: secondary.sg.d.level_nr
  units: percent
  equipment: sg-d
  source: Vogtle UFSAR §10.3

- id: SI-PUMP-A
  description: high-head SI pump A status
  sim-path: ess.si_pump.a.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: si-system
  source: Vogtle UFSAR §6.3

- id: SI-PUMP-B
  description: high-head SI pump B status
  sim-path: ess.si_pump.b.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: si-system
  source: Vogtle UFSAR §6.3

- id: RWST-LVL
  description: refueling water storage tank level
  sim-path: rwst.level
  units: percent
  equipment: rwst
  source: Vogtle UFSAR §6.3.2

- id: PORV-456A
  description: pressurizer PORV 456A position
  sim-path: rcs.pressurizer.porv.456a.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: PORV-456B
  description: pressurizer PORV 456B position
  sim-path: rcs.pressurizer.porv.456b.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: BLOCK-456A
  description: pressurizer PORV 456A block valve position
  sim-path: rcs.pressurizer.block.456a.position
  units: enum[OPEN,CLOSED]
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: BLOCK-456B
  description: pressurizer PORV 456B block valve position
  sim-path: rcs.pressurizer.block.456b.position
  units: enum[OPEN,CLOSED]
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: CTMT-SUMP-LVL
  description: containment recirculation sump level
  sim-path: containment.sump.level
  units: percent
  equipment: containment
  source: Vogtle UFSAR §6.2

- id: TE-411-HOT
  description: RCS loop 1 hot-leg temperature
  sim-path: rcs.loop1.t_hot
  units: degF
  equipment: rcs-loop-1
  source: Vogtle UFSAR §5.1.1

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

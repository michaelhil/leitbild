---
type: procedure
procedure-md: 0.7
procedure-id: ES-1.2
title: Post-LOCA Cooldown and Depressurization
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: recovery-procedure
csfs-monitored: [core-cooling, rcs-integrity, rcs-inventory]
entry-triggers: [post-trip-stable]
---

# ES-1.2 — Post-LOCA Cooldown and Depressurization

Entered from [[E-1]] or [[ES-1.1]] when post-LOCA cooldown to RHR
conditions (Mode 4, ~350 °F, ~390 psig per Vogtle Tech Spec) is
required to enable RHR cut-in or to support a repair / refueling
outage. Manages residual SI flow (if still in service) while
controlling cooldown rate against PTS limits and depressurization
against subcooling-margin loss.

CSF: core-cooling

CSF: rcs-integrity

CSF: rcs-inventory

## Step 1 [id: verify-cooldown-conditions]
Check: RCS conditions stable post-LOCA — subcooling margin «SUB-MARGIN» ≥ 30 °F sustained; pressurizer level «PZR-LVL» on-scale and controlled; SG levels controlled with AFW or MFW; at least 2 intact SGs available for heat removal
- All cooldown prerequisites met → #initiate-cooldown
  Because: ready to begin cooldown
- Any condition not met → [[E-1]]
  Because: continue LOCA management until cooldown prerequisites are stable

## Step 2 [id: initiate-cooldown]
Within: cooldown is multi-hour; the criterion is RATE not duration
Action: align steam dump from intact SGs to condenser (if available) or atmospheric relief; control cooldown rate via «STEAM-DUMP» modulation
Action: maintain RCS pressure / level via charging «CHG-FLOW» and pressurizer heaters «PZR-HTR»
Action: continue SI flow if any of the four SI-termination criteria are still not met; terminate SI per [[ES-1.1]] only when all four are simultaneously satisfied for ≥5 min
Caution: maximum cooldown rate is 100 °F/hr per Vogtle Tech Spec 3.4.3 below 350 °F; do NOT exceed even briefly — PTS limit curves use this rate as design-basis
Caution: cooldown rate of 100 °F/hr is the ABSOLUTE LIMIT; target operation at 50 °F/hr or slower to maintain PTS margin
- Cooldown progressing within Tech Spec, RCS conditions stable → #depressurize
  Because: cooldown control established; proceed to controlled depressurization
- Heat sink degraded during cooldown (AFW lost OR steam release path lost) → [[FR-H.1]]
  Because: heat-sink response required; cooldown cannot continue without it

## Step 3 [id: depressurize]
Action: depressurize RCS toward RHR cut-in pressure (~390 psig) using pressurizer normal spray (if RCPs running) OR auxiliary spray (RCP-tripped) OR PORVs «PORV-456A» / «PORV-456B» (last resort)
Within: depressurization rate must not exceed PTS limit — track «TE-411-COLD» / «PT-455» trajectory continuously
Caution: depressurization with cold-leg-injection still active causes upper-head void formation as pressure drops below the upper-head saturation point; verify head-vent path available via [[FR-I.3]] alignment before significant depressurization
- RHR cut-in conditions reached (RCS pressure ≤ 390 psig, Tcold ≤ 350 °F) → #transfer-to-recirc
  Because: ready to align RHR for long-term cooling
- PTS limit being approached (trajectory crossing curve) → [[FR-P.1]]
  Because: PTS RED-path response interrupts depressurization

## Step 4 [id: transfer-to-recirc]
Check: RWST level «RWST-LVL» trend; remaining usable RWST inventory
- RWST approaching low-low setpoint → [[ES-1.3]]
  Because: cold-leg recirculation transfer required to maintain SI from sump
- RWST adequate AND cooldown complete → END
  Because: post-LOCA cooldown succeeded without recirculation transfer; transfer to Operations cold-shutdown procedures
- RWST adequate AND cooldown not yet complete → #initiate-cooldown
  Because: continue cooldown loop until cut-in conditions reached

## Tags

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: PZR-LVL
  description: pressurizer level
  sim-path: rcs.pressurizer.level
  units: percent
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: PZR-HTR
  description: pressurizer heater bank energization status
  sim-path: rcs.pressurizer.heaters.status
  units: enum[OFF,ON,FAULT]
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

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

- id: TE-411-COLD
  description: RCS loop 1 cold-leg temperature
  sim-path: rcs.loop1.t_cold
  units: degF
  equipment: rcs-loop-1
  source: Vogtle UFSAR §5.1.1

- id: CHG-FLOW
  description: charging flow rate
  sim-path: cvcs.charging.flow
  units: gpm
  equipment: charging-system
  source: Vogtle UFSAR §9.3.4

- id: STEAM-DUMP
  description: condenser steam dump availability (auto-permissive flag)
  sim-path: secondary.steam_dump.available
  units: bool
  equipment: secondary
  source: Vogtle UFSAR §10.4.4

- id: RWST-LVL
  description: refueling water storage tank level
  sim-path: rwst.level
  units: percent
  equipment: rwst
  source: Vogtle UFSAR §6.3.2

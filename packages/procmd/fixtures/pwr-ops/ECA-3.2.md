---
type: procedure
procedure-md: 0.7
procedure-id: ECA-3.2
title: SGTR with Loss of Reactor Coolant — Saturated Recovery
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: extreme-conditions
csfs-monitored: [core-cooling, rcs-inventory, containment]
entry-triggers: [csf-orange-path]
---

# ECA-3.2 — SGTR with Loss of Reactor Coolant — Saturated Recovery

Entered from [[E-3]] or [[ECA-3.1]] when SGTR with inventory loss has
progressed to saturated RCS — subcooling lost, pressurizer level low or
empty. Cooldown trajectory is constrained by saturation; pressurizer
recovery is not viable until cooldown allows RCS pressure to drop.
RCS pressure tracks ruptured-SG pressure during saturated cooldown
(thermodynamic equilibrium).

CSF: core-cooling

CSF: rcs-inventory

CSF: containment

## Step 1 [id: confirm-saturated]
Check: subcooling margin «SUB-MARGIN» at or near zero; pressurizer level «PZR-LVL» off-scale low or empty; core-exit thermocouples «CET-AVG» at T_sat; RVLS «RVLS-DYN» showing voiding above core
Caution: saturated SGTR is the FR-C.1 precursor — if vessel level drops or CETs go superheated, escalate immediately
- Saturated confirmed → #stabilize-inventory
  Because: saturated-recovery procedure engages
- Subcooling restored (transient saturation only) → [[ECA-3.1]]
  Because: subcooled-recovery resumes

## Step 2 [id: stabilize-inventory]
Action: maintain SI «SI-PUMP-A» / «SI-PUMP-B» flow at maximum available; allow RCS pressure «PT-455» to track ruptured-SG pressure «SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR» (the equilibrium condition under saturated SGTR)
Action: verify core cooling adequate via CET «CET-AVG» and RVLS «RVLS-DYN» — must remain at T_sat with core covered, NOT superheating
Caution: monitor for inadequate core cooling continuously; any CET superheating or RVLS dropping toward core elevation escalates to FR-C.1
- Inventory stable (CETs at T_sat, RVLS stable above core) → #cooldown-saturated
  Because: ready to cool down via intact-SG path
- Inventory loss continuing → [[FR-C.1]]
  Because: inadequate-core-cooling response

## Step 3 [id: cooldown-saturated]
Action: cool down using intact SGs at maximum Tech Spec allowable rate (100 °F/hr) via condenser dump or ARVs «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» on intact SGs
Within: speed matters — every minute of saturated SGTR drives continuing radiological release through the ruptured SG
Note: as cooldown progresses, ruptured-SG pressure drops in parallel with RCS pressure; subcooling will return as cooldown succeeds, allowing transition back to ECA-3.1 trajectory
- Cooldown achieved AND subcooling restored → [[ES-3.2]]
  Because: post-SGTR blowdown cooldown procedure
- Cooldown not progressing → [[ECA-3.3]]
  Because: alternative pressure-control procedure when steam-dump path is impaired

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

- id: CET-AVG
  description: core-exit thermocouple average (5+ representative locations across the core)
  sim-path: rcs.core_exit.thermocouple.avg
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §7.5

- id: RVLS-DYN
  description: reactor vessel level indication system, dynamic-pressure-compensated channel
  sim-path: rcs.rvls.dynamic.level
  units: percent_collapsed_liquid
  equipment: rcs
  source: Vogtle UFSAR §7.5

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

- id: SG-A-PR
  description: SG-A steam pressure
  sim-path: secondary.sg.a.steam_pressure
  units: psig
  equipment: sg-a
  source: Vogtle UFSAR §10.3

- id: SG-B-PR
  description: SG-B steam pressure
  sim-path: secondary.sg.b.steam_pressure
  units: psig
  equipment: sg-b
  source: Vogtle UFSAR §10.3

- id: SG-C-PR
  description: SG-C steam pressure
  sim-path: secondary.sg.c.steam_pressure
  units: psig
  equipment: sg-c
  source: Vogtle UFSAR §10.3

- id: SG-D-PR
  description: SG-D steam pressure
  sim-path: secondary.sg.d.steam_pressure
  units: psig
  equipment: sg-d
  source: Vogtle UFSAR §10.3

- id: ARV-A
  description: SG-A atmospheric relief valve position
  sim-path: secondary.arv.a.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: sg-a-msl
  source: Vogtle UFSAR §10.3.2

- id: ARV-B
  description: SG-B atmospheric relief valve position
  sim-path: secondary.arv.b.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: sg-b-msl
  source: Vogtle UFSAR §10.3.2

- id: ARV-C
  description: SG-C atmospheric relief valve position
  sim-path: secondary.arv.c.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: sg-c-msl
  source: Vogtle UFSAR §10.3.2

- id: ARV-D
  description: SG-D atmospheric relief valve position
  sim-path: secondary.arv.d.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: sg-d-msl
  source: Vogtle UFSAR §10.3.2

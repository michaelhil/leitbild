---
type: procedure
procedure-md: 0.7
procedure-id: ECA-3.1
title: SGTR with Loss of Reactor Coolant — Subcooled Recovery
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: extreme-conditions
csfs-monitored: [core-cooling, rcs-inventory, containment]
entry-triggers: [csf-orange-path]
---

# ECA-3.1 — SGTR with Loss of Reactor Coolant — Subcooled Recovery

Entered from [[E-3]] when SGTR coexists with significant LOCA-style RCS
inventory loss but the RCS remains subcooled (positive «SUB-MARGIN»).
Subcooled cooldown path is preferred because pressurizer remains
controllable and leak termination via depressurization below ruptured-
SG pressure is achievable. Vogtle UFSAR §15.6.3 covers SGTR with
concurrent inventory loss analysis.

CSF: core-cooling

CSF: rcs-inventory

CSF: containment

## Step 1 [id: verify-subcooled]
Check: RCS subcooling margin «SUB-MARGIN» ≥ 30 °F at lowest cold-leg AND core exit; pressurizer level «PZR-LVL» on-scale and recoverable (rising under charging)
- Subcooled AND inventory recoverable → #initiate-cooldown
  Because: subcooled-recovery prerequisites met
- Saturated conditions developing → [[ECA-3.2]]
  Because: saturated-recovery procedure handles the case where subcooling is lost

## Step 2 [id: initiate-cooldown]
Within: 60 minutes — leak duration drives integrated release; subcooled cooldown rate is unbounded by saturation but bounded by Tech Spec ≤100 °F/hr
Action: cool down using intact SGs at ≤50 °F/hr (conservative); steam dump via condenser preferred, ARVs «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» on intact SGs as needed
Action: throttle SI «SI-PUMP-A» / «SI-PUMP-B» to maintain subcooling but reduce mass addition rate that drives pressurizer level
Action: control pressurizer pressure «PT-455» and level «PZR-LVL» during cooldown
- Cooldown on schedule, subcooling maintained → #depressurize
  Because: ready to depressurize below ruptured-SG pressure
- Cooldown lagging or subcooling threatened → [[ECA-3.2]]
  Because: saturated-recovery path engages

## Step 3 [id: depressurize]
Action: depressurize RCS «PT-455» below ruptured-SG pressure (compare to «SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR» on the ruptured SG); use pressurizer normal/auxiliary spray or PORV «PORV-456A» / «PORV-456B»
Caution: maintain subcooling margin «SUB-MARGIN» ≥ 30 °F throughout depressurization — too-rapid depressurization can lose subcooling and flip to ECA-3.2
- Leak terminated (RCS pressure ≤ ruptured-SG pressure, no continued primary-to-secondary flow) → [[ES-3.1]]
  Because: post-SGTR backfill cooldown procedure
- Cannot depressurize (failed PORV, lost pressurizer spray) → [[ECA-3.3]]
  Because: SGTR-without-pressure-control procedure

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

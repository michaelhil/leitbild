---
type: procedure
procedure-md: 0.7
procedure-id: ES-3.1
title: Post-SGTR Cooldown Using Backfill
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: recovery-procedure
csfs-monitored: [heat-sink, containment]
entry-triggers: [post-trip-stable]
---

# ES-3.1 — Post-SGTR Cooldown Using Backfill

Entered from [[E-3]] or [[ECA-3.1]] after the SGTR leak has been
terminated (RCS pressure equalized with or below ruptured-SG pressure)
and the ruptured SG can be backfilled with condensate or AFW from a
clean source. Backfill keeps the ruptured SG level controlled while
cooldown proceeds via the intact SGs — the preferred post-SGTR path
because it does not require atmospheric or contaminated-condenser
release.

CSF: heat-sink

CSF: containment

## Step 1 [id: confirm-leak-terminated]
Check: RCS pressure «PT-455» ≤ ruptured SG pressure — compare against «SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR» as appropriate to the identified ruptured SG; no continued primary-to-secondary flow indications (ruptured SG level stable not rising, «SG-A-N16» / «SG-B-N16» / «SG-C-N16» / «SG-D-N16» trending down)
Caution: leak-termination criterion is rate of change, not absolute level — confirm trend persists ≥ 5 minutes
- Leak terminated AND conditions stable → #initiate-backfill
  Because: backfill prerequisites met
- Leak continuing OR uncertain → [[ECA-3.1]]
  Because: extreme-conditions SGTR procedure with continuing leak

## Step 2 [id: initiate-backfill]
Within: backfill is initiated after leak termination and held throughout the cooldown phase
Action: align condensate or auxiliary feedwater to ruptured SG via «BACKFILL-VALVE»; throttle to maintain ruptured-SG level at no-load setpoint
Caution: backfill source must be uncontaminated — verify condensate / AFW source is not the demin water tank or other potentially-contaminated source
Caution: if backfill flow cannot be controlled to maintain ruptured-SG level (overfeed or no flow), fall back to blowdown via ES-3.2
- Backfill flow established, ruptured-SG level controlled → #cooldown
  Because: backfill operating; proceed to cooldown
- Cannot backfill (no clean source, valve failure) → [[ES-3.2]]
  Because: blowdown-based cooldown procedure

## Step 3 [id: cooldown]
Action: cool down using intact SGs at allowable rate (≤50 °F/hr conservative); maintain backfill to ruptured SG throughout cooldown
Within: cooldown to RHR cut-in conditions typically takes 12-24 hours from SGTR start
Note: ruptured-SG pressure tracks RCS pressure during cooldown (no continued leak); ruptured-SG level decreases as cooldown proceeds and steam space expands
- Cooldown complete to Mode 4 / RHR conditions → END
  Because: post-SGTR cooldown succeeded; transfer to Operations Mode 5 cooldown procedures
- Cooldown stalled (heat-sink degraded on intact SGs) → [[FR-H.1]]
  Because: heat-sink RED-path response

## Tags

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

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

- id: SG-A-N16
  description: SG-A main steam line N-16 radiation monitor
  sim-path: rad.msl.a.n16
  units: cps
  equipment: sg-a-msl
  source: Vogtle UFSAR §11.5

- id: BACKFILL-VALVE
  description: ruptured-SG backfill alignment valve (condensate or AFW source selector)
  sim-path: secondary.backfill.valve
  units: enum[ISOLATED,AFW,CONDENSATE,FAULT]
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: SG-B-N16
  description: SG-B main steam line N-16 radiation monitor
  sim-path: rad.msl.b.n16
  units: cps
  equipment: sg-b-msl
  source: Vogtle UFSAR §11.5

- id: SG-C-N16
  description: SG-C main steam line N-16 radiation monitor
  sim-path: rad.msl.c.n16
  units: cps
  equipment: sg-c-msl
  source: Vogtle UFSAR §11.5

- id: SG-D-N16
  description: SG-D main steam line N-16 radiation monitor
  sim-path: rad.msl.d.n16
  units: cps
  equipment: sg-d-msl
  source: Vogtle UFSAR §11.5

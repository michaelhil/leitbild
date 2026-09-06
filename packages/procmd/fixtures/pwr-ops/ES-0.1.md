---
type: procedure
procedure-md: 0.7
procedure-id: ES-0.1
title: Reactor Trip Response
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: recovery-procedure
csfs-monitored: [subcriticality, core-cooling, heat-sink, rcs-integrity, containment, rcs-inventory]
entry-triggers: [post-trip-stable]
---

# ES-0.1 — Reactor Trip Response

Entered from [[E-0]] when post-trip plant conditions are stable: no
LOCA, no SGTR, no faulted SG, no challenged CSF. ES-0.1 is the "clean
path" — the most common destination from E-0 — and stabilizes the plant
in hot standby (Mode 3) while the cause of the trip is diagnosed and a
recovery path is selected. CSF status trees remain in service in
parallel.

CSF: subcriticality

CSF: core-cooling

CSF: heat-sink

CSF: rcs-integrity

CSF: containment

CSF: rcs-inventory

## Step 1 [id: verify-stable-conditions]
Check: RCS pressure «PT-455» stable in normal post-trip band (~2235 psig nominal, controlled by pressurizer heaters); pressurizer level «PZR-LVL» in normal control band; SG narrow-range levels «SG-A-LVL-NR» / «SG-B-LVL-NR» / «SG-C-LVL-NR» / «SG-D-LVL-NR» being controlled to no-load setpoint by AFW; no abnormal radiation in containment «CTMT-RAD»; subcooling margin «SUB-MARGIN» ≥ 30 °F
- All conditions stable → #stabilize-hot-standby
  Because: clean-path entry; proceed to hot-standby stabilization
- Any condition not stable → [[ES-0.0]]
  Because: rediagnosis required when post-trip conditions don't match the clean-path expectation

## Step 2 [id: stabilize-hot-standby]
Within: 30 minutes to reach steady hot-standby conditions
Action: stabilize Tavg «TAVG» at no-load setpoint (~547 °F per Vogtle Tech Spec Mode 3); use SG steam-dump via condenser to control Tavg
Action: control RCS pressure «PT-455» at no-load setpoint via pressurizer heaters and normal spray
Action: maintain SG levels at no-load setpoint via AFW or main feedwater (if MFW available and intact)
Action: verify Mode 3 conditions: Keff < 0.99 (subcritical), Tavg ≥ 350 °F, RCS pressure ≥ 1865 psig (Vogtle Tech Spec 1.0 mode definitions)
Caution: do not initiate any cooldown maneuvers from this step — hot standby is the goal; cooldown is a separate Operations decision via the recovery-path step
- Hot standby achieved (Tavg / pressure / levels all at no-load setpoints AND stable for ≥ 15 min) → #determine-recovery-path
  Because: stabilization confirmed
- Cannot stabilize (any control loop diverging or unable to maintain setpoint) → [[ES-0.0]]
  Because: rediagnosis required

## Step 3 [id: determine-recovery-path]
Decision: determine the recovery path based on Operations objective, equipment status, and reactor-startup readiness
1. Restart desired in current operating cycle, no equipment problems precluding restart — proceed to reactor-startup procedures (outside this EOP scope)
2. Cooldown to cold shutdown (Mode 5) for inspection, maintenance, or refueling — use natural-circulation cooldown if RCPs unavailable, normal cooldown otherwise
3. Loss of normal heat sink in process even though stable now — fall back to FR-H.1 framework
- Restart desired, no equipment problems → END
  Because: ES-0.1 exits to plant-startup procedures (not part of EOP set)
- Cooldown to cold shutdown desired → [[ES-0.2]]
  Because: natural-circulation cooldown procedure covers RCP-tripped path; normal cooldown handled by Operations procedures
- Heat-sink loss developing → [[FR-H.1]]
  Because: heat-sink RED-path response applies if AFW path is lost during stabilization

## Tags

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

- id: CTMT-RAD
  description: containment area radiation monitor
  sim-path: rad.containment.high_range
  units: rem_per_hr
  equipment: containment
  source: Vogtle UFSAR §6.2

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

- id: TAVG
  description: RCS average temperature (4-loop average)
  sim-path: rcs.t_avg
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §5.1.1

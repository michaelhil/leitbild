---
type: procedure
procedure-md: 0.7
procedure-id: FR-Z.2
title: Response to Containment Flooding
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [containment]
entry-triggers: [csf-orange-path]
---

# FR-Z.2 — Response to Containment Flooding

**CSF containment — ORANGE path.** Entered when containment sump level
exceeds the design-basis post-LOCA level (typically corresponds to ~85%
RWST + spray volume per Vogtle UFSAR §6.2.2). Sump flooding past
design level threatens: (1) submergence of safety-related equipment
mounted in lower containment, (2) buoyancy challenge to containment-
isolation valves, and (3) overflow into auxiliary building if any
penetration is degraded. Two scenarios drive entry: a continuing LOCA
inventory contribution beyond design-basis, or containment spray
running longer than spray-termination criteria require.

CSF: containment

## Step 1 [id: verify-flooding]
Check: containment sump level «CTMT-SUMP-LVL» above post-LOCA design level (typically > 85% per Tech Spec 3.6 figure); containment temperature «CTMT-TEMP» and pressure «CTMT-PR»
Caution: high sump level alone is not flooding — must be ABOVE expected post-LOCA inventory accounting (RWST delivered minus expected RCS retention)
- Flooding confirmed → #identify-source
  Because: ORANGE-path response: identify and mitigate
- False alarm or within expected envelope → [[E-0]]
  Because: return to diagnostic flow

## Step 2 [id: identify-source]
Decision: identify the source of containment flooding
1. Ongoing LOCA delivering RCS inventory beyond design-basis — RCS pressure «PT-455» continues to drop or RWST level «RWST-LVL» depleting faster than expected
2. Containment spray running past termination criteria — spray flow «SPRAY-FLOW» continues with «CTMT-PR» in normal post-accident band
3. Non-LOCA source — auxiliary building cross-tie leak, RWST level instrument failure, or other secondary inventory pathway
- LOCA source ongoing → [[E-1]]
  Because: ongoing LOCA management takes precedence; flooding is a consequence not the leading issue
- Spray over-running → #stop-spray
  Because: throttle / stop spray to limit flooding
- Other source identified → #stop-spray
  Because: defensive action — limit further inventory addition while source identification continues

## Step 3 [id: stop-spray]
Action: throttle or stop containment spray pumps «CSPRAY-A» / «CSPRAY-B» based on cessation of spray-actuation criteria (containment pressure has returned to within spray-termination band)
Action: align spray suction to containment sump (recirculation mode) if cooldown phase has reached recirculation transfer per ES-1.3
Caution: do NOT stop spray if containment pressure is still above spray-termination band — spray termination criteria are based on pressure, not on sump level
- Sump level stabilizing → [[E-0]]
  Because: containment flooding controlled; return to diagnostic flow
- Sump level continues to rise → [[ES-1.3]]
  Because: cold-leg recirculation transfer routes RCS injection via sump; reduces RWST contribution to flooding

## Tags

- id: CTMT-SUMP-LVL
  description: containment recirculation sump level
  sim-path: containment.sump.level
  units: percent
  equipment: containment
  source: Vogtle UFSAR §6.2

- id: CTMT-PR
  description: containment building pressure
  sim-path: containment.pressure
  units: psig
  equipment: containment
  source: Vogtle UFSAR §6.2

- id: CTMT-TEMP
  description: containment average temperature
  sim-path: containment.temperature.avg
  units: degF
  equipment: containment
  source: Vogtle UFSAR §6.2

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: RWST-LVL
  description: refueling water storage tank level
  sim-path: rwst.level
  units: percent
  equipment: rwst
  source: Vogtle UFSAR §6.3.2

- id: SPRAY-FLOW
  description: containment spray total flow (header)
  sim-path: ess.cspray.header_flow
  units: gpm
  equipment: containment-spray
  source: Vogtle UFSAR §6.2.2

- id: CSPRAY-A
  description: containment spray pump A status
  sim-path: ess.cspray_pump.a.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: containment-spray
  source: Vogtle UFSAR §6.2.2

- id: CSPRAY-B
  description: containment spray pump B status
  sim-path: ess.cspray_pump.b.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: containment-spray
  source: Vogtle UFSAR §6.2.2

---
type: procedure
procedure-md: 0.7
procedure-id: ES-1.1
title: SI Termination
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: recovery-procedure
csfs-monitored: [core-cooling, rcs-inventory]
entry-triggers: [post-trip-stable]
---

# ES-1.1 — SI Termination

Entered from [[E-1]] or [[E-3]] (post-SGTR) when **all four SI
termination criteria** are met: subcooling adequate, secondary heat
sink available, RCS pressure stable or rising, pressurizer level
on-scale and recoverable. Terminates SI flow and restores normal RCS
makeup via charging and letdown. If any termination criterion is lost
after termination, immediate re-actuation of SI is required (Vogtle
UFSAR §6.3.5 ECCS termination criteria).

CSF: core-cooling

CSF: rcs-inventory

## Step 1 [id: verify-termination-criteria]
Check: all four SI termination criteria simultaneously satisfied:
  (1) subcooling margin «SUB-MARGIN» ≥ 30 °F at lowest cold-leg AND CET subcooling at core exit
  (2) secondary heat sink available — at least one intact SG with AFW flow «AFW-A-CV» / «AFW-B-CV» / «AFW-C-CV» / «AFW-D-CV» AND SG level «SG-A-LVL-NR» / «SG-B-LVL-NR» / «SG-C-LVL-NR» / «SG-D-LVL-NR» being controlled
  (3) RCS pressure «PT-455» stable or rising (NOT decreasing)
  (4) pressurizer level «PZR-LVL» on-scale low AND recoverable (typically ≥ 14% indicated and trending up under charging)
Caution: all four criteria must be met simultaneously; meeting three out of four is NOT sufficient — partial satisfaction reflects the SI is still doing its job somewhere in the inventory accounting
Note: subcooling-margin criterion is evaluated at the LOWEST of all instrumented locations (cold-leg, CET, pressurizer reference T) — single-channel reading is not sufficient
- All four criteria met for ≥ 5 minutes sustained → #terminate-si
  Because: criteria satisfied; proceed with termination
- Any criterion not met OR not yet sustained → [[E-1]]
  Because: continue LOCA management; re-evaluate at the next E-1 SI-termination-criteria check

## Step 2 [id: terminate-si]
Within: termination is performed deliberately, not rushed — verify each step before proceeding
Action: stop SI pumps «SI-PUMP-A» / «SI-PUMP-B» — leave them in standby, NOT racked out
Action: close SI cold-leg injection isolation valves; verify accumulator discharge valves «ACCUM-1» / «ACCUM-2» / «ACCUM-3» / «ACCUM-4» reposition based on RCS pressure (accumulators reseat when RCS pressure rises above their nominal pressure)
Action: restore normal charging «CHG-FLOW» (1-2 charging pumps in service, letdown «LET-FLOW» open) to maintain pressurizer level
Action: restore normal pressurizer level program control via pressure controller
Caution: monitor «SUB-MARGIN» and «PZR-LVL» continuously after termination — any loss of either criterion requires immediate SI re-actuation; do NOT clear annunciators or de-arm SI signals
- SI terminated, RCS conditions stable (pressure, subcooling, level all in normal post-trip band) for ≥ 5 minutes → #stabilize
  Because: termination successful; proceed to stabilization
- Conditions degraded after termination (subcooling lost, level drops, pressure falling) → [[E-1]]
  Because: re-actuate SI; ongoing LOCA management resumes

## Step 3 [id: stabilize]
Action: stabilize at hot-standby (Mode 3) conditions: Tavg «TAVG» at no-load (~547 °F per Vogtle Tech Spec); pressurizer pressure controlled at no-load; pressurizer level in normal program; SG levels at no-load setpoint
Within: 30 minutes to fully stable hot-standby
- Stable hot-standby achieved → [[ES-0.1]]
  Because: post-trip recovery procedure handles ongoing diagnosis and recovery-path selection
- Cooldown required (RCS leak being repaired, RHR transfer planned, refueling outage) → [[ES-1.2]]
  Because: post-LOCA cooldown procedure covers Mode 3 → Mode 4 → Mode 5 transition

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

- id: AFW-A-CV
  description: SG-A AFW control valve position
  sim-path: afw.a.cv_position
  units: percent
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: AFW-B-CV
  description: SG-B AFW control valve position
  sim-path: afw.b.cv_position
  units: percent
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: AFW-C-CV
  description: SG-C AFW control valve position
  sim-path: afw.c.cv_position
  units: percent
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: AFW-D-CV
  description: SG-D AFW control valve position
  sim-path: afw.d.cv_position
  units: percent
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

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

- id: ACCUM-1
  description: accumulator tank 1 (cold-leg loop 1) discharge isolation
  sim-path: ess.accumulator.1.discharge_valve
  units: enum[OPEN,CLOSED]
  equipment: si-system
  source: Vogtle UFSAR §6.3.2

- id: ACCUM-2
  description: accumulator tank 2 (cold-leg loop 2) discharge isolation
  sim-path: ess.accumulator.2.discharge_valve
  units: enum[OPEN,CLOSED]
  equipment: si-system
  source: Vogtle UFSAR §6.3.2

- id: ACCUM-3
  description: accumulator tank 3 (cold-leg loop 3) discharge isolation
  sim-path: ess.accumulator.3.discharge_valve
  units: enum[OPEN,CLOSED]
  equipment: si-system
  source: Vogtle UFSAR §6.3.2

- id: ACCUM-4
  description: accumulator tank 4 (cold-leg loop 4) discharge isolation
  sim-path: ess.accumulator.4.discharge_valve
  units: enum[OPEN,CLOSED]
  equipment: si-system
  source: Vogtle UFSAR §6.3.2

- id: CHG-FLOW
  description: charging flow rate
  sim-path: cvcs.charging.flow
  units: gpm
  equipment: charging-system
  source: Vogtle UFSAR §9.3.4

- id: LET-FLOW
  description: letdown flow rate
  sim-path: cvcs.letdown.flow
  units: gpm
  equipment: charging-system
  source: Vogtle UFSAR §9.3.4

- id: TAVG
  description: RCS average temperature (4-loop average)
  sim-path: rcs.t_avg
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §5.1.1

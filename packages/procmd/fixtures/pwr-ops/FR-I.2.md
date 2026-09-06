---
type: procedure
procedure-md: 0.7
procedure-id: FR-I.2
title: Response to Low Pressurizer Level
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [rcs-inventory]
entry-triggers: [csf-orange-path]
---

# FR-I.2 — Response to Low Pressurizer Level

**CSF RCS inventory — ORANGE path.** Entered when pressurizer level
drops toward the low-low setpoint or off-scale low (~14% indicated).
Loss of indicated level means loss of confirmation that RCS mass is
adequate; off-scale-low pressurizer is the precursor signature of
either an unidentified LOCA or an aggressive cooldown that has
contracted the RCS inventory faster than charging can compensate.

CSF: rcs-inventory

## Step 1 [id: verify-low-level]
Check: pressurizer level «PZR-LVL» trending toward low-low setpoint (~14% indicated); charging flow «CHG-FLOW» at maximum demand; subcooling margin «SUB-MARGIN»; RCS pressure «PT-455» stable or decreasing
Caution: low pressurizer level during planned cooldown is expected — FR-I.2 entry is unexpected low level OR level dropping faster than cooldown alone explains
- Low level confirmed (level approaching low-low, charging at max demand) → #increase-makeup
  Because: ORANGE-path action engages full inventory makeup
- Stabilized or recovering → [[E-0]]
  Because: return to diagnostic flow

## Step 2 [id: increase-makeup]
Within: 5 minutes — uncovering of pressurizer instruments means loss of level indication; corrective action is needed before that
Action: maximize charging flow «CHG-FLOW» — both charging pumps «CHG-PUMP-A» / «CHG-PUMP-B» running with control valve open as far as flow path allows
Action: isolate letdown «LET-FLOW» (close letdown isolation) to stop outflow
Action: verify SI status «SI-SIG» — if SI not active and conditions justify it (subcooling lost OR LOCA indicators present), actuate SI manually
Action: check RCS sample / inventory accounting for unexplained mass loss — small-break LOCA inside containment may not be obvious from instrumentation alone
Note: Vogtle UFSAR §15.5.1 (inadvertent letdown isolation failure) and §15.5.2 (inadvertent SI termination) are scenario references
- Pressurizer level recovering → #monitor
  Because: makeup restored RCS inventory; transition to monitoring
- Level not recovering despite max charging → [[E-1]]
  Because: LOCA management is required when makeup cannot keep up

## Step 3 [id: monitor]
Check: pressurizer level «PZR-LVL»; RCS pressure «PT-455»; subcooling «SUB-MARGIN»; vessel level «RVLS-DYN» if indicated
Within: re-evaluate every 5 min during continued low-level recovery
- Pressurizer level back in normal band AND RCS pressure stable → [[E-0]]
  Because: inventory CSF returned to GREEN
- Voiding evidence (subcooling lost OR RVLS dropping OR steam space in upper head expanding) → [[FR-I.3]]
  Because: voids-in-vessel response handles the case where mass loss has progressed to voiding
- LOCA progressing despite makeup → [[E-1]]
  Because: ongoing LOCA management

## Tags

- id: PZR-LVL
  description: pressurizer level
  sim-path: rcs.pressurizer.level
  units: percent
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

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

- id: CHG-PUMP-A
  description: charging pump A status
  sim-path: cvcs.charging_pump.a.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: charging-system
  source: Vogtle UFSAR §9.3.4

- id: CHG-PUMP-B
  description: charging pump B status
  sim-path: cvcs.charging_pump.b.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: charging-system
  source: Vogtle UFSAR §9.3.4

- id: SI-SIG
  description: safety injection actuation signal (latched)
  sim-path: ess.si.actuation_signal
  units: bool
  equipment: si-system
  source: Vogtle UFSAR §6.3

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

- id: RVLS-DYN
  description: reactor vessel level indication system, dynamic-pressure-compensated channel
  sim-path: rcs.rvls.dynamic.level
  units: percent_collapsed_liquid
  equipment: rcs
  source: Vogtle UFSAR §7.5

---
type: procedure
procedure-md: 0.7
procedure-id: FR-C.2
title: Response to Degraded Core Cooling
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [core-cooling]
entry-triggers: [csf-orange-path]
---

# FR-C.2 — Response to Degraded Core Cooling

**CSF core cooling — ORANGE path.** Entered when core-exit
temperatures are rising and subcooling margin is shrinking but the core
remains covered and a positive (though decreasing) subcooling margin
persists. Distinct from FR-C.1 (RED, ICC) — here the core has not yet
been uncovered, and the response window is wider. Recovery via
maximum-SI plus targeted operator actions (RCP restart when
permissible, RHR injection alignment, CV/AFW makeup verification)
before degradation progresses to RED. See Vogtle UFSAR §15.6.3
(degraded ECCS analysis).

CSF: core-cooling

## Step 1 [id: verify-degradation]
Check: core-exit thermocouples «CET-AVG» trending up; subcooling margin «SUB-MARGIN» positive but decreasing; reactor vessel level «RVLS-DYN» dropping (but core still covered, RVLS > 50%)
Caution: ORANGE-path criteria must be re-evaluated continuously — if any RED indicator appears (CET ≥ T_sat, RVLS < 50%, subcooling negative) escalate immediately to FR-C.1 rather than waiting in FR-C.2
Note: ORANGE-path entry is the time to make the SI lineup and RCP-restart calls deliberately, before the situation forces them under RED-path urgency
- Degradation confirmed (CETs rising, subcooling decreasing but positive, RVLS dropping but core covered) → #increase-flow
  Because: ORANGE-path response engages the operator-discretionary maximum-SI actions
- Cooling recovered (CETs stable or falling, subcooling restored ≥ 30 °F, RVLS recovering) → [[E-1]]
  Because: degradation reversed; return to LOCA flow

## Step 2 [id: increase-flow]
Within: 5 minutes of degradation confirmation — ORANGE-to-RED transition can happen quickly during ongoing LOCA inventory loss
Action: verify and restore maximum SI: all high-head SI pumps «SI-PUMP-A» / «SI-PUMP-B» running; both charging pumps «CHG-PUMP-A» / «CHG-PUMP-B» in SI alignment; accumulator discharge valves «ACCUM-1» / «ACCUM-2» / «ACCUM-3» / «ACCUM-4» open and armed
Action: if RHR available AND RCS pressure ≤ RHR shutoff head (~200 psig), align RHR to inject from RWST «RWST-LVL»
Action: assess RCP restart criteria — if subcooling margin «SUB-MARGIN» ≥ 30 °F AND RCP seal injection is available AND none of the RCPs has shown degraded-flow indications, consider restarting at least one RCP in each remaining loop to re-establish forced circulation
Caution: restarting RCPs after voiding has begun can collapse the upper-head steam bubble and momentarily worsen vessel level — only restart RCPs when subcooling is clearly recovering, not while it's still decreasing
Note: per Vogtle UFSAR §6.3, the design-basis LOCA analysis assumes RCPs are tripped early in the event; RCP restart during recovery is an operator discretionary action with the SS approval gate
- Subcooling margin restored (≥ 30 °F and rising) AND vessel level recovering → #verify-recovery
  Because: ORANGE-path response succeeded; proceed to recovery verification
- Conditions continuing to degrade (subcooling still dropping despite max-SI) → [[FR-C.1]]
  Because: RED-path escalation — inadequate core cooling response takes precedence

## Step 3 [id: verify-recovery]
Check: subcooling margin «SUB-MARGIN» ≥ 30 °F and stable or rising; core-exit thermocouples «CET-AVG» stable or falling; reactor vessel level «RVLS-DYN» stable or recovering; all trends sustained for ≥ 5 minutes
- All recovery criteria met for ≥ 5 minutes → [[E-1]]
  Because: CSF core cooling restored to GREEN; LOCA flow at E-1 resumes
- Any criterion not met → [[FR-C.1]]
  Because: ORANGE-path actions did not restore margin; RED-path response is required

## Tags

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

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

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

- id: RWST-LVL
  description: refueling water storage tank level
  sim-path: rwst.level
  units: percent
  equipment: rwst
  source: Vogtle UFSAR §6.3.2

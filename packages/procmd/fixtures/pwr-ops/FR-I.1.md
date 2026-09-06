---
type: procedure
procedure-md: 0.7
procedure-id: FR-I.1
title: Response to High Pressurizer Level
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [rcs-inventory]
entry-triggers: [csf-orange-path]
---

# FR-I.1 — Response to High Pressurizer Level

**CSF RCS inventory — ORANGE path.** Entered when pressurizer level is
approaching the upper limit (~92% indicated level, where loss of steam
bubble produces "water-solid" pressurizer operation). A solid pressurizer
cannot regulate pressure via the heater-spray-pressure feedback loop —
any further mass addition translates directly to a pressure spike against
the PORVs / safeties. Common drivers: continued SI flow after RCS
inventory is restored, charging-letdown mismatch, surge from cold-leg
injection driving cold water up the surge line.

CSF: rcs-inventory

## Step 1 [id: verify-high-level]
Check: pressurizer level «PZR-LVL» trending up; charging flow «CHG-FLOW» vs letdown flow «LET-FLOW» imbalance; SI status (any SI flow remaining)
Caution: pressurizer level instrumentation can read high momentarily during a depressurization transient as the steam bubble collapses — verify level trend persists for ≥ 2 min before action
- High level confirmed (level >85% indicated AND rising) → #reduce-makeup
  Because: solid pressurizer must be avoided; defensive action while margin remains
- False alarm or transient → [[E-0]]
  Because: return to diagnostic flow

## Step 2 [id: reduce-makeup]
Within: 5 minutes — solid pressurizer can occur within minutes if SI is running
Action: throttle charging via «CHG-PUMP-A» / «CHG-PUMP-B» speed control or alignment; place charging on MANUAL low
Action: maximize letdown «LET-FLOW» if VCT is not full and letdown heat-exchanger is available
Action: if SI is still injecting AND RCS conditions justify SI termination per termination criteria (subcooling, heat sink, pressure stable, level recoverable), proceed with SI termination per [[ES-1.1]]
Caution: do NOT terminate SI just to reduce pressurizer level — SI termination is governed by the four termination criteria; high pressurizer level alone is not one of them
- Level controlled (stable or decreasing) → #monitor
  Because: ORANGE-path action succeeded
- Cannot reduce level despite throttling all makeup → [[FR-P.1]]
  Because: solid pressurizer + continued mass addition is the PTS precursor when cold-leg injection is the surge source

## Step 3 [id: monitor]
Check: pressurizer level «PZR-LVL» trend; RCS pressure «PT-455» stability
Within: re-evaluate every 5 min while makeup is throttled
- Pressurizer level stable in normal band (50-70%) → [[E-0]]
  Because: inventory CSF returned to GREEN
- Solid pressurizer (level pegged high, no steam space) → [[FR-P.1]]
  Because: PTS-trajectory risk on cold-leg cooldown with high RCS pressure

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

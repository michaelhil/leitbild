---
type: procedure
procedure-md: 0.7
procedure-id: FR-S.1
title: Response to Nuclear Power Generation / ATWS
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [subcriticality]
entry-triggers: [csf-red-path]
---

# FR-S.1 — Response to Nuclear Power Generation / ATWS

**CSF subcriticality — RED path.** Entered when reactor power persists
after a trip signal (ATWS) or when post-trip neutron flux is not
decreasing as expected. Restores subcriticality by exercising every
available means: manual trip, local trip-breaker action, emergency
boration, and turbine isolation to limit moderator-temperature feedback
reactivity insertion (per Vogtle UFSAR §15.4.9 ATWS analysis).

The 10 CFR 50.62 ATWS Mitigation System Actuation Circuitry (AMSAC) is
an independent backup that trips the turbine and initiates AFW on ATWS
conditions; this procedure assumes AMSAC has already acted or will act
in parallel.

CSF: subcriticality

## Step 1 [id: verify-power-generation]
Check: neutron flux indications «NIS-PR-AVG» (power range), «NIS-IR» (intermediate range), and «NIS-SR» (source range) trends; rod bottom lights «ROD-POS-AVG»; reactor trip pushbutton «RT-PB» status
Caution: positive moderator temperature coefficient (during low-boron or end-of-cycle conditions) can drive reactivity insertion as RCS cools — turbine isolation is part of the response, not optional
Note: confirm power generation rather than instrumentation failure before initiating manual trip — a stuck NIS detector reading "100%" with all rods bottomed is not ATWS
- Power generation confirmed (flux not decreasing OR rod position not bottomed) → #manual-trip
  Because: ATWS criteria met — RED path entry is required
- Indications consistent with successful trip (flux decaying, rods bottomed, false NIS alarm) → [[E-0]]
  Because: return to diagnostic flow; no actual ATWS

## Step 2 [id: manual-trip]
Within: 2 minutes of ATWS recognition — every additional minute of full-power operation drives RCS heatup against an inadequate heat sink
Action: depress both reactor trip pushbuttons «RT-PB» simultaneously
Action: if pushbuttons do not trip the breakers, verify trip breakers «TRIP-BKR-A» / «TRIP-BKR-B» status; dispatch operator to open trip breakers locally at the breaker cabinets
Action: verify turbine has tripped (AMSAC or manual); if turbine still running, trip turbine manually to remove the heat sink mismatch
Caution: do NOT insert control rods manually from the rod-control console until trip-breaker action has been verified — driving rods in against a stuck rod-control system can damage drive mechanisms
- Reactor tripped (breakers open, rods bottoming, flux decaying) → #verify-shutdown
  Because: standard recovery path; verify before declaring restored
- Trip breakers will not open by any means → #emergency-boration
  Because: boration becomes the only available subcriticality path; AMSAC AFW + turbine isolation limit consequences while boration takes effect

## Step 3 [id: emergency-boration]
Within: 1 minute of trip-failure recognition — boration timeline is critical; subcritical boron concentration must be reached before refueling-water-storage-tank boron dilutes through the active core
Action: align charging pumps «CHG-PUMP-A» / «CHG-PUMP-B» suction to boric acid tank «BAT-LVL» (not RWST during initial response)
Action: open emergency boration flowpath valves; verify boron flow indication «BORATE-FLOW» rising
Action: maintain at least one running RCP per loop if available (boron mixing is dramatically slower without forced circulation) — but do NOT restart tripped RCPs if subcooling is lost
Caution: high-concentration boric acid can precipitate if charging-pump suction temperature falls below the BAT solubility line (typically 145 °F at 4 wt% boric acid per Vogtle Tech Spec 3.5) — verify BAT and charging-line heat-tracing
Note: AFW alignment via AMSAC should already be in service; verify «AFW-PUMP-A» / «AFW-PUMP-B» / «AFW-PUMP-T» running and feeding SGs
- Subcriticality achieved (flux dropping below shutdown level, S/R count rate falling) → #verify-shutdown
  Because: standard verification path
- Borate flow established but flux still not decreasing after 5 minutes → [[FR-S.2]]
  Because: degraded subcriticality — ORANGE path with extended shutdown-margin restoration
- Cannot establish any boration flow path → [[FR-S.2]]
  Because: ORANGE path covers alternative shutdown-margin restoration options

## Step 4 [id: verify-shutdown]
Check: neutron flux at or below shutdown level («NIS-PR-AVG» < 5×10⁻¹¹ A typical post-trip, source range «NIS-SR» count rate stable or decaying); rod position «ROD-POS-AVG» bottomed; RCS boron sample if available
Note: shutdown margin verification requires sample confirmation eventually, but flux + rod-position is sufficient for immediate procedure exit
- All three criteria confirmed (flux down, rods bottomed, boron adequate or trending up) → [[E-0]]
  Because: subcriticality CSF restored to GREEN; return to diagnostic flow at E-0 step 1
- Flux down, rods bottomed, but boron sample low → #emergency-boration
  Because: low-margin subcriticality requires continued boration before exit
- Indications mixed or unstable → #emergency-boration
  Because: continue exercising emergency-boration response until margin is clearly restored

## Tags

- id: NIS-PR-AVG
  description: nuclear instrumentation power-range average (4-channel)
  sim-path: nis.power_range.avg
  units: percent
  equipment: nuclear-instrumentation
  source: Vogtle UFSAR §7.7

- id: NIS-IR
  description: nuclear instrumentation intermediate range
  sim-path: nis.intermediate_range.avg
  units: amps
  equipment: nuclear-instrumentation
  source: Vogtle UFSAR §7.7

- id: NIS-SR
  description: nuclear instrumentation source range count rate
  sim-path: nis.source_range.count_rate
  units: cps
  equipment: nuclear-instrumentation
  source: Vogtle UFSAR §7.7

- id: ROD-POS-AVG
  description: average control rod bottom position
  sim-path: rcs.rod.position.avg
  units: steps_withdrawn
  equipment: rod-control-system
  source: Vogtle UFSAR §7.7

- id: RT-PB
  description: reactor trip pushbutton (front-panel) state
  sim-path: rps.manual_trip.pushbutton
  units: enum[NORMAL,DEPRESSED]
  equipment: reactor-protection-system
  source: Vogtle UFSAR §7.2

- id: TRIP-BKR-A
  description: reactor trip breaker A position
  sim-path: rps.trip_breaker.a.position
  units: enum[OPEN,CLOSED]
  equipment: reactor-protection-system
  source: Vogtle UFSAR §7.2

- id: TRIP-BKR-B
  description: reactor trip breaker B position
  sim-path: rps.trip_breaker.b.position
  units: enum[OPEN,CLOSED]
  equipment: reactor-protection-system
  source: Vogtle UFSAR §7.2

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

- id: BAT-LVL
  description: boric acid tank level
  sim-path: cvcs.bat.level
  units: percent
  equipment: charging-system
  source: Vogtle UFSAR §9.3.4

- id: BORATE-FLOW
  description: emergency boration flow rate
  sim-path: cvcs.borate.flow
  units: gpm
  equipment: charging-system
  source: Vogtle UFSAR §9.3.4

- id: AFW-PUMP-A
  description: motor-driven AFW pump A status
  sim-path: afw.pump.a.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: AFW-PUMP-B
  description: motor-driven AFW pump B status
  sim-path: afw.pump.b.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: AFW-PUMP-T
  description: turbine-driven AFW pump status
  sim-path: afw.pump.tdafw.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

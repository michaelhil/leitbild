---
type: procedure
procedure-md: 0.7
procedure-id: FR-C.1
title: Response to Inadequate Core Cooling
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [core-cooling]
entry-triggers: [csf-red-path]
---

# FR-C.1 — Response to Inadequate Core Cooling

**CSF core cooling — RED path.** Entered when core exit thermocouple
readings are saturated or superheated AND reactor vessel level
indication shows core partially uncovered, OR when ECCS flow blockage
prevents adequate heat removal during a LOCA. This is the most severe
challenge to core cooling and represents the entry to inadequate-core-
cooling territory (the regime that drove TMI-2 in 1979). Recovery is by
maximum SI flow combined with controlled RCS depressurization to widen
the SI injection window; if that fails, emergency feed-and-bleed via
PORVs becomes the last barrier before SAMG entry (Vogtle UFSAR §15.6.5
inadequate-core-cooling analysis).

CSF: core-cooling

## Step 1 [id: verify-icc]
Check: core-exit thermocouples «CET-AVG» reading saturated (CET ≥ T_sat at «PT-455») OR superheated; reactor vessel level «RVLS-DYN» below the upper-head two-phase mixture level; subcooling margin «SUB-MARGIN» negative or zero
Caution: CETs reading high with normal pressurizer level may indicate a stuck-open PORV venting steam from the upper head — verify «PORV-456A» / «PORV-456B» status before declaring ICC
Note: TMI-2 lesson — operator must trust CET indications even when conflicting "normal" indicators are present
- Inadequate core cooling confirmed (CETs ≥ T_sat AND vessel level low AND no subcooling) → #maximize-si
  Because: RED-path response is non-discretionary; speed of escalation matters
- Indications consistent with recovery (CETs decreasing, vessel level recovering, subcooling returning) → [[E-1]]
  Because: return to LOCA flow; cooling has been re-established

## Step 2 [id: maximize-si]
Within: 2 minutes of ICC confirmation — clad-temperature rise in uncovered fuel can reach 100 °F/min at decay-heat power
Action: verify ALL high-head SI pumps «SI-PUMP-A» / «SI-PUMP-B» running; verify charging pumps «CHG-PUMP-A» / «CHG-PUMP-B» in SI alignment
Action: ensure accumulators armed («ACCUM-1» / «ACCUM-2» / «ACCUM-3» / «ACCUM-4» discharge valves open, isolation valves open)
Action: depressurize RCS by opening pressurizer PORVs «PORV-456A» AND «PORV-456B» if RCS pressure exceeds high-head SI shutoff head (~1500 psig); this opens the injection window to accumulator (~600 psig) and low-head pumps (~200 psig)
Caution: rapid depressurization can worsen voiding in the upper head and may collapse the steam bubble that was previously stabilizing vessel level — coordinate with the shift supervisor; pressure should drop in a controlled manner, not free-fall
Note: per Vogtle UFSAR §15.6.5, the design-basis assumption is that all available SI pumps inject; manual alignment is the backup
- Core cooling restored (CETs subcooled, vessel level recovering, subcooling returning) → #verify-recovery
  Because: maximum-SI response succeeded; proceed to recovery verification
- Maximum SI not restoring cooling within 5 minutes → #emergency-bleed
  Because: feed-and-bleed is the last barrier before SAMG entry

## Step 3 [id: emergency-bleed]
Within: 1 minute of #maximize-si failure recognition
Action: open BOTH PORVs «PORV-456A» AND «PORV-456B» fully (block valves «BLOCK-456A» / «BLOCK-456B» OPEN) and lock them open via control-room signal
Action: confirm full SI flow from RWST through all available paths into containment sump (feed phase via SI; bleed phase via PORVs venting to pressurizer relief tank, which ruptures its disc, delivering inventory to containment sump)
Action: verify containment sump «CTMT-SUMP-LVL» rising — confirms the bleed path is intact
Caution: feed-and-bleed at full SI + open PORVs consumes RWST inventory at ~3000 gpm; cold-leg recirculation transfer (ES-1.3) MUST be ready before RWST reaches low-low setpoint
Caution: this action is irreversible from a containment-cleanup standpoint — the entire RWST contents end up in containment sump; consequences are significant but inadequate core cooling consequences are worse
- Subcooling and vessel level recovering during feed-and-bleed → #verify-recovery
  Because: feed-and-bleed succeeded; verify before declaring recovery
- Subcooling and vessel level NOT recovering after 10 minutes of feed-and-bleed → [[FR-C.2]]
  Because: degraded-cooling response handles the slower-progression regime; if feed-and-bleed is partially effective the response may stabilize at ORANGE rather than RED
Note: if conditions degrade toward core damage indicators (CET superheat > 1200 °F, rapid vessel level decrease, hydrogen indications) the response transitions out of the EOP set into the SAMG (Severe Accident Management Guidance) procedure set — Vogtle SAMG entry conditions per WCAP-13914. This wiki does not yet hold SAMG content; flag for owner.

## Step 4 [id: verify-recovery]
Check: core-exit thermocouples «CET-AVG» subcooled (CET < T_sat - 30 °F); reactor vessel level «RVLS-DYN» recovering; subcooling margin «SUB-MARGIN» ≥ 30 °F and increasing
Within: hold this step for at least 5 minutes of stable, improving trends before exit — premature exit risks oscillation back to RED
- All three indicators recovered AND stable for ≥5 minutes → [[E-1]]
  Because: CSF core cooling restored to GREEN; LOCA flow at E-1 resumes
- One or more indicator not yet recovered → #maximize-si
  Because: recovery incomplete; re-exercise maximum-SI before considering exit

## Tags

- id: CET-AVG
  description: core-exit thermocouple average (5+ representative locations across the core)
  sim-path: rcs.core_exit.thermocouple.avg
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §7.5 (CET system added per NUREG-0737 II.F.2)

- id: RVLS-DYN
  description: reactor vessel level indication system, dynamic-pressure-compensated channel
  sim-path: rcs.rvls.dynamic.level
  units: percent_collapsed_liquid
  equipment: rcs
  source: Vogtle UFSAR §7.5 (RVLIS per NUREG-0737 II.F.2)

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

- id: BLOCK-456A
  description: pressurizer PORV 456A block valve position
  sim-path: rcs.pressurizer.block.456a.position
  units: enum[OPEN,CLOSED]
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: BLOCK-456B
  description: pressurizer PORV 456B block valve position
  sim-path: rcs.pressurizer.block.456b.position
  units: enum[OPEN,CLOSED]
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

- id: CTMT-SUMP-LVL
  description: containment recirculation sump level
  sim-path: containment.sump.level
  units: percent
  equipment: containment
  source: Vogtle UFSAR §6.2

---
type: procedure
procedure-md: 0.7
procedure-id: FR-S.2
title: Response to Loss of Core Shutdown
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [subcriticality]
entry-triggers: [csf-orange-path]
---

# FR-S.2 — Response to Loss of Core Shutdown

**CSF subcriticality — ORANGE path.** Entered when shutdown margin is
degrading despite a successful reactor trip — boron dilution from
unborated water ingress, decay-heat-driven xenon decay, or inadequate
initial boron concentration. Detected by rising source-range count rate
or boron-concentration samples trending toward criticality. Distinct
from FR-S.1 (RED path, active power generation) — here the reactor IS
shut down but the margin to recriticality is shrinking.

Most common public dilution accident is inadvertent addition of
unborated water during boron-thermal-regulation system operation, RCS
makeup with mis-aligned valves, or RHR injection from an unborated source
during mid-loop operations. See Vogtle UFSAR §15.4.6 (boron dilution
analysis) for the design-basis cases.

CSF: subcriticality

## Step 1 [id: verify-margin-loss]
Check: source-range count rate «NIS-SR» trending up (factor-of-2 increase in any 30-minute window is the conservative recriticality indicator); RCS boron concentration «RCS-BORON» sample trending down; rod-position «ROD-POS-AVG» still bottomed
Caution: source-range count rate is logarithmic — an apparent "small" rise may be a doubling already; verify against the trending log, not just instantaneous reading
Note: during xenon transients (15–30 hours post-trip) source-range count rate naturally rises as Xe-135 decays; the discriminator is whether the rate of rise exceeds the xenon-decay envelope
- Margin loss confirmed (count rate trending up faster than xenon-decay envelope OR boron sample trending down) → #stop-dilution
  Because: ORANGE-path entry — must identify dilution source and reverse before margin reaches recriticality
- False alarm (rise within xenon-decay envelope, boron stable, rod position normal) → [[E-0]]
  Because: no dilution; return to diagnostic flow

## Step 2 [id: stop-dilution]
Action: isolate primary water makeup paths — verify «PRIMARY-WATER-VALVE» closed; verify CVCS makeup is in BORATE mode not DILUTE
Action: isolate any unborated-water sources that could leak into RCS — demin water tank cross-connects, condensate makeup, RWST makeup during shutdown modes
Action: stop RHR pumps if RHR is in service AND there is any chance the RHR suction is on an unborated source (uncommon but possible during mid-loop / drained-loop operations)
Within: 5 minutes of dilution-source-identification — every minute of continued dilution narrows the response window
Caution: stopping RHR removes decay-heat removal during shutdown; balance is between recriticality risk (short-term) and core uncovery (longer-term) — only stop RHR if there is genuine reason to suspect RHR is the dilution source
- Dilution stopped (verified all unborated-water paths isolated) → #boration
  Because: dilution must be both stopped AND reversed; boration follows isolation
- Dilution source cannot be positively identified → #boration
  Because: even without identification, immediate boration creates positive margin recovery; isolation continues in parallel

## Step 3 [id: boration]
Action: align charging pumps «CHG-PUMP-A» / «CHG-PUMP-B» suction to boric acid tank «BAT-LVL»; initiate emergency boration via «BORATE-FLOW»
Action: target the higher of: (a) full restoration to last-known-good boron concentration, or (b) cold-shutdown boron concentration per the curve in Vogtle Tech Spec 3.1.1 figure (typically 1800–2200 ppm for cold shutdown depending on cycle burnup)
Within: target 30 ppm boron addition within 30 minutes — sets a floor on margin-restoration rate
Caution: rapid boration can cool the RCS via cold borated-water injection — monitor «PT-455» and «SUB-MARGIN» during boration to avoid PTS regime; if PTS limit approached, branch to [[FR-P.1]]
Note: sampling for boron concentration confirmation has a 20–45 minute analytic turnaround; do not wait for sample to keep borating — let trending data drive the action
- Adequate shutdown margin restored (count rate decaying, boron sample confirms target reached) → [[E-0]]
  Because: subcriticality CSF restored to GREEN; return to diagnostic flow
- Boration in progress but margin still degrading (count rate continues to climb) → [[FR-S.1]]
  Because: shutdown-margin loss has progressed to RED — power generation imminent or in progress

## Tags

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

- id: RCS-BORON
  description: RCS boron concentration (sampled)
  sim-path: rcs.boron.concentration
  units: ppm
  equipment: rcs
  source: Vogtle UFSAR §9.3.4

- id: PRIMARY-WATER-VALVE
  description: primary water makeup isolation valve
  sim-path: cvcs.primary_water.makeup_valve
  units: enum[OPEN,CLOSED]
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

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4
  range: [0, 3000]

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

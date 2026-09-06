---
type: procedure
procedure-md: 0.7
procedure-id: FR-P.1
title: Response to Imminent Pressurized Thermal Shock Condition
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [rcs-integrity]
entry-triggers: [csf-red-path]
---

# FR-P.1 — Response to Imminent Pressurized Thermal Shock Condition

**CSF RCS integrity — RED path.** Entered when RCS pressure-temperature
trajectory crosses or is about to cross the reactor vessel PTS limit
curve — high RCS pressure combined with rapidly falling cold-leg
temperature. The combination loads the vessel beltline weld with a
through-wall stress gradient that can propagate brittle flaws.
Recovery is by terminating the cold-injection mechanism (stopping or
throttling SI) and re-warming the RCS with pressurizer heaters /
charging while pressure relief is held available. See Vogtle UFSAR
§5.3.3 (PTS analysis) and 10 CFR 50.61 (PTS Rule).

The PTS limit curve is plant- and cycle-specific; for Vogtle the
applicable curves are in Tech Spec 3.4.3 figures (heatup and cooldown
P-T limits, RTNDT-shifted for end-of-life vessel embrittlement).

CSF: rcs-integrity

## Step 1 [id: verify-pts-trajectory]
Check: RCS pressure «PT-455» AND cold-leg temperatures (lowest of «TE-411-COLD» / «TE-421-COLD» / «TE-431-COLD» / «TE-441-COLD»); compare against the PTS limit curve (Tech Spec 3.4.3); trajectory must be evaluated as (T_cold, P_RCS) point AND its rate of motion toward the limit
Caution: PTS is a TRAJECTORY criterion not a point criterion — entry into FR-P.1 is justified by predicted crossing within minutes, not by exceeding curve at current instant
Note: the dominant PTS-driving event is a small-break LOCA at the end of cycle, where high-pressure SI continues injecting cold borated water into the cold legs while RCS pressure remains above the SI shutoff head
- PTS trajectory confirmed (current point + trajectory crossing PTS curve within minutes) → #limit-cooldown
  Because: RED-path PTS response is non-discretionary
- Off-trajectory (point within curve, trajectory not crossing) → [[E-0]]
  Because: false alarm or recovered; return to diagnostic flow

## Step 2 [id: limit-cooldown]
Within: 5 minutes — PTS trajectory recovery requires several minutes for thermal masses to redistribute; act before further damage potential accumulates
Action: throttle high-head SI «SI-PUMP-A» / «SI-PUMP-B» flow to the minimum needed for subcooling — full SI flow with high RCS pressure is the primary PTS driver
Action: stop low-head SI / RHR injection if RCS pressure is well above accumulator setpoint (~600 psig) — accumulators won't deliver and low-head can't push against high RCS pressure anyway, but verify isolation
Action: energize pressurizer heaters «PZR-HTR» up to maximum allowed to add heat and slow cold-leg cooldown
Action: open pressurizer PORVs «PORV-456A» / «PORV-456B» if pressure must come down (PTS limit relaxes at lower pressure)
Caution: throttling SI reduces inventory makeup during an ongoing LOCA — balance PTS prevention against core-cooling need; if subcooling margin «SUB-MARGIN» drops, escalate to [[FR-C.2]]
- PTS trajectory recovering (T_cold rising OR pressure dropping into safe region) → #verify-recovery
  Because: response succeeded; verify before declaring recovery
- Cannot interrupt PTS trajectory → [[FR-P.2]]
  Because: anticipated-PTS response handles the slower-rate case; some PTS-mitigation actions may stabilize at ORANGE rather than RED

## Step 3 [id: verify-recovery]
Check: (T_cold, P_RCS) point + trajectory back inside the PTS curve with positive margin; subcooling margin «SUB-MARGIN» maintained ≥ 30 °F
Within: hold this step for ≥ 5 minutes of stable, improving trends before exit — vessel-beltline thermal-stress relaxation takes longer than instrument-loop time constants
- Off PTS trajectory AND subcooling maintained → [[E-0]]
  Because: RCS integrity CSF restored to GREEN; return to diagnostic flow
- Still challenged → [[FR-P.2]]
  Because: ORANGE-path response continues until trajectory clearly clears

## Tags

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: TE-411-COLD
  description: RCS loop 1 cold-leg temperature
  sim-path: rcs.loop1.t_cold
  units: degF
  equipment: rcs-loop-1
  source: Vogtle UFSAR §5.1.1

- id: TE-421-COLD
  description: RCS loop 2 cold-leg temperature
  sim-path: rcs.loop2.t_cold
  units: degF
  equipment: rcs-loop-2
  source: Vogtle UFSAR §5.1.1

- id: TE-431-COLD
  description: RCS loop 3 cold-leg temperature
  sim-path: rcs.loop3.t_cold
  units: degF
  equipment: rcs-loop-3
  source: Vogtle UFSAR §5.1.1

- id: TE-441-COLD
  description: RCS loop 4 cold-leg temperature
  sim-path: rcs.loop4.t_cold
  units: degF
  equipment: rcs-loop-4
  source: Vogtle UFSAR §5.1.1

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

- id: PZR-HTR
  description: pressurizer heater bank energization status
  sim-path: rcs.pressurizer.heaters.status
  units: enum[OFF,ON,FAULT]
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

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

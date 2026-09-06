---
type: procedure
procedure-md: 0.7
procedure-id: FR-P.2
title: Response to Anticipated Pressurized Thermal Shock Condition
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [rcs-integrity]
entry-triggers: [csf-orange-path]
---

# FR-P.2 — Response to Anticipated Pressurized Thermal Shock Condition

**CSF RCS integrity — ORANGE path.** Entered when RCS pressure-
temperature trajectory is heading toward the PTS limit curve but is not
yet imminently crossing. Slower-rate cooldown with continued SI;
operator action limits cooldown rate to keep trajectory inside the
Tech-Spec curve. Distinct from FR-P.1 (RED): here there is time to
adjust rate rather than emergency-stop SI; the curve is being
approached, not crossed.

CSF: rcs-integrity

## Step 1 [id: verify-trend]
Check: (T_cold from lowest of «TE-411-COLD» / «TE-421-COLD» / «TE-431-COLD» / «TE-441-COLD», P_RCS «PT-455») trajectory inside PTS curve with negative margin trending toward zero; cooldown rate exceeding Tech Spec curve guidance (typically ≤100 °F/hr below 350 °F)
- Trajectory trending toward limit (margin shrinking, cooldown rate elevated) → #limit-rate
  Because: ORANGE-path action limits rate before trajectory becomes imminent
- Trajectory stable, margin positive and not shrinking → [[E-0]]
  Because: false alarm or stable; return to diagnostic flow

## Step 2 [id: limit-rate]
Within: 10 minutes — PTS-rate margin recovery has slower time constants than RED-path response
Action: throttle SI flow «SI-PUMP-A» / «SI-PUMP-B» to the minimum subcooling demand
Action: throttle steam-dump or atmospheric-relief flow to reduce primary-cooldown rate; aim for ≤50 °F/hr below 350 °F (conservative ramp)
Action: energize pressurizer heaters «PZR-HTR» to maintain pressurizer level and offer additional heat input
Caution: ORANGE-to-RED transition can occur if SG depressurization or LOCA mass loss accelerates cooldown; if cold-leg temperature drops faster than 100 °F/hr immediately escalate to [[FR-P.1]]
- Cooldown rate within Tech Spec AND trajectory off PTS approach → #monitor
  Because: ORANGE-path response succeeded; transition to monitoring
- Trajectory worsening despite rate-limit actions → [[FR-P.1]]
  Because: RED-path PTS response is required

## Step 3 [id: monitor]
Check: (T_cold, P_RCS) trajectory vs PTS curve; cooldown rate trend
Within: re-evaluate every 10 minutes; PTS criteria are evaluated continuously throughout cooldown
- Trajectory clear of PTS curve with positive margin AND rate within Tech Spec → [[E-0]]
  Because: RCS integrity CSF returned to GREEN; return to diagnostic flow
- Trajectory becoming imminent (rate accelerating or curve being approached fast) → [[FR-P.1]]
  Because: RED-path response engages

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

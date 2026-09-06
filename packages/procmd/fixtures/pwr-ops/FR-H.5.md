---
type: procedure
procedure-md: 0.7
procedure-id: FR-H.5
title: Response to Steam Generator Low Level
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [heat-sink]
entry-triggers: [csf-yellow-path]
---

# FR-H.5 — Response to Steam Generator Low Level

**CSF heat sink — YELLOW path.** Entered when any SG narrow-range level
falls below the low setpoint (typically 17% NR per Vogtle Tech Spec)
and is trending lower. Precursor to FR-H.1 (total heat-sink loss) if
uncorrected. Distinguished from FR-H.1 by partial — not total — feedwater
availability; the response is to maximize feedwater to the affected SG
before level falls to dryout. Operating-experience driver: most plant
trips that escalate to bleed-and-feed begin as recoverable low-level
events that were not addressed quickly.

CSF: heat-sink

## Step 1 [id: verify-low-level]
Check: SG narrow-range levels «SG-A-LVL-NR» / «SG-B-LVL-NR» / «SG-C-LVL-NR» / «SG-D-LVL-NR»; identify which SG(s) below low setpoint AND trending down; AFW alignment «AFW-A-CV» / «AFW-B-CV» / «AFW-C-CV» / «AFW-D-CV» to affected SG
Caution: a single SG transient during post-trip equalization is not FR-H.5 entry; criterion is sustained low level with downward trend, no obvious overfeed elsewhere
- Low level confirmed AND trending down → #restore-feedwater
  Because: action required before progression toward FR-H.1
- Recovered or stabilized → [[E-0]]
  Because: transient resolved; return to diagnostic flow

## Step 2 [id: restore-feedwater]
Within: 5 minutes — SG dryout from low-low can occur within 10-15 minutes at decay-heat power if no feed is restored
Action: verify AFW pump status «AFW-PUMP-A» / «AFW-PUMP-B» / «AFW-PUMP-T» — all available pumps running
Action: open AFW control valve to affected SG fully (place on MANUAL if auto-control is throttling against the demand)
Action: if main feedwater available (post-trip with MFW recoverable), attempt MFW restart to affected SG via startup-feedwater path
Action: confirm AFW suction supply «CST-LVL» (condensate storage tank) adequate; if CST level low, align makeup or switch to alternate AFW suction
Caution: do NOT throttle AFW to other SGs to redistribute to the low SG — total AFW flow capacity is what matters; redistribution risks dropping a previously-adequate SG
Note: if level is responding slowly to maximum AFW, the cause may be a tube leak on the affected SG (slow SGTR) — monitor N-16 indicators
- Level recovering toward normal band → #monitor
  Because: feedwater restoration succeeded; transition to monitoring
- Level continues falling despite maximum AFW → [[FR-H.1]]
  Because: total heat-sink loss is imminent; RED-path response is required

## Step 3 [id: monitor]
Check: SG level «SG-A-LVL-NR» (or affected SG) trend, AFW flow indication, CST «CST-LVL» level
Within: re-evaluate every 5 minutes until level is stable above the low setpoint for ≥15 min
- Level stable above low setpoint for ≥15 min → [[E-0]]
  Because: heat sink CSF returned to GREEN; return to diagnostic flow
- Continued degradation → [[FR-H.1]]
  Because: escalate to RED-path response

## Tags

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

- id: CST-LVL
  description: condensate storage tank level
  sim-path: secondary.cst.level
  units: percent
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

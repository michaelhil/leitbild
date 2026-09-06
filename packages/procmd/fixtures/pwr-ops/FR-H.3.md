---
type: procedure
procedure-md: 0.7
procedure-id: FR-H.3
title: Response to Steam Generator High Level
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [heat-sink]
entry-triggers: [csf-yellow-path]
---

# FR-H.3 — Response to Steam Generator High Level

**CSF heat sink — YELLOW path.** Entered when any SG narrow-range
level exceeds the high-high alarm setpoint (typically 78% NR per Vogtle
Tech Spec). Three distinct causes drive this entry, each with a
different response: (1) AFW overfeed during recovery, (2) SGTR — rising
level from primary-to-secondary leak inventory, or (3) main feedwater
control failure. Identification of cause determines the correct
response — wrongly classifying SGTR as overfeed and stopping AFW would
remove a heat sink during ongoing radiological release.

CSF: heat-sink

## Step 1 [id: verify-high-level]
Check: SG narrow-range levels «SG-A-LVL-NR» / «SG-B-LVL-NR» / «SG-C-LVL-NR» / «SG-D-LVL-NR»; identify which SG(s) above high-high setpoint
- High-high level confirmed on one or more SGs → #identify-cause
  Because: YELLOW-path entry — must identify cause before action
- Level dropped below setpoint, transient resolved → [[E-0]]
  Because: false-alarm or transient; return to diagnostic flow

## Step 2 [id: identify-cause]
Decision: identify the cause of high SG level
1. AFW or main feedwater overfeed — flow indication shows continued feeding when level is rising; check «AFW-A-CV» / «AFW-B-CV» / «AFW-C-CV» / «AFW-D-CV» control-valve positions and AFW pump status «AFW-PUMP-A» / «AFW-PUMP-B» / «AFW-PUMP-T»
2. SGTR — affected SG also shows elevated N-16 «SG-A-N16» / «SG-B-N16» / «SG-C-N16» / «SG-D-N16» radiation; level rises despite isolated feedwater
3. Main feedwater control valve stuck open or oscillating — controller signal mismatch with valve position; isolate and place on manual
Caution: stopping AFW to an SG suspected of SGTR is wrong — leave AFW alignment in place until SGTR is ruled out
- AFW or main feedwater overfeed → #stop-overfeed
  Because: corrective action is to throttle or stop the offending feed
- SGTR indications (elevated N-16 plus rising level on the same SG) → [[E-3]]
  Because: full SGTR response, not isolated overfeed
- Cause not clear; treat as overfeed until proven otherwise → #stop-overfeed
  Because: defensive action — slows level rise; SGTR diagnosis continues in parallel

## Step 3 [id: stop-overfeed]
Action: throttle AFW control valve to affected SG («AFW-A-CV» as identified); place main feedwater controller on MANUAL and reduce demand
Within: 5 minutes — SG overfill into the steam line causes water-induced damage to the main steam piping and MSIV seats
Caution: do not stop AFW entirely on a single SG without verifying the other SGs are absorbing decay heat — partial AFW reduction is preferable to full isolation
Note: high-high SG level on multiple SGs simultaneously is unusual and suggests a common-cause AFW control failure
- SG level stable or decreasing toward normal band → [[E-0]]
  Because: high-level controlled; return to diagnostic flow
- Cannot stabilize level (continues rising despite reduced feed) → [[FR-H.5]]
  Because: low-level response handles the converse case; if level is uncontrollable in both directions a SGTR is increasingly likely — see Note above

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

- id: SG-A-N16
  description: SG-A main steam line N-16 radiation monitor
  sim-path: rad.msl.a.n16
  units: cps
  equipment: sg-a-msl
  source: Vogtle UFSAR §11.5

- id: SG-B-N16
  description: SG-B main steam line N-16 radiation monitor
  sim-path: rad.msl.b.n16
  units: cps
  equipment: sg-b-msl
  source: Vogtle UFSAR §11.5

- id: SG-C-N16
  description: SG-C main steam line N-16 radiation monitor
  sim-path: rad.msl.c.n16
  units: cps
  equipment: sg-c-msl
  source: Vogtle UFSAR §11.5

- id: SG-D-N16
  description: SG-D main steam line N-16 radiation monitor
  sim-path: rad.msl.d.n16
  units: cps
  equipment: sg-d-msl
  source: Vogtle UFSAR §11.5

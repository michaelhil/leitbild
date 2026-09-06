---
type: procedure
procedure-md: 0.7
procedure-id: FR-H.2
title: Response to Steam Generator Overpressure
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [heat-sink]
entry-triggers: [csf-orange-path]
---

# FR-H.2 — Response to Steam Generator Overpressure

**CSF heat sink — ORANGE path.** Entered when any SG pressure
approaches or exceeds the safety-valve setpoint (~1085 psig at the
lowest safety per Vogtle Tech Spec 3.7.1) without normal relief
(condenser steam dump, atmospheric relief PORVs) functioning, OR when
safety valves have lifted but failed to reseat. Continued overpressure
threatens SG-shell structural integrity and main-steam-line integrity.
Recovery is by establishing some steam-release path, even if it means
manually unseating safety valves locally.

CSF: heat-sink

## Step 1 [id: verify-overpressure]
Check: any SG pressure «SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR» approaching or above 1085 psig (lowest safety-valve setpoint); atmospheric relief «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» position; condenser steam dump availability
Caution: a single SG above setpoint with relief operating normally is NOT FR-H.2 entry; criterion is overpressure WITHOUT relief
- Overpressure with relief failed → #relieve-pressure
  Because: ORANGE-path response required to prevent escalation toward SG/MSL failure
- Pressure recovering on normal relief, or false alarm → [[E-0]]
  Because: relief is functioning; return to diagnostic flow

## Step 2 [id: relieve-pressure]
Within: 2 minutes of overpressure-without-relief confirmation — SG shell stress climbs nonlinearly past safety setpoint
Action: attempt to open atmospheric relief valves «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» from the control room
Action: if ARVs unresponsive, dispatch operators to open safety valves locally at the gag mechanism — operator action of last resort, requires PPE and prior authorization from the SS
Action: if any condenser steam dump path is recoverable, restore it (turbine bypass, condenser vacuum if intact)
Caution: manually unseating a safety valve releases steam at significant flow rate; local operator must clear personnel from steam-release path before acting
- Pressure relieving (any release path established) → #monitor
  Because: relief restored; transition to monitoring
- Cannot establish any relief path → [[FR-Z.1]]
  Because: SG/MSL failure imminent; containment-response procedure handles the resulting steam release into containment if it occurs there, or in the main-steam tunnel if external

## Step 3 [id: monitor]
Check: SG pressures stable or declining; SG shell radiation monitors (indication of leak through tubes); main-steam-line integrity indicators
Within: re-evaluate every 5 minutes during active overpressure response
- All SG pressures stable below safety setpoint AND no shell-failure indicators → [[E-0]]
  Because: overpressure resolved; return to diagnostic flow
- SG shell failure indicators present (steam-line radiation spike, abnormal radiation in steam-tunnel) → [[E-2]]
  Because: faulted-SG response handles the shell-failure path

## Tags

- id: SG-A-PR
  description: SG-A steam pressure
  sim-path: secondary.sg.a.steam_pressure
  units: psig
  equipment: sg-a
  source: Vogtle UFSAR §10.3

- id: SG-B-PR
  description: SG-B steam pressure
  sim-path: secondary.sg.b.steam_pressure
  units: psig
  equipment: sg-b
  source: Vogtle UFSAR §10.3

- id: SG-C-PR
  description: SG-C steam pressure
  sim-path: secondary.sg.c.steam_pressure
  units: psig
  equipment: sg-c
  source: Vogtle UFSAR §10.3

- id: SG-D-PR
  description: SG-D steam pressure
  sim-path: secondary.sg.d.steam_pressure
  units: psig
  equipment: sg-d
  source: Vogtle UFSAR §10.3

- id: ARV-A
  description: SG-A atmospheric relief valve position
  sim-path: secondary.arv.a.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: sg-a-msl
  source: Vogtle UFSAR §10.3.2

- id: ARV-B
  description: SG-B atmospheric relief valve position
  sim-path: secondary.arv.b.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: sg-b-msl
  source: Vogtle UFSAR §10.3.2

- id: ARV-C
  description: SG-C atmospheric relief valve position
  sim-path: secondary.arv.c.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: sg-c-msl
  source: Vogtle UFSAR §10.3.2

- id: ARV-D
  description: SG-D atmospheric relief valve position
  sim-path: secondary.arv.d.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: sg-d-msl
  source: Vogtle UFSAR §10.3.2

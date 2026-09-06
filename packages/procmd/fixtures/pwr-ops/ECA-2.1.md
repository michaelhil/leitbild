---
type: procedure
procedure-md: 0.7
procedure-id: ECA-2.1
title: Uncontrolled Depressurization of All Steam Generators
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: extreme-conditions
csfs-monitored: [heat-sink, rcs-integrity]
entry-triggers: [csf-orange-path]
---

# ECA-2.1 — Uncontrolled Depressurization of All Steam Generators

Entered from [[E-2]] when faulted-SG isolation is impossible because
ALL SG pressures are decreasing simultaneously — main steam header
break upstream of the MSIVs, common-cause MSIV failure, or excessive
steam release across multiple ARVs. Cannot identify a single SG to
isolate. RCS cooldown is rapid and unbounded; PTS challenge develops
quickly. Vogtle UFSAR §15.1.5 (steam-system piping failure inside
or outside containment).

CSF: heat-sink

CSF: rcs-integrity

## Step 1 [id: confirm-all-sg-depress]
Check: all SG pressures «SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR» decreasing simultaneously; main steam header pressure «MS-HEADER-PR» decreasing; no isolatable break point evident
- All SGs depressurizing AND no single isolation point → #limit-cooldown
  Because: extreme-conditions response — single-SG isolation procedure (E-2) is not applicable
- Single SG faulted (others recovering or stable) → [[E-2]]
  Because: standard faulted-SG procedure applies

## Step 2 [id: limit-cooldown]
Within: 2 minutes — RCS cooldown rate under all-SG depressurization can exceed 200 °F/hr; PTS challenge develops within minutes
Action: trip RCPs «RCP-1» / «RCP-2» / «RCP-3» / «RCP-4» — eliminates forced cooldown component, reduces ongoing primary-to-secondary heat transfer rate
Action: close any isolatable steam path: dispatch operators to close upstream-of-break MSIVs, isolate atmospheric reliefs «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» if not the break source
Action: maintain AFW «AFW-A-CV» / «AFW-B-CV» / «AFW-C-CV» / «AFW-D-CV» to all SGs initially — partial isolation may reveal an intact SG
Caution: tripping RCPs accelerates loss of letdown / charging temperature-control; pressurizer pressure control may shift to auxiliary spray; monitor «PT-455»
Caution: excessive RCS cooldown drives PTS — if «TE-411-COLD» rate of decrease exceeds 100 °F/hr, branch to [[FR-P.1]]
- Cooldown rate limited (RCPs tripped, partial isolation succeeded) → #manage-rcs
  Because: bounded cooldown; manage RCS conditions while diagnosis continues
- Excessive cooldown unbounded → [[FR-P.1]]
  Because: PTS RED-path response

## Step 3 [id: manage-rcs]
Action: maintain RCS inventory by maximizing charging «CHG-FLOW» and minimizing letdown «LET-FLOW»; verify SI «SI-PUMP-A» / «SI-PUMP-B» actuated if RCS pressure dropping below SI setpoint
Action: pressurizer heaters «PZR-HTR» energized as conditions allow to slow pressure decrease
Caution: do NOT allow RCS to depressurize to a point where SI overpressurization would occur on cold restart — coordinate with shift-supervisor for SI throttling decisions
- Stable (RCS inventory maintained, RCS pressure trending toward equilibrium with SG pressure) → #monitor-recovery
  Because: bounded; proceed to recovery monitoring
- LOCA also developing (RCS pressure dropping faster than secondary, containment pressure rising) → [[E-1]]
  Because: concurrent LOCA + SG-depressurization is the worst-case; LOCA management takes precedence

## Step 4 [id: monitor-recovery]
Check: SG conditions (any recovering pressure, any intact SG identifiable); RCS conditions; PTS trajectory
Within: re-evaluate every 5 minutes during recovery phase
- One intact SG identified (pressure recovering, level controllable) → [[E-2]]
  Because: faulted-SG isolation now possible with the recoverable SG as the heat sink
- Long-term cooling needed via natural-circ → [[ES-0.2]]
  Because: natural-circulation cooldown procedure handles RCP-tripped path

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

- id: MS-HEADER-PR
  description: main steam header pressure
  sim-path: secondary.ms_header.pressure
  units: psig
  equipment: secondary
  source: Vogtle UFSAR §10.3

- id: TE-411-COLD
  description: RCS loop 1 cold-leg temperature
  sim-path: rcs.loop1.t_cold
  units: degF
  equipment: rcs-loop-1
  source: Vogtle UFSAR §5.1.1

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: PZR-HTR
  description: pressurizer heater bank energization status
  sim-path: rcs.pressurizer.heaters.status
  units: enum[OFF,ON,FAULT]
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: RCP-1
  description: reactor coolant pump 1 status
  sim-path: rcs.rcp.1.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: rcp-1
  source: Vogtle UFSAR §5.4.1

- id: RCP-2
  description: reactor coolant pump 2 status
  sim-path: rcs.rcp.2.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: rcp-2
  source: Vogtle UFSAR §5.4.1

- id: RCP-3
  description: reactor coolant pump 3 status
  sim-path: rcs.rcp.3.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: rcp-3
  source: Vogtle UFSAR §5.4.1

- id: RCP-4
  description: reactor coolant pump 4 status
  sim-path: rcs.rcp.4.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: rcp-4
  source: Vogtle UFSAR §5.4.1

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

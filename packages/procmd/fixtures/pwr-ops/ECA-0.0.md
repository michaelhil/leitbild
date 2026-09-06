---
type: procedure
procedure-md: 0.7
procedure-id: ECA-0.0
title: Loss of All AC Power
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: extreme-conditions
csfs-monitored: [subcriticality, core-cooling, heat-sink, rcs-integrity, containment, rcs-inventory]
entry-triggers: [station-blackout]
---

# ECA-0.0 — Loss of All AC Power (Station Blackout)

Entered from [[E-0]] when both AC emergency buses «BUS-A-EMERG» and
«BUS-B-EMERG» are de-energized — loss of offsite power coincident with
failure of both emergency diesel generators. The plant has lost all AC
sources except battery-backed DC loads and the turbine-driven AFW
pump (which runs on SG steam and DC controls).

Station blackout (SBO) is the dominant contributor to public risk in
most U.S. PWR PRAs. Coping duration per Vogtle 10 CFR 50.63 SBO Rule
is 4 hours minimum on battery alone; longer if FLEX equipment (NEI 12-06
diverse and flexible coping strategies, post-Fukushima Order EA-12-049)
is deployed.

Strategy: maintain core cooling via TDAFW + natural circulation;
preserve DC battery for instrumentation and control; restore AC ASAP
from any source (offsite recovery, diesel restart, FLEX portable
diesel, station-blackout cross-tie).

CSF: subcriticality

CSF: core-cooling

CSF: heat-sink

CSF: rcs-integrity

CSF: containment

CSF: rcs-inventory

## Step 1 [id: verify-blackout]
Check: emergency 4kV buses «BUS-A-EMERG» AND «BUS-B-EMERG» both de-energized; diesel generators «DG-A» AND «DG-B» both unavailable (failed-to-start, tripped, faulted); offsite power confirmed lost
Caution: a single bus de-energized with the other working is NOT SBO — confirm both trains lost before SBO entry
Note: instrumentation may flicker as battery-backed inverters stabilize after AC loss; allow 30 seconds before declaring SBO if reading from instruments alone
- All AC confirmed lost (both buses de-energized AND both DGs unavailable AND offsite power lost) → #establish-tdafw
  Because: SBO entry confirmed
- AC available on at least one bus (single-DG run, partial restoration) → [[E-0]]
  Because: not SBO; return to E-0 with whatever AC is available

## Step 2 [id: establish-tdafw]
Within: 5 minutes of SBO recognition — TDAFW startup must be verified before SG levels drop below recoverable
Action: verify TDAFW pump «AFW-PUMP-T» running on SG steam supply; turbine speed «TDAFW-SPEED» stable; AFW flow «AFW-FLOW» to at least one SG
Action: if TDAFW not started, manually start from local control panel; verify steam-supply valves open
Action: isolate non-essential DC loads per the plant's load-shed sheet — battery capacity is the ultimate timeline driver; typical DC bus loadings during SBO are 50-70% above continuous design, so shedding non-essential loads extends battery life from ~4 hr to ~6-8 hr
Caution: do NOT shed DC loads supporting safety instrumentation, RCP seal injection (if positive-displacement charging available), or TDAFW controls
Caution: TDAFW pump runs on SG steam — verify SG pressure «SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR» at least one SG above ~150 psig (minimum TDAFW turbine driving pressure) throughout SBO
Note: per Vogtle UFSAR §8.3.1 (DC system) and §10.4.9 (AFW system), TDAFW is the only AFW source under SBO
- TDAFW running, AFW flow established to at least one SG → #natural-circulation
  Because: secondary heat sink in service via TDAFW; transition to natural-circ flow management
- TDAFW failed to start or pump tripped → [[FR-H.1]]
  Because: total loss of heat sink — bleed-and-feed via AC-powered PORVs and high-head SI is needed, but those systems are unavailable under SBO; FR-H.1 entry forces SAMG-territory thinking

## Step 3 [id: natural-circulation]
Check: hot-leg temperatures «TE-411-HOT» / «TE-421-HOT» / «TE-431-HOT» / «TE-441-HOT»; cold-leg «TE-411-COLD» / «TE-421-COLD» / «TE-431-COLD» / «TE-441-COLD»; subcooling margin «SUB-MARGIN» (DC-powered indicator if available, otherwise compute from instruments); pressurizer pressure «PT-455»
Caution: under SBO, RCP seal injection is lost — RCP seal leakage becomes a small-break LOCA source after seal cooling water is exhausted (typical seal-cooling time ~5-10 min after RCP injection lost; thermal-barrier-cooler with cooling water source available can extend significantly)
Caution: monitor RCS inventory via pressurizer level «PZR-LVL» — if seal LOCA develops, pressurizer level drops; this is the second-order failure that drives SBO into FR-C-territory
Until: AC power restored OR FLEX equipment deployed OR situation requires escalation
- Natural circulation established, subcooling maintained, no seal LOCA evident → #wait-for-ac
  Because: stable SBO operating regime
- Natural circulation lost or seal LOCA developing → [[FR-C.1]]
  Because: inadequate-core-cooling response under SBO is grim — RED path with limited mitigation options

## Step 4 [id: wait-for-ac]
Check: AC restoration status (offsite recovery progress, DG restart attempts, FLEX deployment); DC battery «DC-BUS-LVL» status; TDAFW continuing; SG levels controlled by TDAFW
Within: re-evaluate every 15 minutes; battery-depletion timeline is the dominant clock
Action: continue all parallel AC-restoration efforts — offsite line repair, DG troubleshoot, FLEX portable-diesel deployment if 4+ hours into SBO
Action: prepare for natural-circulation cooldown to RHR conditions via SG steam release (ARVs «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D») if AC restoration extends — this is the long-term recovery path under prolonged SBO
Note: post-Fukushima, plants demonstrate ability to extend SBO coping via FLEX equipment to ≥72 hr; Vogtle FLEX strategy includes portable diesel for emergency bus restoration and dedicated decay-heat-removal equipment
- AC power restored (any emergency bus re-energized) → [[ES-0.1]]
  Because: SBO terminated; transition to clean-path recovery
- AC not restored, conditions stable on TDAFW + natural-circ → #wait-for-ac
  Because: continue monitoring loop; SBO can persist for hours with stable plant
- Conditions degrading (TDAFW lost, seal LOCA progressing, subcooling lost) → [[FR-C.1]]
  Because: inadequate-core-cooling response (with limited mitigation under SBO)

## Tags

- id: BUS-A-EMERG
  description: emergency 4kV bus A energization status
  sim-path: electrical.bus.emerg_a.energized
  units: bool
  equipment: bus-a-emerg
  source: Vogtle UFSAR §8.3

- id: BUS-B-EMERG
  description: emergency 4kV bus B energization status
  sim-path: electrical.bus.emerg_b.energized
  units: bool
  equipment: bus-b-emerg
  source: Vogtle UFSAR §8.3

- id: DG-A
  description: emergency diesel generator A status
  sim-path: electrical.dg.a.status
  units: enum[STOPPED,STARTING,RUNNING,LOADED,FAULT]
  equipment: emergency-dg-a
  source: Vogtle UFSAR §8.3.1.1

- id: DG-B
  description: emergency diesel generator B status
  sim-path: electrical.dg.b.status
  units: enum[STOPPED,STARTING,RUNNING,LOADED,FAULT]
  equipment: emergency-dg-b
  source: Vogtle UFSAR §8.3.1.1

- id: AFW-PUMP-T
  description: turbine-driven AFW pump status
  sim-path: afw.pump.tdafw.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: TDAFW-SPEED
  description: turbine-driven AFW pump turbine speed
  sim-path: afw.tdafw.turbine_speed
  units: rpm
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: AFW-FLOW
  description: aggregate AFW flow (header total)
  sim-path: afw.header.flow
  units: gpm
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

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

- id: TE-411-HOT
  description: RCS loop 1 hot-leg temperature
  sim-path: rcs.loop1.t_hot
  units: degF
  equipment: rcs-loop-1
  source: Vogtle UFSAR §5.1.1

- id: TE-421-HOT
  description: RCS loop 2 hot-leg temperature
  sim-path: rcs.loop2.t_hot
  units: degF
  equipment: rcs-loop-2
  source: Vogtle UFSAR §5.1.1

- id: TE-431-HOT
  description: RCS loop 3 hot-leg temperature
  sim-path: rcs.loop3.t_hot
  units: degF
  equipment: rcs-loop-3
  source: Vogtle UFSAR §5.1.1

- id: TE-441-HOT
  description: RCS loop 4 hot-leg temperature
  sim-path: rcs.loop4.t_hot
  units: degF
  equipment: rcs-loop-4
  source: Vogtle UFSAR §5.1.1

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

- id: PZR-LVL
  description: pressurizer level
  sim-path: rcs.pressurizer.level
  units: percent
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: DC-BUS-LVL
  description: vital DC bus voltage (representative)
  sim-path: electrical.dc_bus.voltage
  units: volts_dc
  equipment: dc-bus
  source: Vogtle UFSAR §8.3.2

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

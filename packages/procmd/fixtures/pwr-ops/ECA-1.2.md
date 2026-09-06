---
type: procedure
procedure-md: 0.7
procedure-id: ECA-1.2
title: LOCA Outside Containment
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: extreme-conditions
csfs-monitored: [containment, rcs-inventory, rcs-integrity]
entry-triggers: [csf-orange-path]
---

# ECA-1.2 — LOCA Outside Containment

Entered from [[E-1]] when LOCA symptoms (decreasing RCS pressure,
pressurizer level loss) exist but containment pressure and containment
sump are not rising — meaning the leak path
bypasses containment. Likely causes: interfacing-system LOCA (ISLOCA)
through a check-valve failure that connects RCS to a lower-pressure
auxiliary system, instrument-line break outside containment, letdown
heat-exchanger tube rupture, or RHR-system leak when RHR is in service.

The radiological signature is in the auxiliary building rather than
containment; ECA-1.2 entry is typically corroborated by «MAB-RAD»
elevated. Vogtle UFSAR §15.6.3 covers analyzed ISLOCA cases.

CSF: containment

CSF: rcs-inventory

CSF: rcs-integrity

## Step 1 [id: identify-leak-location]
Decision: identify the leak location based on auxiliary-building radiation, system-pressure mismatches, and inventory tracking
1. RHR system leak when RHR was aligned (V-sequence ISLOCA) — RHR-system pressure rising; «MAB-RAD» elevated; containment pressure «CTMT-PR» and sump «CTMT-SUMP-LVL» both NOT rising (the diagnostic distinction)
2. Letdown heat-exchanger tube rupture — letdown CCW outlet activity «CCW-RAD» elevated
3. Instrument-line break outside containment — small leak, sample-flow indicators show flow with no return
4. SI / CVCS suction valve failure — RCS pressure mismatch with downstream system
Caution: leak-location identification under ISLOCA can be slow because the leak path is by definition non-obvious; defensive isolation is preferred to forensic certainty
- Leak located → #isolate-leak
  Because: isolation is the immediate response
- Cannot locate after exhausting symptom evidence → [[ES-0.0]]
  Because: rediagnosis required

## Step 2 [id: isolate-leak]
Within: 5 minutes of leak-location identification — every minute of continued ISLOCA contributes to off-containment release
Action: isolate the leak path at the closest accessible boundary — RHR motor-operated valves «RHR-ISOL», letdown-line isolation «LET-ISOL», or other system-specific path
Action: verify isolation by observing the downstream pressure / level / flow indication
Caution: isolation may sometimes worsen conditions briefly — for instance, isolating RHR may strand RCS coolant in the affected loop; balance against the radiological-release reduction
- Leak isolated successfully → [[E-1]]
  Because: return to LOCA management with the leak now bounded
- Isolation impossible or partial → #limit-leak-impact
  Because: defensive action — minimize SI flow into the leak path while preserving core cooling

## Step 3 [id: limit-leak-impact]
Action: minimize SI flow «SI-PUMP-A» / «SI-PUMP-B» into the leak path while maintaining the subcooling margin «SUB-MARGIN» ≥ 30 °F at the core exit
Action: increase letdown to balance charging if letdown path is unaffected — maintains RCS inventory in the leak-bypass
Caution: this step trades core-cooling margin against radiological release; require shift-supervisor authorization for any SI reduction below normal demand
- Stabilized (core cooling adequate, release rate bounded) → #monitor
  Because: holding pattern; continue restoration attempts
- Cannot stabilize → [[FR-C.1]]
  Because: inadequate-core-cooling response engages when SI is insufficient

## Step 4 [id: monitor]
Check: leak rate (via «MAB-RAD» trend, downstream system pressure if measurable); core cooling status
Within: re-evaluate every 15 minutes during continued ISLOCA management
- Leak isolated or rate decreasing → [[E-1]]
  Because: return to normal LOCA management
- Continuing → #monitor
  Because: holding pattern

## Tags

- id: CTMT-PR
  description: containment building pressure
  sim-path: containment.pressure
  units: psig
  equipment: containment
  source: Vogtle UFSAR §6.2

- id: CTMT-SUMP-LVL
  description: containment recirculation sump level
  sim-path: containment.sump.level
  units: percent
  equipment: containment
  source: Vogtle UFSAR §6.2

- id: MAB-RAD
  description: main auxiliary building area radiation monitor
  sim-path: rad.mab.area
  units: rem_per_hr
  equipment: rad-monitoring
  source: Vogtle UFSAR §11.5

- id: CCW-RAD
  description: component cooling water outlet radiation monitor (letdown HX outlet)
  sim-path: rad.ccw.let_hx_outlet
  units: rem_per_hr
  equipment: rad-monitoring
  source: Vogtle UFSAR §11.5

- id: RHR-ISOL
  description: RHR system isolation valve (representative)
  sim-path: ess.rhr.isolation_valve
  units: enum[OPEN,CLOSED]
  equipment: rhr-system
  source: Vogtle UFSAR §5.4.7

- id: LET-ISOL
  description: CVCS letdown isolation valve
  sim-path: cvcs.letdown.isolation
  units: enum[OPEN,CLOSED]
  equipment: charging-system
  source: Vogtle UFSAR §9.3.4

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

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

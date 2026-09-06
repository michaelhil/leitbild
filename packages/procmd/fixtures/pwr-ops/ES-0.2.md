---
type: procedure
procedure-md: 0.7
procedure-id: ES-0.2
title: Natural Circulation Cooldown
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: recovery-procedure
csfs-monitored: [core-cooling, heat-sink, rcs-integrity]
entry-triggers: [post-trip-stable]
---

# ES-0.2 — Natural Circulation Cooldown

Entered from [[ES-0.1]], [[ECA-2.1]], or [[ECA-0.0]] (after AC restoration)
when reactor coolant pumps are unavailable but cooldown to cold-shutdown
conditions is required. Natural circulation in a PWR is single-phase
flow driven by the hot-leg-to-cold-leg density gradient through the SGs;
flow rate is ~3-5% of forced-circulation full flow. Cooldown is slower
than forced-flow cooldown (per Vogtle UFSAR §15.2.3 natural-circulation
analysis) but achievable with care.

CSF: core-cooling

CSF: heat-sink

CSF: rcs-integrity

## Step 1 [id: verify-natural-circ]
Check: natural-circulation flow established — hot-leg temperatures «TE-411-HOT» / «TE-421-HOT» / «TE-431-HOT» / «TE-441-HOT» stable; cold-leg temperatures «TE-411-COLD» / «TE-421-COLD» / «TE-431-COLD» / «TE-441-COLD» tracking lower than hot-leg with bounded ΔT (10-30 °F typical); subcooling margin «SUB-MARGIN» ≥ 30 °F
Caution: natural circulation requires steady-state symmetry; unbalanced flow (one loop hot, others normal) suggests a flow-path blockage or asymmetric SG cooling — investigate before proceeding
Note: natural circulation can stall on small perturbations (sudden temperature change, void in upper plenum); maintain steady conditions before manipulating any variable
- Natural circulation established AND symmetric across all loops → #begin-cooldown
  Because: natural-circ confirmed; safe to begin cooldown maneuver
- Not established or asymmetric → [[FR-C.2]]
  Because: degraded-core-cooling response — natural circulation failure approaches ICC territory

## Step 2 [id: begin-cooldown]
Within: cooldown rate must be deliberate — natural-circulation cooldowns typically take 24-48 hours
Action: begin cooldown via SG steam release using ARVs «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» (condenser dump may not be available depending on entry conditions); release rate sets the primary cooldown rate
Caution: maintain RCS cooldown rate ≤ 50 °F/hr during natural-circulation cooldown — conservative target half of the Tech Spec limit, because temperature distribution lag is longer with natural circulation
Caution: monitor for flow stagnation if loop ΔT widens excessively (>50 °F) OR if hot-leg temperature stops responding to steam release — both indicate impaired natural circulation
Note: per Vogtle UFSAR §15.2.3, natural-circulation analysis assumes the upper-head is solid water (not voided); if upper-head void develops, escalate to FR-I.3
- Cooldown progressing within rate target → #depressurize-rcs
  Because: ready to begin coordinated depressurization
- Cooldown stalls (loop ΔT widens, hot-leg-T not responding) → [[FR-H.1]]
  Because: heat-sink path failure during natural-circulation; bleed-and-feed response engages

## Step 3 [id: depressurize-rcs]
Action: depressurize RCS using pressurizer auxiliary spray (RCP-tripped configuration) OR PORV «PORV-456A» / «PORV-456B» (last resort) per Operations cooldown procedures
Caution: PORV depressurization is rapid and can drive upper-head voiding; coordinate with the natural-circulation flow regime — too-fast depressurization stalls flow
Caution: monitor pressurizer level «PZR-LVL» during depressurization — keep level on-scale by charging «CHG-FLOW» adjustment; off-scale low pressurizer is precursor to forced inventory loss
- Depressurization progressing toward cold-shutdown band (Tcold ≤ 350 °F, P_RCS ≤ 390 psig) → #monitor-cooldown
  Because: cooldown trajectory on track
- Loss of pressurizer pressure control (PORV stuck open, normal spray failed) → [[ECA-3.3]]
  Because: alternative depressurization control procedure (ECA-3.3 covers SGTR-without-pressurizer-control but the procedure applies)

## Step 4 [id: monitor-cooldown]
Check: cooldown trajectory (T_cold trends, P_RCS trends); ARV release rate; PTS curve margin
Within: re-evaluate every 30 minutes during long natural-circulation cooldown
- Cold-shutdown conditions reached (Mode 5: T_cold ≤ 200 °F, P_RCS < 50 psig per Vogtle Tech Spec) → END
  Because: natural-circulation cooldown complete; transfer to Operations shutdown procedures
- Continuing cooldown → #monitor-cooldown
  Because: monitoring loop is the operating regime for natural-circ cooldowns
- PTS concern (trajectory approaching curve) → [[FR-P.2]]
  Because: anticipated-PTS response is required

## Tags

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

- id: PZR-LVL
  description: pressurizer level
  sim-path: rcs.pressurizer.level
  units: percent
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: CHG-FLOW
  description: charging flow rate
  sim-path: cvcs.charging.flow
  units: gpm
  equipment: charging-system
  source: Vogtle UFSAR §9.3.4

---
type: procedure
procedure-md: 0.7
procedure-id: FR-I.3
title: Response to Voids in Reactor Vessel
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [rcs-inventory]
entry-triggers: [csf-yellow-path]
---

# FR-I.3 — Response to Voids in Reactor Vessel

**CSF RCS inventory — YELLOW path.** Entered when reactor-vessel-level
indication shows voiding above the core OR the reactor-head-vent line
indicates voids — but the core remains covered. Distinct from FR-C.x:
here the vessel is partially voided but cooling is still adequate
(positive subcooling at the core exit). Common drivers: post-LOCA upper-
head void during natural-circulation cooldown, mid-loop operations
with inadequate inventory during shutdown, accumulator injection at
high RCS pressure compressing residual upper-head bubble.

The reactor vessel head vent line (HV) is the canonical vent path —
post-TMI per NUREG-0737 II.B.1, all PWRs must have a head vent capable
of removing non-condensable gases from the upper head.

CSF: rcs-inventory

## Step 1 [id: verify-voids]
Check: reactor vessel level «RVLS-DYN» indicating two-phase or voided in the upper head region; head-vent line «HV-LINE» activity (any flow at the head vent during venting attempts confirms voids); subcooling «SUB-MARGIN» positive at core exit
Caution: RVLS instrumentation is sensitive to natural-circulation flow direction; verify voids persist for ≥ 2 minutes and corroborate with at least one secondary indication (RCS sample for non-condensables, pressurizer-level mismatch with charging-letdown balance) before action
- Voids confirmed (RVLS showing upper-head voiding, subcooling positive at core) → #vent-voids
  Because: YELLOW-path action is to vent voids before they grow toward core
- False alarm or transient → [[E-0]]
  Because: return to diagnostic flow

## Step 2 [id: vent-voids]
Within: 15 minutes — vessel-head voiding is slow-changing in most scenarios; act before voids reach core elevation
Action: open reactor vessel head vent «HV-LINE» (vents to pressurizer relief tank or containment depending on alignment)
Action: maintain SI flow «SI-PUMP-A» / «SI-PUMP-B» to make up for void volume as vent reduces inventory; verify subcooling margin «SUB-MARGIN» maintained
Action: if head vent unavailable, use pressurizer PORVs «PORV-456A» / «PORV-456B» as alternate vent path (pressurizer PORV vents from top of pressurizer, drives subcooled water up the surge line as void collapses)
Caution: head-vent operation can release non-condensable gases (hydrogen from radiolysis, nitrogen from accumulators); coordinate with rad-engineering if hydrogen monitoring shows elevated levels
- Voids vented (RVLS recovering, head-vent flow returning to single-phase) AND subcooling maintained → #monitor
  Because: YELLOW-path action succeeded; verify maintenance of recovery
- Cannot vent voids or subcooling lost during venting → [[FR-C.2]]
  Because: degraded-core-cooling response engages when voiding response cannot maintain subcooling

## Step 3 [id: monitor]
Check: «RVLS-DYN»; «SUB-MARGIN»; head-vent line indicators
Within: re-evaluate every 15 min during continued recovery
- Vessel level recovered (full water level above core) AND subcooling stable → [[E-0]]
  Because: inventory CSF returned to GREEN
- Voiding continues to expand OR subcooling lost → [[FR-C.1]]
  Because: RED-path inadequate-core-cooling response

## Tags

- id: RVLS-DYN
  description: reactor vessel level indication system, dynamic-pressure-compensated channel
  sim-path: rcs.rvls.dynamic.level
  units: percent_collapsed_liquid
  equipment: rcs
  source: Vogtle UFSAR §7.5

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

- id: HV-LINE
  description: reactor vessel head vent line position / activity
  sim-path: rcs.head_vent.line
  units: enum[ISOLATED,VENTING,FAULT]
  equipment: rcs
  source: Vogtle UFSAR §5.4 (head vent per NUREG-0737 II.B.1)

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

---
type: procedure
procedure-md: 0.7
procedure-id: ECA-3.3
title: SGTR Without Pressurizer Pressure Control
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: extreme-conditions
csfs-monitored: [core-cooling, rcs-inventory, containment]
entry-triggers: [csf-orange-path]
---

# ECA-3.3 — SGTR Without Pressurizer Pressure Control

Entered from [[E-3]], [[ECA-3.1]], or [[ECA-3.2]] when pressurizer
pressure control is lost — failed PORV (stuck or unresponsive), lost
pressurizer heaters, lost normal/auxiliary spray. Without pressurizer
control, RCS pressure is determined by the balance of SI inflow, SGTR
outflow, and SG-pressure equalization. SG steam dump becomes the
primary pressure-control mechanism. Final SGTR-recovery procedure;
last cooldown path before SAMG.

CSF: core-cooling

CSF: rcs-inventory

CSF: containment

## Step 1 [id: verify-pressure-control-loss]
Check: pressurizer PORVs «PORV-456A» / «PORV-456B» status (stuck or unresponsive); pressurizer heaters «PZR-HTR» (failed or de-energized); normal/auxiliary spray valves (failed); RCS pressure «PT-455» drifting uncontrollably (rising despite no SI, OR dropping despite normal makeup)
Caution: differentiate pressure-control loss from inadequate-control — losing a single PORV is recoverable via block valves; ECA-3.3 entry is multi-channel pressure-control failure
- Pressure control loss confirmed → #use-steam-dump
  Because: extreme-conditions response engages
- Pressure control restored (single PORV recoverable, spray restorable) → [[E-3]]
  Because: standard SGTR procedure can continue

## Step 2 [id: use-steam-dump]
Within: 5 minutes — uncontrolled RCS pressure with SGTR drives continuing release; corrective action immediate
Action: control RCS pressure indirectly via SG steam dump — opening intact-SG ARVs «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» reduces secondary pressure, which by primary-secondary thermodynamic coupling lowers RCS pressure
Action: modulate SI «SI-PUMP-A» / «SI-PUMP-B» flow to balance mass addition against leak rate; lower SI rate reduces RCS-pressurization driver but threatens core cooling
Caution: balance leak termination against RCS overcooling — aggressive cooldown drives PTS-trajectory; if «TE-411-COLD» rate of fall exceeds 100 °F/hr, branch to [[FR-P.1]]
- Pressure controllable via steam-dump path → #cooldown-via-steam-dump
  Because: pressure-control alternative established; proceed to cooldown
- Cannot control pressure even with steam dump → [[FR-P.1]]
  Because: PTS-trajectory response is the consequence of uncontrolled cooldown

## Step 3 [id: cooldown-via-steam-dump]
Action: cool down using intact-SG steam dump while managing ruptured-SG inventory (let it bleed down as RCS pressure decreases)
Within: cooldown to RHR conditions typically takes 12-24 hr
Note: under this regime the ruptured SG will partially or fully drain as cooldown proceeds; that's an acceptable outcome since the leak is terminating by pressure equalization
- Recovery progressing → [[ES-3.3]]
  Because: post-SGTR steam-dump cooldown procedure handles ongoing recovery
- Conditions degrading toward inadequate core cooling → [[FR-C.1]]
  Because: RED-path response

## Tags

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
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

- id: PZR-HTR
  description: pressurizer heater bank energization status
  sim-path: rcs.pressurizer.heaters.status
  units: enum[OFF,ON,FAULT]
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

- id: TE-411-COLD
  description: RCS loop 1 cold-leg temperature
  sim-path: rcs.loop1.t_cold
  units: degF
  equipment: rcs-loop-1
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

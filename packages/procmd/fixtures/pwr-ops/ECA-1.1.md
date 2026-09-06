---
type: procedure
procedure-md: 0.7
procedure-id: ECA-1.1
title: Loss of Emergency Coolant Recirculation
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: extreme-conditions
csfs-monitored: [core-cooling, rcs-inventory]
entry-triggers: [csf-red-path]
---

# ECA-1.1 — Loss of Emergency Coolant Recirculation

Entered from [[ES-1.3]], [[ES-1.4]], or [[E-1]] when transfer to cold-
or hot-leg recirculation fails — sump suction unobtainable, pump trip
during transfer, or strainer blockage. Without recirculation, RWST
inventory is finite (typically depletes in 60-90 minutes at full SI
flow per Vogtle UFSAR §6.3.2). This procedure exercises every
alternate-recirculation path before falling through to inadequate-core-
cooling response.

CSF: core-cooling

CSF: rcs-inventory

## Step 1 [id: verify-recirc-failure]
Check: RWST level «RWST-LVL» at or below low-low setpoint AND cold-leg recirculation flow not established («LO-HEAD-FLOW» low or zero); sump-strainer differential pressure «SUMP-SCREEN-DP» (high indicates blockage); RHR pump status «RHR-PUMP-A» / «RHR-PUMP-B»
Caution: a momentary flow disturbance during transfer is NOT recirculation failure — confirm that the recirc path has been attempted AND failed
- Recirculation failure confirmed → #attempt-restoration
  Because: extreme-conditions response engages
- Recirc actually established (transient flow disturbance only) → [[ES-1.3]]
  Because: return to normal recirculation procedure

## Step 2 [id: attempt-restoration]
Within: 5 minutes of failure confirmation — RWST depletion is the dominant clock
Action: attempt alternate-suction recirculation — containment-spray pump «CSPRAY-A» / «CSPRAY-B» can serve as ECCS makeup via cross-tie if the spray-pump train is otherwise available
Action: if sump strainer is the blockage cause, attempt strainer backflush (if procedure allows)
Action: align any remaining ECCS path (high-head SI from sump via piggyback if RHR train is partially recoverable)
Caution: cross-tie operations can defeat single-failure protection — coordinate with SS; train separation may be lost
- Alternate recirculation path established → [[ES-1.3]]
  Because: return to normal cold-leg recirc procedure with the alternate path
- All restoration attempts failed → #core-cooling-fallback
  Because: no recirc available; fallback to direct core-cooling management

## Step 3 [id: core-cooling-fallback]
Action: maximize remaining core-cooling resources — any working SI pump injecting from any source; isolate non-essential flow paths to conserve RWST
Action: manage RCS pressure «PT-455» — lower pressure widens the SI injection window from accumulators and low-head pumps; balance against subcooling margin
Action: prepare for transition to SAMG-territory if RWST depletes without recirc — coordinate with SS/EC for EAL escalation
Caution: this step is a holding pattern — no good answers exist when recirc fails; the goal is to maintain cooling until either recirc is restored OR SAMG entry is required
- Adequate cooling maintained (subcooling, vessel level, CETs all stable) → #monitor-recovery
  Because: holding pattern; continue monitoring for recirc-restoration opportunity
- Cooling inadequate → [[FR-C.1]]
  Because: inadequate-core-cooling response — the final EOP path before SAMG

## Step 4 [id: monitor-recovery]
Check: ongoing recirculation-restoration efforts; RWST level; ECCS flow status
Within: re-evaluate every 15 minutes
- Recirculation path restored by any means → [[ES-1.3]]
  Because: resume normal recirculation
- Recirc not restored → #monitor-recovery
  Because: continue holding pattern

## Tags

- id: RWST-LVL
  description: refueling water storage tank level
  sim-path: rwst.level
  units: percent
  equipment: rwst
  source: Vogtle UFSAR §6.3.2

- id: LO-HEAD-FLOW
  description: low-head SI / RHR header flow
  sim-path: ess.lo_head.header_flow
  units: gpm
  equipment: si-system
  source: Vogtle UFSAR §6.3

- id: SUMP-SCREEN-DP
  description: containment sump strainer differential pressure
  sim-path: ess.sump.strainer.dp
  units: psid
  equipment: si-system
  source: Vogtle UFSAR §6.3.2

- id: RHR-PUMP-A
  description: residual heat removal pump A status
  sim-path: ess.rhr_pump.a.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: rhr-system
  source: Vogtle UFSAR §5.4.7

- id: RHR-PUMP-B
  description: residual heat removal pump B status
  sim-path: ess.rhr_pump.b.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: rhr-system
  source: Vogtle UFSAR §5.4.7

- id: CSPRAY-A
  description: containment spray pump A status
  sim-path: ess.cspray_pump.a.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: containment-spray
  source: Vogtle UFSAR §6.2.2

- id: CSPRAY-B
  description: containment spray pump B status
  sim-path: ess.cspray_pump.b.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: containment-spray
  source: Vogtle UFSAR §6.2.2

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

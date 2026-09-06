---
type: procedure
procedure-md: 0.7
procedure-id: ES-1.3
title: Transfer to Cold Leg Recirculation
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: recovery-procedure
csfs-monitored: [core-cooling, rcs-inventory]
entry-triggers: [post-trip-stable]
---

# ES-1.3 — Transfer to Cold Leg Recirculation

Entered from [[E-1]], [[ES-1.2]], or [[FR-H.1]] when RWST level approaches
low-low (~38% per Vogtle Tech Spec), requiring transfer of SI / ECCS
pump suction from RWST to containment recirculation sump for long-term
cooling. This is operationally the tightest recovery procedure in the
EOP set — swap-over timing is constrained on both ends (pumps must not
run dry from RWST exhaustion; sump must have adequate inventory and
NPSH before suction transfer). Vogtle UFSAR §6.3.2 (ECCS recirculation
sequence).

CSF: core-cooling

CSF: rcs-inventory

## Step 1 [id: verify-transfer-conditions]
Check: RWST level «RWST-LVL» at or approaching low-low setpoint (Vogtle ~38% indicated); containment sump level «CTMT-SUMP-LVL» above the minimum-NPSH level for low-head SI pumps (typically ≥30% indicated sump level); containment sump-screen indicators («SUMP-SCREEN-DP») showing acceptable strainer-blockage state
Caution: do NOT initiate transfer with sump level below NPSH-adequate setpoint — running low-head pumps dry or in cavitation will damage them and remove the recirculation capability altogether
Note: per Vogtle UFSAR §6.3.2, the design-basis recirculation sequence completes within ~15-25 minutes after RWST low-low; faster transfer is fine, slower is the operational margin
- Transfer conditions met (RWST at low-low AND sump level adequate) → #align-recirc-suction
  Because: transfer prerequisites satisfied; proceed
- RWST level recovered (sump-screen issue, no further SI needed) → [[E-1]]
  Because: transfer not yet required; return to LOCA flow

## Step 2 [id: align-recirc-suction]
Within: 5 minutes — RWST depletion continues during transfer; pump shutoff from cavitation must be prevented
Action: in order — (1) start residual heat removal (RHR) pumps «RHR-PUMP-A» / «RHR-PUMP-B» aligned to containment sump suction; (2) verify low-head SI flow «LO-HEAD-FLOW» established from sump through RHR heat-exchanger «RHR-HX»; (3) close RWST suction isolation valves on low-head path
Caution: verify each sump-suction-valve indication AND pump-discharge-pressure indication BEFORE closing the corresponding RWST-suction-isolation — closing RWST suction first risks pump suction loss if recirc valve fails to open
Caution: containment sump strainers have been a recurring industry-issue (post-Fukushima follow-up); verify «SUMP-SCREEN-DP» low across strainers throughout transfer — high differential pressure means blockage and impending pump cavitation
- Cold-leg recirc flow established, RWST suction isolated on low-head path → #transfer-high-pressure
  Because: low-head transfer complete; proceed to high-head path
- Cannot establish recirculation suction (valve failure, pump trip, strainer blockage) → [[ECA-1.1]]
  Because: ECCS recirculation failure response — extreme-conditions procedure

## Step 3 [id: transfer-high-pressure]
Within: complete high-head transfer within 10 min of starting low-head transfer — running high-head SI from depleting RWST too long risks cavitation
Action: align high-head SI «SI-PUMP-A» / «SI-PUMP-B» suction to the discharge of running RHR pumps «RHR-PUMP-A» / «RHR-PUMP-B» (piggyback alignment — RHR provides booster pressure to high-head suction)
Action: verify high-head flow «SI-FLOW» continuing; close RWST suction isolation valves on high-head path
Caution: piggyback alignment is single-failure-vulnerable — loss of either RHR pump removes high-head suction; verify both RHR trains running before completing transfer
- High-head recirc established, RWST suction fully isolated → #monitor-recirc
  Because: cold-leg recirculation transfer complete
- Cannot align high-head recirc → [[ECA-1.1]]
  Because: extreme-conditions recirculation-failure response

## Step 4 [id: monitor-recirc]
Check: recirc flow rate stable; subcooling «SUB-MARGIN» maintained; sump level «CTMT-SUMP-LVL» (decreases slowly through evaporation but should not change abruptly); RHR HX outlet temperature
Within: re-evaluate every 30 minutes during long-term recirculation
- Recirc stable, core cooling maintained, hot-leg recirc time approaching (8-24 hr post-cold-leg LOCA) → [[ES-1.4]]
  Because: hot-leg recirculation reverses flow path to prevent boric acid accumulation in core
- Recirc lost (pump trip, suction blockage, flow loss) → [[ECA-1.1]]
  Because: extreme-conditions recirculation-failure response

## Tags

- id: RWST-LVL
  description: refueling water storage tank level
  sim-path: rwst.level
  units: percent
  equipment: rwst
  source: Vogtle UFSAR §6.3.2

- id: CTMT-SUMP-LVL
  description: containment recirculation sump level
  sim-path: containment.sump.level
  units: percent
  equipment: containment
  source: Vogtle UFSAR §6.2

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

- id: RHR-HX
  description: RHR heat-exchanger outlet temperature (representative)
  sim-path: ess.rhr.hx_outlet_temp
  units: degF
  equipment: rhr-system
  source: Vogtle UFSAR §5.4.7

- id: LO-HEAD-FLOW
  description: low-head SI / RHR header flow
  sim-path: ess.lo_head.header_flow
  units: gpm
  equipment: si-system
  source: Vogtle UFSAR §6.3

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

- id: SI-FLOW
  description: high-head SI header flow
  sim-path: ess.si.header_flow
  units: gpm
  equipment: si-system
  source: Vogtle UFSAR §6.3

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

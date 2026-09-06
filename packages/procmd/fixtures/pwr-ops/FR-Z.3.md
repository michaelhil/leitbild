---
type: procedure
procedure-md: 0.7
procedure-id: FR-Z.3
title: Response to High Containment Radiation
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [containment]
entry-triggers: [csf-yellow-path]
---

# FR-Z.3 — Response to High Containment Radiation

**CSF containment — YELLOW path.** Entered when containment radiation
monitors exceed the alert threshold (typically 10 mR/hr area dose rate
in containment per Vogtle UFSAR §11.5). Two distinct causes drive
entry: (1) fuel damage in core — clad failure releasing fission gases
into the RCS that then leak through PORVs / safeties / containment-
penetration leakage paths into containment, or (2) primary-leakage
from RCS into containment via small-break LOCA. Identification matters
for EAL classification (fuel damage drives Site Area Emergency or
General Emergency per NEI 99-01) and for the response — fuel damage
implies SAMG-territory hydrogen and source-term considerations.

CSF: containment

## Step 1 [id: verify-high-radiation]
Check: containment area radiation «CTMT-RAD» and noble-gas monitor «CTMT-NG» above alert threshold (typically >10 mR/hr area dose rate, >10× background on the noble-gas channel); detector self-test status to rule out instrument failure
Caution: pre-existing background from a prior event (post-LOCA settled inventory) can read elevated; FR-Z.3 entry is the RATE of rise or a new step-change, not absolute level alone
- High radiation confirmed (rate of rise or step-change) → #identify-source
  Because: YELLOW-path response: identify source before declaring fuel damage
- Spurious or detector fault → [[E-0]]
  Because: return to diagnostic flow; flag detector for maintenance

## Step 2 [id: identify-source]
Decision: identify the source of containment radiation
1. Fuel damage in core — corroborated by core-exit thermocouples «CET-AVG» above saturation, RCS sample showing elevated I-131 / Xe-133 ratio (post-LOCA fission-product signature)
2. Primary leakage only — RCS sample shows normal coolant-activity signature (no clad-failure markers), small-break LOCA inventory accumulating
3. Spurious from on-site activity (refueling-cavity disturbance, sample line leakage in containment) — physically possible only in shutdown modes
- Fuel damage indicated (CETs ≥ T_sat AND coolant activity elevated) → #ensure-isolation
  Because: severe-accident-territory; isolation must be confirmed; EAL classification consequential
- Primary leakage only (clad activity normal, LOCA in progress) → [[E-1]]
  Because: LOCA management is the operative response; containment radiation is a consequence
- Spurious or non-fuel source → [[E-0]]
  Because: false alarm; return to diagnostic flow

## Step 3 [id: ensure-isolation]
Within: 5 minutes — fuel-damage radiation release is the most consequential indicator of an evolving severe event
Action: verify Phase A AND Phase B containment isolation complete and persistent; verify containment-spray «CSPRAY-A» / «CSPRAY-B» status (iodine removal via spray-additive is preferred)
Action: coordinate with Shift Supervisor / Emergency Coordinator to evaluate EAL classification per NEI 99-01 (Site Area Emergency or General Emergency thresholds based on coolant-activity and offsite release potential)
Action: verify operating crews and offsite ERO are notified per emergency-plan protocol
Caution: declare emergency action level WITHOUT waiting for full diagnostic confirmation — under-declaration is the worse error than over-declaration; SS / EC must authorize the EAL call within ~15 min of recognition per 10 CFR 50.72
Note: this procedure interfaces with the plant's emergency-plan procedures (E-Plan); EAL matrix is in a separate document not part of this EOP set
- Isolation verified complete → [[FR-Z.1]]
  Because: high pressure may follow from continued release; containment-pressure response engages
- Isolation gap identified → [[FR-Z.1]]
  Because: same fallthrough — high-pressure response addresses containment integrity regardless of isolation state at entry

## Tags

- id: CTMT-RAD
  description: containment area radiation monitor
  sim-path: rad.containment.high_range
  units: rem_per_hr
  equipment: containment
  source: Vogtle UFSAR §6.2

- id: CTMT-NG
  description: containment noble-gas activity monitor
  sim-path: rad.containment.noble_gas
  units: uCi_per_cc
  equipment: containment
  source: Vogtle UFSAR §11.5

- id: CET-AVG
  description: core-exit thermocouple average (5+ representative locations across the core)
  sim-path: rcs.core_exit.thermocouple.avg
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §7.5

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

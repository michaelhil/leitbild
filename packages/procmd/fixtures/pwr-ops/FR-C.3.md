---
type: procedure
procedure-md: 0.7
procedure-id: FR-C.3
title: Response to Saturated Core Cooling Conditions
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [core-cooling]
entry-triggers: [csf-yellow-path]
---

# FR-C.3 — Response to Saturated Core Cooling Conditions

**CSF core cooling — YELLOW path.** Entered when the RCS has reached
saturation (zero subcooling margin) but the core remains covered and
vessel level is stable. The two-phase mixture in the upper plenum and
hot legs is an expected state during certain LOCA recoveries (notably
after RCP trip and during natural-circulation cooldown); the goal here
is to prevent further degradation toward FR-C.2 (ORANGE) or FR-C.1
(RED). Distinguished from the higher-severity CSF paths by
*stability* — saturated but not progressing.

Saturated cooling is also the operating regime during natural-circulation
cooldown (ES-0.2). FR-C.3 entry indicates that the regime persists
when it should not (e.g. after SI termination, after RCP restart
attempts), and operator vigilance is required.

CSF: core-cooling

## Step 1 [id: verify-saturation]
Check: subcooling margin «SUB-MARGIN» = 0 (saturated) ± instrument deadband; reactor vessel level «RVLS-DYN» stable above 70%; core-exit thermocouples «CET-AVG» at T_sat (within 5 °F of saturation temperature at «PT-455»)
Caution: instrument noise can show momentary zero-subcooling readings; verify saturation persists for ≥ 2 minutes before entering FR-C.3 — transient zero-margin during pressure transients is not YELLOW-path
Note: confirming saturation requires checking BOTH the subcooling indicator AND the CET-vs-T_sat comparison; relying on a single instrument has caused inappropriate procedure entries in operating-experience
- Saturated cooling confirmed (zero subcooling sustained ≥ 2 min, RVLS stable, CETs at T_sat) → #manage-saturation
  Because: YELLOW-path response is monitoring + careful action to prevent degradation
- Subcooling margin recovered (≥ 30 °F) → [[E-1]]
  Because: saturation was transient; return to LOCA flow with restored margin

## Step 2 [id: manage-saturation]
Action: maintain SI flow at current alignment — do NOT terminate SI while saturated
Action: maintain at least one running RCP per loop only if cold-leg-injection lineup allows; otherwise rely on natural circulation
Caution: actions that reduce RCS inventory (terminating SI prematurely, opening letdown beyond charging) can drive YELLOW-path → ORANGE; the bias here is conservative — keep what's working
Note: natural-circulation cooldown via SG dump (intact SGs) is the preferred path; avoid further depressurization unless required for accumulator injection
- Saturated cooling stable (CETs at T_sat ± 5 °F, RVLS stable, no degradation indicators for ≥ 15 min) → #monitor
  Because: stabilized YELLOW-path; transition to monitoring while recovery progresses
- Degradation observed (CETs trending up above T_sat, RVLS dropping, subcooling going negative) → [[FR-C.2]]
  Because: ORANGE-path response is required when saturated cooling fails to maintain stability

## Step 3 [id: monitor]
Check: subcooling margin «SUB-MARGIN», CET trends «CET-AVG», RVLS «RVLS-DYN» trends; SI status and flow
Within: re-evaluate every 15 minutes minimum — saturated regime can persist for hours during natural-circulation cooldown but conditions can change without obvious announcement
- Subcooling margin recovering (≥ 10 °F and rising) → [[E-1]]
  Because: saturated regime ending; return to LOCA flow
- Stable saturated cooling (zero subcooling, RVLS steady, CETs at T_sat) → #monitor
  Because: continue monitoring; this loop is the normal YELLOW-path holding pattern
- Degrading (subcooling becomes negative, RVLS dropping, CETs rising above T_sat) → [[FR-C.2]]
  Because: escalating to ORANGE — degraded core cooling response

## Tags

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

- id: RVLS-DYN
  description: reactor vessel level indication system, dynamic-pressure-compensated channel
  sim-path: rcs.rvls.dynamic.level
  units: percent_collapsed_liquid
  equipment: rcs
  source: Vogtle UFSAR §7.5

- id: CET-AVG
  description: core-exit thermocouple average (5+ representative locations across the core)
  sim-path: rcs.core_exit.thermocouple.avg
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §7.5

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

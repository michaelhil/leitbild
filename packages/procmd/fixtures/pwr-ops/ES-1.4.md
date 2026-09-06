---
type: procedure
procedure-md: 0.7
procedure-id: ES-1.4
title: Transfer to Hot Leg Recirculation
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: recovery-procedure
csfs-monitored: [core-cooling]
entry-triggers: [post-trip-stable]
---

# ES-1.4 — Transfer to Hot Leg Recirculation

Entered from [[ES-1.3]] approximately 8-24 hours after a cold-leg break
LOCA (specific window per Vogtle UFSAR §6.3.2 boric-acid analysis), to
reverse the recirculation flow path. Cold-leg recirculation injects
borated water from the sump into the cold legs; as fluid boils in the
core and exits up the hot leg, boron precipitates from the solution
and accumulates in the lower core. Hot-leg recirc reverses the flow,
pushing borated water IN through the hot legs and washing out the
accumulated boric acid.

Industry-issue: prior to the post-TMI ECCS analysis, this transfer
was less well-characterized. Modern Vogtle Tech Spec mandates the
8-hour earliest / 24-hour latest window.

CSF: core-cooling

## Step 1 [id: verify-transfer-time]
Check: time since LOCA exceeds 8 hours; boric-acid concentration in RCS sample («RCS-BORON») trending up (indicating precipitation accumulation in lower plenum); cold-leg recirculation flow still stable
- Transfer time reached (≥8 hr post-LOCA, boric-acid trend confirms) → #align-hot-leg
  Because: industry-recommended boric-acid washout window
- Not yet required (< 8 hr OR no boric-acid trend) → [[ES-1.3]]
  Because: continue cold-leg recirculation until window arrives

## Step 2 [id: align-hot-leg]
Within: hot-leg-recirc alignment is a slow, deliberate procedure — typical execution ~30 min
Action: align at least one ECCS train to hot-leg injection («HL-INJECT-A» / «HL-INJECT-B») while maintaining the OTHER train on cold-leg recirculation (do NOT transfer both trains simultaneously)
Action: verify hot-leg-injection flow «HL-FLOW» established before adjusting cold-leg-injection-train flow
Caution: maintain at least one cold-leg recirculation path during transfer — core cooling must not be interrupted; transferring both trains at once is a single-failure-vulnerable operation
Caution: hot-leg injection rate is typically lower than cold-leg (different orifice path); coordinate with shift-supervisor; total ECCS flow may decrease briefly during alignment but core cooling persists due to natural circulation
Note: per Vogtle UFSAR §6.3.2 the design-basis assumption is that ONE train does the boric-acid washout while the OTHER continues cold-leg injection
- Hot-leg recirc established, parallel cold-leg flow maintained → #monitor-hot-leg-recirc
  Because: transfer successful; verify
- Cannot align hot-leg recirc (valve failure, no hot-leg flow path) → [[ECA-1.1]]
  Because: ECCS recirculation failure response

## Step 3 [id: monitor-hot-leg-recirc]
Check: «HL-FLOW» stable; core temperatures «CET-AVG» responding; boric-acid concentration trending DOWN (washout indicator); subcooling «SUB-MARGIN» maintained
Within: re-evaluate every 1 hour during long-term hot-leg recirculation
- Stable long-term cooling, boric-acid concentration declining → END
  Because: long-term cooling established; transfer to plant cooldown / maintenance Operations procedures (outside EOP scope)
- Recirculation lost → [[ECA-1.1]]
  Because: extreme-conditions recirculation-failure response

## Tags

- id: RCS-BORON
  description: RCS boron concentration (sampled)
  sim-path: rcs.boron.concentration
  units: ppm
  equipment: rcs
  source: Vogtle UFSAR §9.3.4

- id: HL-INJECT-A
  description: hot-leg injection train A alignment
  sim-path: ess.hl_inject.a.alignment
  units: enum[ISOLATED,ALIGNED,FAULT]
  equipment: si-system
  source: Vogtle UFSAR §6.3.2

- id: HL-INJECT-B
  description: hot-leg injection train B alignment
  sim-path: ess.hl_inject.b.alignment
  units: enum[ISOLATED,ALIGNED,FAULT]
  equipment: si-system
  source: Vogtle UFSAR §6.3.2

- id: HL-FLOW
  description: hot-leg injection header flow
  sim-path: ess.hl_inject.header_flow
  units: gpm
  equipment: si-system
  source: Vogtle UFSAR §6.3.2

- id: CET-AVG
  description: core-exit thermocouple average (5+ representative locations across the core)
  sim-path: rcs.core_exit.thermocouple.avg
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §7.5

- id: SUB-MARGIN
  description: RCS subcooling margin (T_sat at PT-455 minus hot-leg temperature)
  sim-path: rcs.subcooling_margin
  units: degF
  equipment: rcs
  source: Vogtle UFSAR §15.6

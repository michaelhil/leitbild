---
type: procedure
procedure-md: 0.7
procedure-id: ES-0.0
title: Rediagnosis
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: diagnostic-eop
csfs-monitored: [subcriticality, core-cooling, heat-sink, rcs-integrity, containment, rcs-inventory]
entry-triggers: [diagnostic-fallback]
---

# ES-0.0 — Rediagnosis

Entered from [[E-0]] or any E-series procedure when initial diagnosis
cannot be confirmed — symptoms are ambiguous, mixed, or inconsistent
with the originally-selected event-specific procedure. Performs
expanded symptom check and re-routes to the correct event-specific
procedure. Conservative bias: when in doubt, ES-0.0 is the right
destination from any E-series procedure.

CSF: subcriticality

CSF: core-cooling

CSF: heat-sink

CSF: rcs-integrity

CSF: containment

CSF: rcs-inventory

## Step 1 [id: re-check-symptoms]
Decision: classify the event using the full symptom set
1. LOCA — RCS pressure «PT-455» dropping, containment pressure «CTMT-PR» or sump «CTMT-SUMP-LVL» rising, containment radiation «CTMT-RAD» rising
2. Faulted SG — a single SG with rapidly dropping pressure («SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR»), high main-steam-line radiation, OR audible/visible steam-line break
3. SGTR — a single SG with rising level («SG-A-LVL-NR» / «SG-B-LVL-NR» / «SG-C-LVL-NR» / «SG-D-LVL-NR») AND high N-16 «SG-A-N16» / «SG-B-N16» / «SG-C-N16» / «SG-D-N16» on the same SG
4. Station blackout — emergency buses «BUS-A-EMERG» / «BUS-B-EMERG» both de-energized despite offsite and onsite power demands
5. No event identifiable AND plant conditions in normal post-trip band — clean-path return
6. Conditions actively deteriorating with no clear event class — defensive fallback
Caution: rediagnosis is iterative — if initial classification is wrong, return here from the new branch
Note: ES-0.0 is the most common "I don't know what's happening" landing pad; conservatism is to keep all defensive measures in place while classification proceeds
- LOCA confirmed → [[E-1]]
  Because: LOCA management procedure
- Faulted SG confirmed → [[E-2]]
  Because: faulted-SG isolation procedure
- SGTR confirmed → [[E-3]]
  Because: SGTR response procedure
- All AC lost → [[ECA-0.0]]
  Because: station-blackout extreme-conditions procedure
- No event identifiable, plant stable → [[ES-0.1]]
  Because: clean post-trip recovery
- Conditions actively deteriorating with no clear class → #emergency-fallback
  Because: defensive emergency-fallback step while classification continues

## Step 2 [id: emergency-fallback]
Within: 5 minutes — continued unidentified deterioration is the most-dangerous regime
Action: maintain all safety injection actuated; maintain AFW to all SGs
Action: do NOT take actions that reduce inventory or heat-removal capacity until classification is positive
Action: declare emergency action level per the plant's EAL matrix (NEI 99-01); coordinate with SS / Emergency Coordinator
Caution: emergency-fallback bias is "keep defenses on while diagnosing"; bias against premature SI termination, AFW reduction, or other deconservative actions
- Stabilized (conditions stopped deteriorating, classification becoming clearer) → #re-check-symptoms
  Because: return to symptom-check loop
- Critical safety function challenged → [[FR-S.1]]
  Because: subcriticality is the first CSF to evaluate; CSF status trees take precedence — entry here is by example, the actual challenged CSF determines the FR-x branch

## Tags

- id: PT-455
  description: pressurizer pressure (wide range)
  sim-path: rcs.pressurizer.pressure_wr
  units: psig
  equipment: pressurizer
  source: Vogtle UFSAR §5.4

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

- id: CTMT-RAD
  description: containment area radiation monitor
  sim-path: rad.containment.high_range
  units: rem_per_hr
  equipment: containment
  source: Vogtle UFSAR §6.2

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

- id: SG-A-LVL-NR
  description: SG-A narrow-range level
  sim-path: secondary.sg.a.level_nr
  units: percent
  equipment: sg-a
  source: Vogtle UFSAR §10.3

- id: SG-B-LVL-NR
  description: SG-B narrow-range level
  sim-path: secondary.sg.b.level_nr
  units: percent
  equipment: sg-b
  source: Vogtle UFSAR §10.3

- id: SG-C-LVL-NR
  description: SG-C narrow-range level
  sim-path: secondary.sg.c.level_nr
  units: percent
  equipment: sg-c
  source: Vogtle UFSAR §10.3

- id: SG-D-LVL-NR
  description: SG-D narrow-range level
  sim-path: secondary.sg.d.level_nr
  units: percent
  equipment: sg-d
  source: Vogtle UFSAR §10.3

- id: SG-A-N16
  description: SG-A main steam line N-16 radiation monitor
  sim-path: rad.msl.a.n16
  units: cps
  equipment: sg-a-msl
  source: Vogtle UFSAR §11.5

- id: SG-B-N16
  description: SG-B main steam line N-16 radiation monitor
  sim-path: rad.msl.b.n16
  units: cps
  equipment: sg-b-msl
  source: Vogtle UFSAR §11.5

- id: SG-C-N16
  description: SG-C main steam line N-16 radiation monitor
  sim-path: rad.msl.c.n16
  units: cps
  equipment: sg-c-msl
  source: Vogtle UFSAR §11.5

- id: SG-D-N16
  description: SG-D main steam line N-16 radiation monitor
  sim-path: rad.msl.d.n16
  units: cps
  equipment: sg-d-msl
  source: Vogtle UFSAR §11.5

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

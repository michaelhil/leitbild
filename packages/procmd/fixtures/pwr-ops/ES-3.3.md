---
type: procedure
procedure-md: 0.7
procedure-id: ES-3.3
title: Post-SGTR Cooldown Using Steam Dump
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: recovery-procedure
csfs-monitored: [heat-sink, containment]
entry-triggers: [post-trip-stable]
---

# ES-3.3 — Post-SGTR Cooldown Using Steam Dump

Entered from [[E-3]], [[ECA-3.3]], or [[ES-3.2]] when neither backfill
(ES-3.1) nor controllable blowdown (ES-3.2) is available, and steam
dump — to condenser when available, atmospheric otherwise — is the only
remaining cooldown heat-removal path. Atmospheric dump of ruptured-SG
steam involves continuous radiological release through the ARV; offsite
emergency response must be coordinated.

CSF: heat-sink

CSF: containment

## Step 1 [id: align-steam-dump]
Decision: select steam-dump pathway based on equipment availability and radiological constraints
1. Condenser steam dump «STEAM-DUMP» available AND condenser-air-ejector activity «AEJ-RAD» within authorized limits — preferred (captures activity in main condenser, secondary release path)
2. Atmospheric relief via ARV «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» — fallback (direct radiological release, requires SS authorization and emergency-response coordination)
3. Combination — dump intact SGs to condenser while ARVs handle ruptured SG (mitigates total release magnitude)
Caution: do NOT steam-dump from the ruptured SG to the condenser — that contaminates the main condenser and contaminates the secondary side broadly; ruptured-SG release must go via dedicated ARV path
- Condenser available for intact SGs → #cooldown-via-condenser
  Because: lowest-release path
- Only atmospheric available → #cooldown-via-atmosphere
  Because: ARV is the only option

## Step 2 [id: cooldown-via-condenser]
Action: cool down intact SGs via condenser steam dump; ruptured SG cooled via slow heat-loss to surroundings (since it cannot dump to condenser)
Caution: ruptured-SG pressure may rise slowly during cooldown (less heat removal than intact SGs); monitor «SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR» on ruptured SG — if exceeding safety setpoint, ARV release on that SG only
- Condenser cooldown progressing → #monitor
  Because: proceed to monitoring
- Condenser lost during cooldown → #cooldown-via-atmosphere
  Because: switch to atmospheric path

## Step 3 [id: cooldown-via-atmosphere]
Within: atmospheric cooldown is throttled — typical rate ≤30 °F/hr below 350 °F to limit radiological release magnitude per unit cooldown
Action: align ARVs «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» for cooldown; throttle release rate to minimize integrated dose
Caution: atmospheric release of ruptured-SG steam carries radioactive material; coordinate with offsite emergency response; verify EAL classification per NEI 99-01
Caution: ARVs vent at the main-steam-tunnel deflector — release plume direction depends on wind; rad-engineering / ERO must track exposure pathways
- Atmospheric cooldown progressing → #monitor
  Because: proceed
- Cannot maintain cooldown → [[FR-H.1]]
  Because: heat-sink RED-path response

## Step 4 [id: monitor]
Check: cooldown trajectory; ruptured-SG conditions; total integrated release
Within: re-evaluate every 30 min during continued cooldown
- Cooldown complete to RHR conditions → END
  Because: post-SGTR cooldown via steam dump succeeded
- Cooldown stalled → [[FR-H.1]]
  Because: heat-sink response

## Tags

- id: STEAM-DUMP
  description: condenser steam dump availability (auto-permissive flag)
  sim-path: secondary.steam_dump.available
  units: bool
  equipment: secondary
  source: Vogtle UFSAR §10.4.4

- id: AEJ-RAD
  description: condenser air-ejector radiation monitor
  sim-path: rad.condenser.air_ejector
  units: cps
  equipment: condenser
  source: Vogtle UFSAR §11.5

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

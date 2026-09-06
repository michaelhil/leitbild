---
type: procedure
procedure-md: 0.7
procedure-id: ES-3.2
title: Post-SGTR Cooldown Using Blowdown
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: recovery-procedure
csfs-monitored: [heat-sink, containment]
entry-triggers: [post-trip-stable]
---

# ES-3.2 — Post-SGTR Cooldown Using Blowdown

Entered from [[E-3]], [[ECA-3.2]], or [[ES-3.1]] when backfill is
unavailable and the ruptured SG must be blown down to control level
during cooldown. Blowdown to condensate-receiver-tank route is preferred
(captures the activity); atmospheric blowdown is the fallback but
involves direct radiological release through the ruptured SG steam line.
Required Operations approval / EAL coordination before atmospheric
release.

CSF: heat-sink

CSF: containment

## Step 1 [id: align-blowdown]
Check: blowdown path availability — condensate-receiver-tank line «BLOWDOWN-A» path (or B/C/D as identified) AND atmospheric ARV «ARV-A» (or B/C/D) availability; radiation-release projections via plant emergency-dose-projection software
Caution: atmospheric blowdown is a controlled radiological release — must be authorized by SS / Emergency Coordinator before initiation
- Blowdown path available AND radiological release within authorized limits → #initiate-blowdown
  Because: ready to blow down
- No safe blowdown path available → [[ES-3.3]]
  Because: steam-dump alternative procedure

## Step 2 [id: initiate-blowdown]
Within: blowdown is a controlled-rate operation — typical rate determined by ruptured-SG level trend and radiological constraints
Action: open «BLOWDOWN-A» (or B/C/D as identified) to condensate-receiver-tank pathway; verify flow established
Action: monitor radiological release via «MAB-RAD» (main auxiliary building rad) and ARV exhaust monitors if atmospheric path is in use
Action: throttle blowdown to maintain ruptured-SG level in controlled band — too low risks dryout, too high risks overfill
Caution: monitor radiation-release continuously; if release approaches federally-imposed limits, throttle further or stop blowdown and transition to ES-3.3
Note: condensate receiver tank has finite capacity; blowdown must be sequenced with tank-drain operations to keep capacity available
- Blowdown controlled, levels manageable, radiation within limits → #cooldown
  Because: blowdown operating; proceed to cooldown loop
- Release approaching limits OR cannot control → [[FR-Z.3]]
  Because: high-containment-radiation response engages (release path through ruptured SG is functionally equivalent)

## Step 3 [id: cooldown]
Action: cool down using intact SGs at allowable rate (≤50 °F/hr); maintain ruptured-SG blowdown throughout cooldown
Within: cooldown 12-24 hr to RHR cut-in
- Cooldown complete to Mode 4 → END
  Because: post-SGTR cooldown via blowdown successful
- Heat sink lost on intact SGs → [[FR-H.1]]
  Because: heat-sink response

## Tags

- id: BLOWDOWN-A
  description: SG-A blowdown isolation valve position
  sim-path: secondary.blowdown.a.position
  units: enum[OPEN,CLOSED]
  equipment: sg-a
  source: Vogtle UFSAR §10.3

- id: ARV-A
  description: SG-A atmospheric relief valve position
  sim-path: secondary.arv.a.position
  units: enum[OPEN,CLOSED,INTERMEDIATE]
  equipment: sg-a-msl
  source: Vogtle UFSAR §10.3.2

- id: MAB-RAD
  description: main auxiliary building area radiation monitor
  sim-path: rad.mab.area
  units: rem_per_hr
  equipment: rad-monitoring
  source: Vogtle UFSAR §11.5

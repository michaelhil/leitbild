---
type: procedure
procedure-md: 0.7
procedure-id: FR-H.4
title: Response to Loss of Normal Steam Release Capabilities
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
reference-plant: vogtle
category: function-restoration
csfs-monitored: [heat-sink]
entry-triggers: [csf-yellow-path]
---

# FR-H.4 — Response to Loss of Normal Steam Release Capabilities

**CSF heat sink — YELLOW path.** Entered when the condenser steam dump
is unavailable — either condenser vacuum is lost, turbine-bypass valves
have failed, or the main condenser is isolated. Without condenser steam
dump, SG pressure must be controlled via atmospheric relief valves
(ARVs), which discharge directly to atmosphere. Continued operation in
this regime depletes condensate inventory faster, releases noble gases
to the environment, and is the precursor to FR-H.2 (overpressure) if
atmospheric relief also fails.

CSF: heat-sink

## Step 1 [id: verify-loss]
Check: condenser steam dump «STEAM-DUMP» availability indicators (turbine-bypass-valve auto-disabled, condenser vacuum «CONDENSER-VAC» degraded below operating range, condenser isolated); SG pressures «SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR» trending up
Caution: a temporary turbine-bypass mismatch with TAVG controller is not loss of steam dump; criterion is sustained unavailability
- Condenser steam dump confirmed unavailable AND SG pressures rising → #use-atmospheric
  Because: ARV alignment is required to prevent escalation to overpressure
- Condenser available, transient on TAVG controller → [[E-0]]
  Because: false alarm; return to diagnostic flow

## Step 2 [id: use-atmospheric]
Within: 5 minutes — SG pressure rises ~5 psi/min without relief at decay-heat power
Action: align atmospheric relief valves «ARV-A» / «ARV-B» / «ARV-C» / «ARV-D» for steam release; set pressure control to maintain post-trip no-load setpoint (~1010 psig)
Action: verify TDAFW pump «AFW-PUMP-T» continues running on SG steam (TDAFW steam supply unaffected by condenser status; AFW continues feeding)
Caution: ARV release is direct-to-atmosphere — coordinate with rad-engineering and emergency-response organization (ERO); if any SG has a tube leak, ARV release is the radiological release path
Note: Vogtle ARVs are nitrogen-powered with backup air; verify nitrogen supply «N2-SUPPLY» during extended operation
- ARVs aligned, SG pressures controlled at target → #monitor
  Because: alternative steam-release path established
- ARVs unresponsive or cannot maintain pressure control → [[FR-H.2]]
  Because: overpressure response handles the case where no relief path works

## Step 3 [id: monitor]
Check: SG pressures «SG-A-PR» / «SG-B-PR» / «SG-C-PR» / «SG-D-PR» stable at target; RCS cooldown rate not exceeding Tech Spec (≤100 °F/hr); condenser-recovery status
Within: re-evaluate every 15 minutes during continued atmospheric relief operation
- SG pressures stable AND cooldown rate within Tech Spec → [[E-0]]
  Because: stable operation on alternate steam-release path; return to diagnostic flow
- SG pressures rising despite ARV operation → [[FR-H.2]]
  Because: relief inadequate; overpressure response engages

## Tags

- id: STEAM-DUMP
  description: condenser steam dump availability (auto-permissive flag)
  sim-path: secondary.steam_dump.available
  units: bool
  equipment: secondary
  source: Vogtle UFSAR §10.4.4

- id: CONDENSER-VAC
  description: condenser vacuum (absolute pressure)
  sim-path: secondary.condenser.vacuum
  units: inhga
  equipment: secondary
  source: Vogtle UFSAR §10.4.1

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

- id: AFW-PUMP-T
  description: turbine-driven AFW pump status
  sim-path: afw.pump.tdafw.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: afw-system
  source: Vogtle UFSAR §10.4.9

- id: N2-SUPPLY
  description: ARV nitrogen-supply pressure
  sim-path: secondary.arv.n2_supply.pressure
  units: psig
  equipment: arv-system
  source: Vogtle UFSAR §10.3.2

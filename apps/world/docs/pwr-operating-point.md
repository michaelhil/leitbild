# Reference PWR operating point

Full power initializes 3,400 MW of fission power, the model's existing 6% initial decay-heat contribution, and a 1,100 MW electrical rating. It is a model-specific reference balance, not an output clamp or a universal nonlinear equilibrium solver. Changing loop count keeps total Plant rating and primary flow constant; per-loop equipment is sized accordingly.

The reference assembler derives primary flow/capacity, steam production, feedwater, heat transfer, condenser cooling and turbine references from the running equations. It distinguishes indicated steam-generator level from collapsed liquid inventory plus boiling swell. Saturation temperature uses [IAPWS IF97 Region 4, equation 31 and Table 34](https://iapws.org/public/documents/UWTF-/IF97-Rev.pdf); the rest of this simplified simulator is not a complete IF97 or engineering-qualified PWR model.

Electrical supply is reconciled in graph dependency order before pumps initialize. The Plant's simplified directed supply graph must be acyclic; this does not restrict electric-grid Pack networks. Reactor heat uses aggregate primary-loop flow. Incoming condenser temperature is flow-weighted, so a closed bypass cannot inject heat. Inactive parallel pumps do not reserve source capacity and starve running pumps.

Explicit parameter overrides remain authoritative and can intentionally describe an unbalanced condition. Restore uses progressed checkpoints; it never reapplies a full-power preset. Trip and cooling-loss tests must still change output physically.

Verification covers 2–6 loops, first-step thermal balance, primary mass conservation, electrical readiness, ten-minute no-fault behavior, load/trip/cooling failures and exact checkpoint restore. The simplified CVCS still produces a small thermal settling transient; this is not claimed as an exact whole-Plant steady-state solution or externally validated physical prediction. No display adjustment hides that transient.

The Halden integration now supplies approximately 4.4 GW rather than four drifting, underpowered units. The source-derived Grid contains separate demand islands and inferred line ratings, so the connected island can be oversupplied and show overloads. That is not repaired by inflating line ratings or forcing generation down. A future balanced operating scenario must explicitly author adequate local demand/export paths or dispatch; the integration test verifies real exchange and the frequency/generation effect of a unit trip, not an unjustified promise of zero alarms.

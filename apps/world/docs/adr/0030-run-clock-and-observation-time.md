# Run clock and observation time

Each Run has one simulation epoch and speed/pause control. Local projections use monotonic elapsed duration; wall time labels observations, accepted events, health, leases and external Agent work. Physics, local curves, scenario cues and recording cadence use simulation time. Historian samples already carry both observation and simulation time; internal solver elapsed time is a local integration coordinate, not another Run clock.

Unloaded time does not advance a simulation. Restore reanchors saved simulation progress at the current wall time. Changing the epoch of existing live state is not time travel: public clock controls therefore only change pause/speed. Genuine seek would require restoring and advancing *all* state, including fired cues, procedure state and every Pack; no Pack may pretend to support it by relabeling timestamps.

Pack solvers retain their numerical steps and update cadence, but derive elapsed work from the shared clock semantics rather than assuming a timer fired on schedule. Queries remain read-only. Clock transition work must retain elapsed progress under the old speed before adopting the new speed. Shared object/event timestamps are observation time; Pack-owned samples and physical projections explicitly identify simulation time. Neither wall-clock corrections nor UI interpolation drive physics.

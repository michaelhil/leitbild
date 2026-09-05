# Run copying, playback, and pace are independent

A Run Copy is an independent ordinary Simulation Run created at a coherent checkpoint. Copying does not imply how the copy executes.

Run execution has two independent controls:

- `playback` is `playing` or `paused`.
- `pace` is `realtime` or `maximum`.

This deliberately permits all four combinations. Pausing retains the selected pace, so a paused Run with maximum pace armed resumes at maximum pace. Selecting realtime while paused does not resume the Run. Realtime is always 1×; there is no second numeric speed control.

Maximum pace uses the same Pack clock boundaries and Capability surface as realtime execution. It advances in exact bounded simulation steps and yields between them, so ordinary reads and transactional commands remain available at coherent boundaries. Live external runtimes must explicitly support advancing future observations or reject maximum pace rather than inventing data.

The Workspace Host owns the controls and invokes the same discoverable Run Capabilities available to humans and Agents: read execution, set either axis, and advance by a fixed duration. A fixed-duration advance explicitly ends paused or playing at realtime pace. The Run registry serializes absolute control requests per Run; it does not maintain a second UI-only state machine or bespoke execution routes.

All copies share a stable Run Family identity that does not depend on editable names or on the continued existence of the original Run. World derives a family Resource and membership links from Run provenance; it does not persist another aggregate. Switching between family members replaces only the World pane. An explicitly opened Assistance Room can scope itself to all family members or a subset, while the Host sends the visible Run as transient per-browser focus. Focus is attention, never scope or Message history; Room Scope is the durable boundary and current Run restrictions describe exceptional AI limits within it.

# Run copying, playback, and pace are independent

A Run Copy is an independent ordinary Simulation Run created at a coherent checkpoint. Copying does not imply how the copy executes.

Run execution has two independent controls:

- `playback` is `playing` or `paused`.
- `pace` is `realtime` or `maximum`.

This deliberately permits all four combinations. Pausing retains the selected pace, so a paused Run with maximum pace armed resumes at maximum pace. Selecting realtime while paused does not resume the Run. Realtime is always 1×; there is no second numeric speed control.

Maximum pace uses the same Pack clock boundaries and Capability surface as realtime execution. It advances in exact bounded simulation steps and yields between them, so ordinary reads and transactional commands remain available at coherent boundaries. Live external runtimes must explicitly support advancing future observations or reject maximum pace rather than inventing data.

The Workspace Host owns the controls and invokes the same discoverable Run Capabilities available to humans and Agents: read execution, set either axis, and advance by a fixed duration. A fixed-duration advance explicitly ends paused or playing at realtime pace. The Run registry serializes absolute control requests per Run; it does not maintain a second UI-only state machine or bespoke execution routes.

All copies share a stable Run Family identity that does not depend on editable names or on the continued existence of the original Run. Switching between family members replaces only the World pane. The Agents Room remains mounted, and the Host sends the selected Run as transient per-browser focus. That focus is available to Agent discovery tools for the triggering turn but is never persisted into Room links or Message history; the Room's companion link remains its durable fallback.

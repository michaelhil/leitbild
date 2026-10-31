# Deployed native map and clean startup

The clean immutable release `20261027T131817Z-20a10558a6-1cd3709a42` activated code `20a10558a6978cd1bca678a41f6f25c401fb718e` and wiki `4fcb6e83df0b8e10429f1c3556cf0a819bb0c1f0`. The normal deploy runner completed its platform checks, tests and all three UI builds. Host, World, Agents, Caddy, OSRM and public health checks passed after activation. This deployment preceded the explicitly unfinished full-detail performance work in [the R4 checkpoint](../native-map-20261027/FINAL-NATIVE-R4.md).

A fresh Workspace and paused loss-of-offsite-power Run were created through the published Definitions and Capabilities. Reading all five retained physical layouts verified four exact unit R4 Designs `b4458fe4ae078623b6b8f426950b34627a49844ca5fc83f2c2bf970aa1a5da82` and the campus R4 Design `4bc1d405da6a996902a3f799c7af009144fdf617886edfcaed4f72012983cb84`, including their exact compiler pins. Existing Runs were not rewritten.

The actual production UI was then checked in the in-app browser at 1280 × 720 CSS pixels:

- After real map startup, the new briefing names **View → Grid operations**, has an X, and the Grid panel, alarm strip and layout controls are absent. The header retains two unacknowledged alarms.
- The briefing X closes it. The real header View disclosure offers its four checked visibility choices; Layout controls opens the native map toolbar.
- Selecting Unit 1's turbine-hall/annex, then the operating floor, draws the architectural Plan with a fresh paused owner status.
- Switching to 3D and Stack, enabling Utility routes, and using Home shows the restored two-level machinery, architecture and routes. The explicit additional-layer preparing status clears on completion; the valid existing model remains available meanwhile.

The screenshots are unedited production captures: [startup](./public-clean-startup.png), [operating Plan](./public-native-plan.png), [stacked 3D with utilities](./public-native-3d.png). They establish these visible product interactions, not a new framebuffer-equivalence or timing result. Home currently favours a tall free rectangle left of the corner camera toolbar; that composition issue is retained in the image and is being corrected independently. Current-camera and full-detail performance limitations are not hidden by the screenshots.

This smoke check did not inject a worker failure or requalify every routing card. The local actual-product Retry/rapid-toggle exercise and further CPU/GPU diagnosis remain separate checks. The production review Run is [available here](https://leitbild.app/workspaces/082e8b7b-87ef-463b-aa0c-4206acc7ca80?world=run-0b521707-52e7-4efb-bdbf-19fd7ee9a164).

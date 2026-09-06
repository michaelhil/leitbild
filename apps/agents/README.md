# Agents Module

Owns Rooms, messages, Agent profiles, tools, model routing and conversation evidence. It does not import World or Host implementations.

Read [agent discovery](https://leitbild.app/wiki?path=agents%2Fdiscovery.md) and [context and inspection](https://leitbild.app/wiki?path=agents%2Fcontext-and-inspection.md). Exact executable guidance remains in `skills/` and the context builder; use the Generation Inspector for a particular response.

Run checks and tests through this Module's `package.json` scripts. Preserve the invariants in `AGENTS.md`.

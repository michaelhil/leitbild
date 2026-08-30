# Definitions, Resources, Capabilities, and Presets form the orchestration model

Leitbild uses Module-owned immutable Definitions to describe what can be created, Resources for live state, and typed Capabilities for every meaningful external operation. Reusable fragments remain inside one Module and compile into normalized Definition Revisions. Cross-Module Presets reference pinned Definition Revisions and create ordinary Resources without embedding Module-private payloads or becoming an ongoing workflow controller; ongoing automation remains owned by World Timelines, Agent Scripts, or a specific typed Binding.

This rejects both a universal scenario tree/runtime and unrelated browser-side launch procedures. A universal engine would couple the Host to every Pack and confuse simulation time, continuous physics, wall-clock schedules, and multi-Agent turn-taking, while browser procedures are not durable, discoverable, or AI-invocable.

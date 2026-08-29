# Use one Host with isolated domain Modules

The product has one public Host for identity, core Module provisioning state, navigation, and routing, while World, Collab, and Agents own their domain state and may run as separate processes. This removes duplicated Workspace authorities and the user-visible app barrier without creating a shared domain monolith. ADR 0005 later fixes all three Modules as part of every Workspace.

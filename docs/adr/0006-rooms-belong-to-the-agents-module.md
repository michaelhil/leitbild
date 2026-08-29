# Rooms belong to the Agents Module

Leitbild exposes World and Agents as its two core Modules. Rooms, messages, membership, documents, and coordination belong to the Agents bounded context rather than a separate Collab Module. The former split had no independent UI, process, runtime, composition, or product lifecycle and therefore duplicated manifests, routes, provisioning state, and failure modes without creating real modularity. Room and Agent Profile persistence remain separate strict internal documents so their schemas can evolve independently without inventing a second product Module.

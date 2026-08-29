# Share wire contracts, not domain implementations

The platform contracts package contains versioned identifiers, errors, discovery envelopes, event transport metadata, and pack descriptors. Rooms, Simulation Runs, domain events, persistence services, pack runtimes, and application use cases remain private to their owning application to prevent accidental lockstep architecture.

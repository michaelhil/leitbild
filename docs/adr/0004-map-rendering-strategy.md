# ADR 0004: Map Rendering Strategy

## Decision

Leitbild starts with MapLibre GL JS for the operational map.

Three.js and deck.gl are deferred until a concrete visualization requirement justifies them.

## Rationale

The first research slice needs a persistent, interactive, layered, real-time operational map. MapLibre provides a WebGL map foundation without committing the project to heavier visualization stacks too early.

## Consequences

- Domain objects are projected into map view models.
- Rich mini-trends and inspectors are rendered as UI overlays, not as canonical map data.
- Three.js remains an optional visualization module, not a core dependency.

# Grids own dense private Grid Assets behind one Operational Object

An authored Grid selects a Grid Model, Operating Point, and Automation Definition and compiles to one Operational Object; its buses, branches, generators, loads, and storage remain stable, discoverable Grid Assets in the Electric Grid runtime. This avoids projecting hundreds or thousands of solver assets into canonical World state, keeps Scenario Definitions compact, and aligns Grid lifecycle semantics with Process Plant while retaining different internal models.

Grid commands and bounded queries address an explicit Grid id plus Grid Asset id. Reference-map geometry stays in the reference-data pipeline. Grid Models expose typed network Electrical Ports; compatible system Packs expose their own Electrical Ports; and a Scenario owns the explicit connections between them. Runtime coupling resolves those ports without moving either Pack's internal physics into a shared solver.

The working Process Plant-to-Grid integration proved that Electrical Port plus Electrical Connection is the smallest useful cross-Pack abstraction. We still reject per-asset Operational Objects, a universal component graph, and a generic co-simulation framework: adding a second physical domain must justify a second, domain-specific connection type instead of expanding Electrical Connection into an untyped binding mechanism.

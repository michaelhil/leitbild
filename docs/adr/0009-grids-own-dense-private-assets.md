# Grids own dense private Grid Assets behind one Operational Object

An authored Grid selects a Grid Model, Operating Point, and Automation Definition and compiles to one Operational Object; its buses, branches, generators, loads, and storage remain stable, discoverable Grid Assets in the Electric Grid runtime. This avoids projecting hundreds or thousands of solver assets into canonical World state, keeps Scenario Definitions compact, and aligns Grid lifecycle semantics with Process Plant while retaining different internal models.

Grid commands and bounded queries address an explicit Grid id plus Grid Asset id. Reference-map geometry stays in the reference-data pipeline, and Grid Models may expose typed electrical connection points for future coupling. We reject per-asset Operational Objects, a universal component graph, and a generic binding or co-simulation framework until a concrete cross-Pack connection proves the smallest required abstraction.

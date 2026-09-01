# Agents Packs

An Agents Pack is a strict deployment-scoped bundle of tools, skills, scripts,
geodata, wiki metadata, or a known UI extension. Packs belong to Agents; World
Packs use World's own runtime and schema.

Every Pack requires `pack.json`:

```json
{
  "descriptor": {
    "schemaVersion": "1.0.0",
    "id": "example",
    "moduleId": "agents",
    "version": "1.0.0",
    "name": "Example",
    "description": "Example Agent capabilities.",
    "platformVersionRange": "^1.0.0",
    "dependencies": [],
    "contributions": [{ "kind": "tool" }]
  },
  "wikis": [],
  "uiExtensions": []
}
```

The manifest is the only Pack description. Missing manifests, unknown fields,
unsupported versions, wrong Module ownership, undeclared wiki metadata, and
inconsistent UI-extension declarations fail visibly. There are no inferred
names, legacy layouts, or compatibility parsers.

Optional directories are `tools/`, `skills/`, `scripts/`, and `geodata/`.
Tools register as `<pack-id>_<tool-name>`; skills register as
`<pack-id>/<skill-name>`. A Room activates Packs explicitly, and Agents see
only tools allowed by both the Room's active Pack set and their Tool Grants.

Packs are executable code and use the Deployment's trust boundary. Installing
one is equivalent to trusting its source. The implementation lives in
`src/packs/`; `src/packs/pwr-ops/pack.json` is the bundled reference manifest.

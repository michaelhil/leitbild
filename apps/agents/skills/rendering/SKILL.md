---
name: rendering
description: Use when the user asks to draw, render, plot, visualize, sketch, chart, graph, diagram, or map something — or asks "show me", "what does X look like", or "compare X vs Y". Produce the fenced block directly; the UI renders it inline. Do NOT say "I can't show diagrams here" — you can.
---

leitbild renders three kinds of fenced code blocks inline:

- ` ```mermaid ` — diagrams (flowchart, sequence, state, class, ER, gantt, pie, mindmap)
- ` ```map ` — geographic visualizations (markers, lines, polygons, circles)
- ` ```geojson ` — same renderer as ```map, accepts GeoJSON FeatureCollection directly

When the user asks for one of these, emit the fence in your reply. Don't apologize, don't describe what you'd draw — just draw it.

## When NOT to use a fence

Don't dump a fence on every reply. Skip the visualization when:
- The user asked a single-paragraph factual question ("what's the capital of Norway?")
- The conversation is casual chat ("how's it going?")
- The request is genuinely text-shaped ("explain in one sentence")
- You don't actually have the information needed (then ask one clarifying question instead — see "Ambiguous request" below)

If the user explicitly asked to draw / map / chart / visualize, the fence IS the answer. Otherwise, prose is usually better.

## Mermaid diagrams

Uses the installed Mermaid v11 renderer. The UI accepts at most 50,000 JavaScript UTF-16 string units of source; this is not a 50 KB file-size limit. Mermaid also has a default cap of 500 edges. These are rendering ceilings, not targets or a node-count limit. Do not add initialization directives to raise them.

Choose the diagram type and orientation for the relationships and available space. A long process often reads better top-to-bottom in chat; a broad hierarchy may benefit from left-to-right. Honor an explicitly requested direction. Keep labels concise, use stable node IDs, and quote labels containing punctuation. Write valid source rather than relying on the renderer's repairs.

```mermaid
flowchart LR
  A["Start"] --> B{"Decision"}
  B -->|"yes"| C["Path 1"]
  B -->|"no"| D["Path 2"]
```

Preserve every requested fact and relationship. For complex diagrams, an overview with separate detail views can improve readability, but make the abstraction explicit and retain a requested complete view. Never silently omit edges or impose an arbitrary node limit. If the complete source exceeds rendering limits, explain the constraint and propose a split with clear cross-view references or a source-only delivery.

For layout-only revisions, preserve node IDs, labels, edges, and their direction; change only the supported layout declaration. Increasing font size alone does not solve a wide graph that the UI shrinks to fit. Prefer a more suitable orientation, shorter labels, and useful grouping before adding detail.

### Color only when it helps

Keep diagrams neutral unless color materially clarifies responsibility, categories, status, or an important path. Use a small, consistent palette and pair it with labels, grouping, shapes, or line styles, so meaning survives monochrome and color-vision differences. Do not give every node a different color.

For flowcharts, use standard Mermaid `classDef` and `class` styling. Set fill, text color, and stroke together for contrast; check the result in both light and dark modes when testing a styled diagram. Bare names such as `:::blue` have no built-in palette in Leitbild. Do not force a global theme to add color.

```mermaid
flowchart TB
  Check{"Validation"} -->|"Accepted"| Ready["Ready"]
  Check -->|"Needs review"| Review["Review required"]
  class Ready accepted
  class Review review
  classDef accepted fill:#dcfce7,color:#14532d,stroke:#15803d
  classDef review fill:#ffedd5,color:#7c2d12,stroke:#c2410c
```

### Rendering failures

Distinguish malformed or incomplete source, source/edge limits, unsupported syntax or assets, and unreadable scaling. Use syntax supported by the installed renderer; do not promise that every Mermaid version or diagram type behaves identically. For complex or unfamiliar syntax, test the actual rendering pipeline when available. A successful parse does not establish readable text or preserved relationships.

If the user reports a failure, keep the original source and repair the smallest failing construct. Mermaid fences are not validated or automatically retried by the server-side evaluation loop; the browser reports a rendering failure and retains the source. Do not claim a render was verified unless it was inspected.

### Other mermaid types — one example each

Sequence diagram:
```mermaid
sequenceDiagram
  Alice->>Bob: Hello
  Bob-->>Alice: Hi back
```

State diagram (v2 syntax — use `[*]` for initial/final pseudo-states):
```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Loading: fetch
  Loading --> Idle: done
  Loading --> Error: fail
  Error --> [*]
```

Pie chart:
```mermaid
pie title Browser share
  "Chrome" : 65
  "Safari" : 18
  "Firefox" : 9
  "Other" : 8
```

Gantt:
```mermaid
gantt
  title Sprint plan
  dateFormat  YYYY-MM-DD
  section Backend
  API design     :a1, 2026-01-01, 3d
  Implementation :after a1, 5d
```

Other Mermaid v11 diagram types may work, but verify unfamiliar syntax against the installed renderer when possible. Do not rely on showing a failed source block as the intended result.

## Maps

Use a ` ```map ` fence containing an envelope JSON. Schema below; canonical example first:

```map
{
  "view": { "center": [60.472, 8.469], "zoom": 5 },
  "features": [
    { "type": "marker", "lat": 59.9139, "lng": 10.7522, "label": "Oslo" },
    { "type": "marker", "lat": 60.3913, "lng": 5.3221, "label": "Bergen" },
    { "type": "line", "coords": [[59.9139, 10.7522], [60.3913, 5.3221]], "color": "#1d4ed8" }
  ]
}
```

**Tip**: omit `view` entirely to let the renderer auto-fit to your features. This is more reliable than guessing center+zoom — only set `view` when you have a specific framing in mind.

### Schema

```typescript
type MapEnvelope = {
  view?: { center: [lat: number, lng: number]; zoom: number }   // omit for auto-fit
  features: Array<MapFeature>
}

type MapFeature =
  | { type: 'marker';  lat: number; lng: number; label?: string; tooltip?: string; color?: string;
      icon?: 'pin' | 'platform' | 'airport' | 'plane' | 'ship' | 'city' | 'dot' }
  | { type: 'line';    coords: Array<[lat: number, lng: number]>; color?: string; weight?: number }       // ≥ 2 pairs
  | { type: 'track';   coords: Array<[lat: number, lng: number]>; color?: string; weight?: number }       // ≥ 2 pairs
  | { type: 'polygon'; coords: Array<[lat: number, lng: number]>; color?: string; fillColor?: string }   // ≥ 3 pairs
  | { type: 'circle';  lat: number; lng: number; radius: number; color?: string }                        // radius in metres
```

All coordinates are `[lat, lng]` — never GeoJSON's `[lng, lat]` order. Latitude ∈ [−90, 90]; longitude ∈ [−180, 180]. Icon names are case-insensitive but the value must be in the closed enum above.

### GeoJSON shortcut

If you already have GeoJSON output (e.g., from a tool), emit it in a ` ```geojson ` fence:

```geojson
{ "type": "FeatureCollection", "features": [
  { "type": "Feature", "geometry": { "type": "Point", "coordinates": [10.7522, 59.9139] }, "properties": { "title": "Oslo" } }
]}
```

The renderer normalises GeoJSON's `[lng, lat]` order automatically when the fence is `geojson`. Inside a `map` fence, always use `[lat, lng]`.

## Tools first

If you have any data-providing tool in scope (e.g., a lookup or fetch tool that returns coordinates, traffic, weather, etc.), call it FIRST, then emit the map fence with the tool's real data. Don't hallucinate coordinates when a tool can give you ground truth.

## Ambiguous request

If the user says "show me X on a map" and you don't have coordinates and have no tool to look them up:
- Use approximate coordinates from your knowledge (and say so in one line below the fence: *"Approximate coordinates — let me know if you want me to look these up precisely."*)
- OR ask one specific question ("Which city — Oslo or Bergen?") then produce the map next turn.

If the user says "diagram of X" without specifying type, use a flowchart for processes/decisions with a direction suited to readability, or `sequenceDiagram` for interactions over time.

## Recovery from validation errors

If a `map` fence fails to render, the UI shows precise validation errors below the fence — paths like `features[1].lat` mean the second feature's `lat` field. Read them, fix the schema, send a new fence in your next turn. The eval loop also auto-retries up to 2 times before posting a broken fence, so a fixable mistake will often correct itself before the user even sees it.

The validator silently normalises a few common LLM variations to the canonical shape. You're not required to use them — prefer the canonical form above — but if your output drifts, these still work:

- Marker point: `position: [lat, lng]`, `position: { lat, lng }`, `point: [lat, lng]`, or `coords: [lat, lng]` (singular, marker only) — all aliased to flat `lat`/`lng`.
- Marker label: `title: "..."` and `name: "..."` aliased to `label`.
- Line/polygon coords: `points`, `coordinates`, `path` aliased to `coords`.
- Marker icon: case-insensitive with surrounding whitespace stripped.

What still fails:
- Coordinate order is **never** auto-flipped — `[lng, lat]` (GeoJSON order) inside a `map` fence will be interpreted as `[lat, lng]` and likely fail the range check.
- Icon names outside the closed enum.
- Coordinates outside the valid ranges.

# Scripts — Multi-Agent Living Documents

A script is a markdown document that orchestrates a multi-agent
conversation. At runtime, the cast receives a rendered view of the script
plus the current dialogue and readiness signals. The right rail keeps the
original markdown source separate from a compact live status view.

## File format

Scripts live at `$LEITBILD_HOME/scripts/<name>/script.md` (or flat
`<name>.md`). The grammar is strict; bad input is rejected with a
line-precise error.

```markdown
# SCRIPT: <title>                       ← required, exactly one
Premise: <one-line text>                 ← optional
Turn-taking: broadcast-pass              ← optional; broadcast every turn to all cast

## Cast                                  ← required

### <CastName>  [(starts)]               ← one per cast member, ≥2
- model: <model-id>                      ← required
- tools: <csv> | [a, b, c]               ← optional
- includeTools: true|false               ← optional
- persona: |                             ← required, multiline (4-space indent)
    <line>
    <line>

---                                      ← required separator

## Step <N> — <title>                    ← N is 1-based, sequential
Goal: <one-line text>                    ← optional
Roles:
  <CastName> — <role1>; <role2>; ...     ← em-dash, en-dash, "--", or "-" all OK
  <CastName> — <role>
```

Cast names must match between `## Cast` and every step's `Roles:` block.
Exactly one cast member must carry the `(starts)` marker — they speak
first when the script begins. Step numbers must be contiguous from 1.

By default, the runner uses directed turn-taking: one cast member is
activated after the previous post. `Turn-taking: broadcast-pass` changes the
boundary to a broadcast round: every cast member receives each turn, in cast
order, and may use the built-in `pass` tool when their discipline has no new
contribution. Once the round is complete, readiness gates the next round or
step. Agents should not address one another by name in this mode; the shared
ledger and step goal provide the coordination surface.

A complete reference script is in `examples/scripts/quarterly-planning.md`.

## Runtime: the living document

When a script starts in a room, the runner:

1. Spawns each cast member as a normal AI agent (scoped to the room).
2. Switches the room to manual delivery (so cast members speak only when
   activated by the runner).
3. Posts a `Stage` card to the room marking the start of step 1.
4. Activates the `(starts)` cast member.

After every cast post, the runner runs a small **whisper** classification:
a one-shot JSON call to the same model asking the agent to flag whether
its turn substantially served the step's goal. The whisper is recorded
with the dialogue entry; when both cast members' last whispers say
`ready_to_advance: true`, the step advances.

A non-cast message (you typing in the room) resets readiness AND the
"asked N×" pressure counters — new information restarts the clock.

## What the cast sees

Cast members do NOT receive the normal context-builder output (house
prompt, room participants, artifacts, message history). Their entire
system prompt IS the rendered living document for their viewing
perspective:

- `(you)` marker on their own cast row
- Persona one-liners for everyone (full personas live in the file but
  are compacted in the rendered view)
- All steps shown — past with `[COMPLETE]` and dialogue + the cast
  member's own whisper notes; current with `[CURRENT]`, the Pressure
  block, dialogue + their own whispers, and `← last` + `(your turn)`
  cues; upcoming as title + goal + roles only
- Their own whispers only — they cannot see peers' inner monologue

The user message that follows the system prompt is a single instruction:
*"Speak your next line as <name>. Reply with dialogue only."*

## What you see (right-rail panel)

The panel is split into two views:

- **Original script source** — the raw `script.md` fetched from the script
  catalog. It never accumulates live dialogue.
- **Live status** — the current step title and goal, plus one row per cast
  member showing the number of utterances in that step and whether their
  latest whisper says they are ready. A ready streak (`ready · N×`) shows
  how many consecutive turns have been ready while waiting for peers.

The status view also surfaces whisper failures and shows `Complete` when the
run finishes. It:

- Shows when a script is active in the selected room; hides otherwise
- Drag-resizable (width persists in localStorage)
- Re-renders on every WS event (`script_dialogue_appended`,
  `script_readiness_changed`, `script_step_advanced`, `script_started`,
  `script_completed`)
- Closeable per-run (the room-header chip remains visible)

## Pressure to proceed

The whisper schema produces one boolean per turn (`ready_to_advance`).
The runner derives a `readyStreak` per cast member: how many consecutive
turns they've been ready while waiting for peers. Surfaced as:

- `not ready` — `readyStreak = 0`
- `ready (asked 1×)` — first ready signal
- `ready (asked N×)` — has been waiting on a peer for N turns

When all cast members are ready, the step advances. Resets on step
advance and on user interjection.

## REST + WebSocket surface

```bash
SCOPE=http://localhost:3000/api/workspaces/<workspaceId>

# Catalog
curl "$SCOPE/scripts"
curl -X POST "$SCOPE/scripts/reload"
curl "$SCOPE/scripts/<name>"      # full source
curl -X POST -H 'Content-Type: application/json' \
  -d '{"name":"x","source":"# SCRIPT: …"}' \
  "$SCOPE/scripts"                # upsert
curl -X DELETE "$SCOPE/scripts/<name>"

# Per-room run
curl "$SCOPE/rooms/<room>/script"
curl "$SCOPE/rooms/<room>/script/document?viewer=director"
curl -X POST -H 'Content-Type: application/json' \
  -d '{"scriptName":"<name>"}' \
  "$SCOPE/rooms/<room>/script/start"
curl -X POST "$SCOPE/rooms/<room>/script/stop"
curl -X POST "$SCOPE/rooms/<room>/script/advance"
```

WebSocket events broadcast to room subscribers:
`script_started`, `script_step_advanced`, `script_readiness_changed`,
`script_dialogue_appended`, `script_completed`, `script_catalog_changed`.

## Authoring tips

- **Persona is character + voice; role is what they push for in this step.**
  A character's persona stays constant across steps; their role changes.
- **Two or more cast members.** The runner activates one speaker at a time
  and advances round-robin unless a whisper explicitly addresses another
  present cast member. Four-person scripts work well for demonstrations,
  but more cast members make each consensus gate take longer.
- **Interlocking goals create movement.** Step 1's role for Alex should
  imply something Sam needs to do for Alex to feel ready, and vice
  versa.
- **Stuck steps stall in the dialogue, not the engine.** If a step doesn't
  advance, the Pressure block tells you which agent is holding back. Use
  the operator force-advance button (▶▶) sparingly — it bypasses
  readiness and may produce uneven scenes.

## Internals: the message hook

The runner attaches to the room via the `onScriptMessage` callback in
`RoomCallbacks` (see `src/core/rooms/room.ts`). The dispatch fires inside
`room.post()` immediately after `onMessagePosted`. This is a direct
callback, not a `lateBinding` proxy: the runner is always wired by the
time rooms exist, so the warn-once-on-missing-subscriber benefit doesn't
apply, and a direct callback keeps the dispatch site visible at the call
location instead of hiding it behind a proxy.

`ScriptRun` state (per-room script execution: current step, readiness,
dialogue log, role overrides) lives RAM-only inside the runner closure.
It is **not persisted** across restarts — by design, matching v1 (see
the strict Module snapshot notes in `README.md`). A server restart mid-
script ends the run; the cast agents are torn down with their room as
usual. This is a deliberate scope choice, not an accident; revisit only
if a concrete use case for resumable scripts emerges (the obvious case —
long-running improv scenes that survive a deploy — has not been
requested).

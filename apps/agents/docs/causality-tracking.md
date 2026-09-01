# Message causality

Agents stores each room as a chronological message stream while preserving
causal relationships between responses. This supports concurrent agent turns
without imposing a threaded-chat UI or a separate graph store.

## Model

`Message.inReplyTo` contains the ids of the messages that were in an agent's
incoming buffer when it evaluated a response. The ids are globally unique and
may refer to room or direct messages the agent actually received.

- `correlationId` groups sibling messages emitted by one routing operation.
- `inReplyTo` identifies the causal parents of a response.

The fields are independent: a broadcast can create several messages with one
`correlationId`, all sharing the same causal parents.

## Capture and rendering

`src/agents/ai-agent.ts` captures the incoming ids from the context build and
passes them through evaluation, spawning, delivery, and room posting. Both
responses and visible pass decisions retain their causal parents.

`src/agents/context-builder.ts` resolves parent ids across the agent's room and
direct-message histories. LLM context renders the sender relationship in a
compact form such as `[Analyst → Michael, Alice]`. Unresolvable compressed
parents are labeled as summarized rather than silently discarded.

## Compression

Room history compression is owned by `src/core/summaries/summary-engine.ts` and
scheduled by `summary-scheduler.ts`. A compression run:

1. summarizes the oldest eligible messages;
2. replaces the previous summary with one evolving `room_summary` at the start
   of the stream;
3. records the removed message ids in the room's `compressedIds` set.

Room snapshots persist both the summary message and `compressedIds`. This lets
causal references remain honest after restart without retaining the complete
message payload indefinitely.

## Boundaries

- Causality is metadata on messages, not a separate persistence subsystem.
- An agent can only cite messages delivered into its own incoming buffer.
- The chronological room stream remains authoritative for display and replay.
- Compression is the only supported removal path for causally referenced room
  messages.
- Tool-originated posts are independent actions unless their caller explicitly
  supplies causal message metadata.

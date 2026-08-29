# Workspace Control-Plane Benchmark

## Decision

The completed experimental Workspace Host has no material control-plane performance regression that blocks the rewrite. In the repeatable post-rewrite run it started and created Workspaces materially faster than the old Suite. Workspace listing was slightly slower, but remained sub-millisecond while returning a progressively growing set of up to 75 Workspaces.

This is a narrow regression test, not a production capacity claim. Dynamic Agent discovery and the standalone/combined Experience topology are covered by the real-Module integration and local browser acceptance tests rather than this control-plane microbenchmark.

## Reproduction

Run:

```sh
bun run benchmark:control-plane
```

The script creates a detached temporary worktree for the fixed baseline, installs its locked dependencies, starts each control plane on an ephemeral loopback port, performs 75 sequential create-and-list iterations, prints JSON, and removes all temporary state.

## Compared builds

| Build | Git revision | Persistence |
| --- | --- | --- |
| Old Suite baseline | `d2125236f0bf6882b4e295b254201dd58806271d` | JSON file |
| Experimental Workspace Host | `53885a6560b42806810e0ed82be2cc28a5aa9651` | SQLite |

Environment: Apple M2, arm64 macOS/Darwin 25.3.0, Bun 1.4.0. Measurements were taken over loopback on 2026-08-29 with no Modules configured, isolating the Workspace control plane.

## Results

| Metric | Old Suite | Workspace Host | Observation |
| --- | ---: | ---: | --- |
| Startup to healthy | 74.38 ms | 43.57 ms | Host 41% faster |
| Create mean | 1.476 ms | 0.442 ms | Host 70% faster |
| Create p50 | 0.993 ms | 0.399 ms | Host 60% faster |
| Create p95 | 1.849 ms | 0.485 ms | Host 74% faster |
| List mean | 0.261 ms | 0.383 ms | Host 0.122 ms slower |
| List p50 | 0.174 ms | 0.385 ms | Host 0.211 ms slower |
| List p95 | 0.495 ms | 0.568 ms | Host 0.073 ms slower |
| Persisted file after 75 creates | 16,237 bytes | 28,672 bytes | SQLite has fixed page overhead |

## Interpretation and limits

- The listing result grows during the run, so the reported mean covers lists containing one through 75 Workspaces rather than a fixed payload size.
- The SQLite file size is allocated in pages and is not directly comparable to compact JSON bytes. It buys normalized membership state, transactions, constraints, and safer concurrent writes.
- A single local startup sample is sensitive to scheduler and filesystem cache noise. It is useful as a large-regression detector only.
- Module provisioning, remote latency, UI rendering, concurrent clients, and sustained load are deliberately excluded. They require separate scenario benchmarks.
- The Host performs more lifecycle work than the Suite: it derives Experiences, records retryable Module Membership state, aggregates Resources and Capabilities, and enforces ownership at the boundary. The measured listing overhead is acceptable at this scale, but should be profiled if realistic Workspace counts make it visible.

## Architectural comparison

| Concern | Old Suite | Experimental platform |
| --- | --- | --- |
| Workspace authority | Suite plus app-local Workspace concepts | One authoritative Workspace Host |
| User composition | Technical Modules exposed directly | Experiences compose Modules without owning state |
| Domain integration | App-specific bindings and proxy knowledge | Namespaced Resource discovery and typed Capability invocation |
| Failure model | Limited orchestration visibility | Explicit, structured, retryable Module Membership failures |
| Persistence safety | Whole-file JSON replacement | Transactional SQLite with constraints |
| Workspace selection | Mixed URL and cookie behavior | Canonical URL identity only |
| Standalone operation | Separate app topology | Same Host-plus-Module topology with fewer Experiences |
| Extensibility | New cross-app code per integration | Modules publish generic Resources and Capabilities |

The experiment therefore improves structural capability substantially while remaining in the same practical latency class for the tested control-plane operations.

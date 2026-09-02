# Procedure lifecycle hardening

## Scope and completion criteria

Implement the seven post-refactor findings without replacing Packs, introducing a
workflow engine, changing authentication, or adding compatibility paths. World
owns shared procedure state. Source documents are immutable by revision. Browser
selection, drafts, and scroll are local view state.

## Implementation sequence

1. **Concurrent commands.** Prepare immutable procedure documents outside the
   Simulation Run publish queue. Inside the existing queue, re-read current state,
   verify that the target asset and Run still exist, validate the operation, then
   allocate event sequence numbers and publish the complete event batch. Concurrent
   starts must produce one Run; reset/deletion during document fetch must prevent
   stale updates or resurrection. No network I/O inside the commit queue.
2. **Server-owned transitions.** Add one `world.procedure.run.transition`
   Capability accepting source Run, source step, and declared branch index. Resolve
   the branch from the source Run's pinned document, not client-supplied target
   configuration. Validate target state before changing the source. Start a missing
   target (or reuse an active target with the same revision), record the source
   step, and close the source in one existing event batch. Remove browser delays and
   multi-request transition orchestration. Preserve the current completed-source
   and failed-branch placekeeping semantics; do not invent a new status taxonomy.
3. **Window and unit isolation.** Route both the process-display button and rail
   button through the same route-owned window manager. Remove the nested modal
   loader. Scope annotation drafts and scroll by unit, exact document, and step.
   Capture identity at asynchronous boundaries; late tag, assessment, navigation,
   or confirmation work must not affect a newly selected unit/document.
4. **Progress versus annotation.** Preserve `currentStepId` when a comment or
   favorite changes. Explicit assessment/navigation actions send the desired
   current step. Test that annotations do not move another operator's pointer.
5. **Document and refresh lifecycle.** Create one small route-owned procedure
   session with an immutable-document cache and in-flight coalescing, shared by
   rail summaries and all procedure windows. Bound background prefetch to four
   workers; releasing the final procedure window stops scheduling further work.
   Dispose the session on route teardown. Serialize/coalesce Run refreshes; publish
   canonical Run state before best-effort document enrichment. Keep view errors
   separate from optional prefetch warnings. Opening a cached document must not
   flash a loading page. Initial loads must catch up events received while loading.
6. **Metadata and strict boundaries.** Use catalog categories, declared monitored
   assessments, and source repository metadata instead of ID-prefix/PWR/repository
   constants. Validate procedure HTTP responses with existing schemas and remove
   unscoped-run compatibility filtering. Remove the always-unknown step-machine
   evaluation scaffold rather than implementing pretend automation. Validate
   requested document identity on cache hits. Explain in Agent tool metadata that
   live Run guidance uses World's pinned document/Run capabilities; general wiki
   lookup remains a separate current-reference tool.
7. **Regression coverage and operations.** Add deterministic tests of concurrent
   operators, refresh ordering, partial-transition prevention, deleted targets,
   exact revision reads, cache coalescing, prefetch release/disposal, and view-key
   isolation. Verify both UI opening paths and shared-state navigation in browser
   testing where feasible. Update deployment instructions and the local server
   operations skill/helper to current Host/World/Agents services and public domain.
   The health command must fail on actual unhealthy components, not print a false
   green result. Run all package checks/tests/builds, push, deploy, and verify.

## Adversarial review and resulting constraints

- **Queue contention:** moving an async fetch into the queue would freeze unrelated
  simulation events. Use prepare/commit separation with synchronous revalidation.
- **Partial state:** a UI sequence is not a transaction. One Capability generates
  an ordered batch through the existing durable event path; this is not a new
  database transaction or a stronger storage guarantee than that path provides.
- **Scope authority:** transition scope comes from the existing Run, never a second
  client-supplied plant id. The target must be a declared procedure branch.
- **Overgeneralization:** share one World-local session, not a universal cache,
  plugin runtime, or cross-Module business-logic package. Keep renderer/parser
  differences where they serve different consumers.
- **Lifetime and authority:** cached documents can be shared; drafts and scroll
  cannot become global operational truth. Releasing a view does not cancel a
  foreground read another view is using. Shared progress must not force-scroll a
  user who is already reading elsewhere.
- **Failures:** prefetch failure is retryable and diagnostic; failure to fetch a
  selected document is visible. Document enrichment cannot suppress new checkmarks.
- **Discovery:** metadata selection should preserve source-declared monitored
  assessments; do not replace the six PWR constants with another hardcoded list.
- **Tests:** prove observable behavior and invariants, not source-string snapshots.
  Use test doubles only inside tests. No production mocks, placeholders, or legacy
  adapters. Operations-helper tests must not restart production services.
- **Scope control:** update operational documentation and diagnostics, not firewall,
  secrets, unrelated services, retained data, or backup policy.

## Delivery record

Implementation and verification results are recorded below as phases complete.

- Implemented all seven scoped changes, including the transition Capability in
  the integrated control-room Agent's grants and pinned-document guidance for AI.
- Added regression tests through the real runtime queue, persistence and two
  realtime client projections: competing starts, shared assessments, annotations,
  failed/atomic transitions, target reuse, reset/deletion races and restoration.
- Added session tests for coalesced reads, ordered refresh/catch-up, enrichment
  failures, bounded/shared prefetch, release/abort, metadata categories and view
  identity. HTTP response and cached source-identity validation are covered.
- Canonical repository gate: checks passed; 2,101 tests passed, two existing skips;
  all builds passed. Existing large-chunk build warnings remain.
- Browser verification on a disposable local four-unit run: both opening paths,
  all 39 manifest-discovered procedures, cached switching without the full loading
  panel, shared step-12 restoration with its assessment, cross-unit navigation,
  and E-0 to FR-S.1 transition. Local map artifacts are absent, so production
  browser verification is needed for live remote updates.
- Updated World deployment instructions and the local operations skill/helper
  outside this repository. Its live health check and ten failure/success tests
  pass; skill metadata validates. No production configuration, backup policy, or
  persistent user data was changed by this housekeeping.
- Supplemental Svelte-specific checking exposed typing debt outside the normal
  TypeScript gate. Errors in the modified procedure modal were corrected; broader
  component typing/check integration is a separate follow-up, not a new layer in
  the procedure architecture.
  Using identical dependencies, the previous commit reported 70 errors and two
  warnings; this pass reports 55 errors and one warning, with zero errors in
  `ProcedureSystemModal.svelte` or `ProcessDisplayModal.svelte`.
- Final integration review unified scope equality on the canonical live object
  id. An omitted optional target reference or changed display label cannot split
  one unit into duplicate procedure scopes. Command validation still rejects a
  contradictory target reference. Backend, projection and UI now share this rule.

### Production verification, 2026-09-02

Deployed application commit `ec2a5e4a` in immutable release
`20260902T163844Z-ec2a5e4ac8-eed997f51e` after the full deployment gate passed.
All three services, Caddy, local health endpoints, OSRM and public HTTPS passed.
An isolated temporary four-unit Simulation Run verified:

- An external API operator's step-12 assessment arrived live in the browser.
- Switching away and back returned to step 12 with the shared checkmark.
- The Run and both units' procedure state survived the deployment restart.
- Deleting a unit closed its procedure window and removed it from the rail and
  other units' procedure summaries.
- Starting the same procedure with the optional target reference omitted was
  correctly rejected as a duplicate.
- No browser console errors were reported for the final production test.

The temporary production test Run was removed after closing its viewer; existing
user Runs and scenarios were not altered. The remaining code-quality follow-up
from this pass is broader Svelte typing debt/check integration, described above.

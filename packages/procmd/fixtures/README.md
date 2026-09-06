# Frozen conformance inputs

`pwr-ops/*.md` is the complete 39-procedure corpus from local checkout
`samsinn-wikis/pwr-ops` at `e8e045f9c31f47e4c5ba0ad7f6acdfb64271c44a`.
Original source: https://github.com/samsinn-wikis/pwr-ops/tree/e8e045f9c31f47e4c5ba0ad7f6acdfb64271c44a/wiki/procedures

Fixtures add a final newline where the original file omitted it; other source
content is unchanged. This normalization has no branch-index semantics.

`pwr-ops-baseline.json` records IDs, ordered branch labels/kinds/targets and
tag bindings produced by World's parser at Leitbild `a07e4cc8`, before its
replacement. Branch position is a persisted command input, not display order.
The fixtures are test-only, never a runtime source or a claim of plant validity.
Tests require neither network access nor an external checkout.

`conformance.md` is synthetic and covers observed procmd constructs plus literal
examples and unsupported syntax. It intentionally has diagnostics.

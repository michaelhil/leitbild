# ADR 0005: No Mock Or Dummy Production Functionality

## Decision

Production code must not contain mock, dummy, placeholder, fake, or stubbed behavior.

## Rationale

Short-term fake functionality creates misleading integration surfaces and expensive later rewrites. Leitbild should either ship real, deliberately minimal behavior or not expose the capability.

## Consequences

- Test doubles are allowed only in test files.
- Unsupported capabilities must fail explicitly or remain absent from the product surface.
- Thin vertical slices must be real end-to-end behavior.

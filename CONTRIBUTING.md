# Contributing

Contributions should preserve the documented compatibility boundary and its security invariants. Add tests for the normal path, refusal path, and durable or safety invariant of each changed feature.

Before proposing a change, run the package tests, type-check, build, and extraction verification. Do not include credentials, private repository references, production payloads, or generated local state.

Changes to persistence semantics, error codes, authorization, or public exports require an updated compatibility statement and an explicit design decision.

# Public implementation plan

## Goal

Provide a narrowly scoped Convex-native implementation of selected public Agent-Native contracts without SQL emulation or a second persistent database in the example.

## Accepted slices

1. Define semantic action, scope, error, and persistence contracts with normal, refusal, and durable-invariant tests.
2. Provide real Convex and Drizzle adapters behind the same conformance suite.
3. Add browser, CLI, MCP, and A2A adapters that authorize before execution and preserve stable error envelopes.
4. Demonstrate host-derived scope, idempotent writes, reactive reads, threads, messages, and streaming in one Convex example.
5. Maintain public documentation, license attribution, exact package contents, deterministic clean-root extraction, an SPDX software bill of materials, and independent verification.

## Release boundary

The package remains pre-release until its build, type checks, unit and conformance tests, package-content inspection, provenance verification, license inventory, and public continuous-integration checks pass. Repository creation, remote push, and package publication are separate human-approved actions.

## Safety invariants

Caller input never selects authorization scope. Consequential actions require policy and approval, idempotent replays do not repeat completed writes, terminal tasks cannot regress, audit projections are bounded and secret-free, and extraction cannot inherit private Git history.

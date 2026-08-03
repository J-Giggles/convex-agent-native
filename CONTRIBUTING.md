# Contributing

Thanks for helping make Convex applications easier to use from agents. Bug reports, documentation fixes, compatibility findings, design questions, and focused pull requests are all welcome.

## Before opening code

For usage and design questions, start a [GitHub Discussion](https://github.com/J-Giggles/convex-agent-native/discussions). For a reproducible defect or a bounded feature request, use the matching issue form. Security reports belong in a private advisory, not a public issue.

Small fixes can go directly to a pull request. For a new public API, persistence behavior, protocol surface, or security-policy change, open a proposal first so maintainers and contributors can agree on the compatibility boundary before implementation.

## Local setup

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:guardrails
pnpm build
```

Run `pnpm release:verify` for package or export changes. Run `pnpm test:convex-consumer` for component installation changes; it packs the project and mounts that tarball in a fresh anonymous local Convex app.

## What a helpful change includes

- A focused explanation of the user problem and chosen boundary.
- Tests for the normal path, refusal path, and durable or safety invariant.
- Documentation for user-facing or compatibility changes.
- No credentials, private repository references, production payloads, or generated local state.
- Attribution for ideas or source material adapted from another project.

Changes to persistence semantics, error codes, authorization, approval, idempotency, or public exports require an update to `docs/compatibility.md` and, when architectural, a decision record under `docs/decisions/`.

## Review and conduct

Pull requests are reviewed on a best-effort basis. Maintainers may ask for a smaller scope, stronger refusal tests, or a design discussion before accepting a change. Feedback should be specific, kind, and directed at the work. All participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

By contributing, you agree that your contribution is licensed under the project's MIT License and that you have the right to submit it.

# Security policy

## Supported versions

Security fixes are provided for the latest npm release. Older releases may be asked to upgrade before a fix is evaluated. This is a pre-1.0 community project and carries no production service-level commitment.

## Reporting a vulnerability

Open a [private GitHub security advisory](https://github.com/J-Giggles/convex-agent-native/security/advisories/new). Do not report a suspected vulnerability in a public issue or Discussion.

Include the affected version, impact, reproduction, and suggested mitigation when known. Do not include live credentials, personal data, raw messages, financial identifiers, model prompts containing private data, or production payloads. Use synthetic examples and revoke any credential that may have been exposed.

Reports are acknowledged and triaged on a best-effort basis. The maintainer will coordinate disclosure after a fix or mitigation is available and credit reporters who want public recognition.

## Security boundary

The package treats authorization, host-derived scope, approval checks, idempotency, audit projection, and explicit public exposure as fail-closed boundaries. Installing the component does not make Convex functions agent-callable automatically. Hosts remain responsible for deployment authentication, transport security, rate and cost limits, action allowlists, and safe result projection.

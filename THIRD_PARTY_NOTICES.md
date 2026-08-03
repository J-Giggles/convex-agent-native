# Third-party notices

The package directly depends on, or declares a peer relationship with, the following projects. Their own distributions remain subject to their respective license texts.

| Project                 | License    |
| ----------------------- | ---------- |
| `@agent-native/core`    | MIT        |
| `@convex-dev/agent`     | Apache-2.0 |
| `@standard-schema/spec` | MIT        |
| `convex`                | Apache-2.0 |
| `drizzle-orm`           | Apache-2.0 |
| `react`                 | MIT        |
| `zod`                   | MIT        |

The optional `@agent-native/core` compatibility closure may install Sharp's platform-specific, unmodified libvips shared library under LGPL-3.0-or-later. It is dynamically loaded by upstream image tooling and is not bundled into this package.

[Agent-Native](https://agent-native.com/) is created and maintained by [Builder.io](https://www.builder.io/); its official source is [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native). Those names are used descriptively for compatibility, and no upstream logo, trade dress, endorsement, sponsorship, affiliation, or trademark license is claimed.

The public demo is independently inspired by Steve Sewell and Builder.io's [How (and why) to build agent-first apps](https://www.builder.io/blog/agent-first-apps). Upstream source inspection for the port was pinned to the MIT-licensed repository commit `0b77b79d675ef18fad8279ed1921b48ed7c25358`.

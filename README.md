# agent-native-convex

`agent-native-convex` is an independent, Convex-native implementation of selected public Agent-Native contracts. It uses semantic persistence ports and native Convex transactions rather than translating SQL.

The compatibility boundary is intentionally narrow: action execution, scoped invocation persistence, browser and CLI clients, MCP and A2A adapters, and the documented example. See [the compatibility statement](docs/compatibility.md) for supported and excluded surfaces.

[Agent-Native](https://agent-native.com/) is created and maintained by [Builder.io](https://www.builder.io/), with official source at [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native). This independent interoperability project is not affiliated with, endorsed by, or sponsored by Builder.io or the Agent-Native project; compatibility names are used only to describe public contracts.

## Development

Use Node.js 22.22 or newer and pnpm. Install dependencies, run the package tests, type-check, and build before creating a package tarball. The example is designed to use Convex as its only persistent database.

Never commit deployment credentials. Configuration belongs in the host environment, and action inputs must not be used to select authorization scope.

## License

The project is distributed under the MIT License. Direct runtime dependency licenses and attribution are recorded in `THIRD_PARTY_NOTICES.md`.

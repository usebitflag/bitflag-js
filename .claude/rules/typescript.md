# TypeScript Rules

## Code style

- Strict TypeScript (`strict: true`); no `any` without a comment explaining why. Two spaces for indentation.
- ESLint and Prettier. ES modules only.
- Export a small public API. Keep helpers module-private.

## Dependencies

- `package.json` has no `dependencies`. Dev tooling (TypeScript, Vitest, ESLint) goes in `devDependencies`.
- An architecture check fails if `src/evaluation` imports anything outside the package.
- Adding a runtime dependency needs an explicit decision recorded in the `bitflag` decision register.

## Testing

- Vitest. Fixtures come from a pinned `bitflag-protocol` release; verify its checksum, never read a floating `main`.
- CI runs the supported Node versions.
- Add a fixture to `bitflag-protocol` first when behavior changes, then make this repository pass it.
- The cross-language job runs every fixture through both evaluators; any difference is a bug in one of them.

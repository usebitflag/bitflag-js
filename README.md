# bitflag-js

The independently written TypeScript evaluation core (`src/evaluation`, `src/protocol`), later the Node and browser client. No runtime dependencies.

Part of BitFlag. Technical documentation lives in [usebitflag/bitflag](https://github.com/usebitflag/bitflag/tree/main/docs).

## Development

Requires Node 22.

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

## Conformance

The evaluator is tested against the fixtures of a pinned `bitflag-protocol` release (`protocol.lock.json`).

```bash
scripts/fetch-protocol-fixtures.sh   # downloads, verifies the checksum and extracts to build/protocol/<version>
scripts/pin-protocol.sh <version>   # pins a published release in protocol.lock.json
npm test                             # unit, architecture and conformance tests in Node
npm run test:browser                 # the conformance suite in Chromium (npx playwright install chromium once)
npm run conformance                  # writes conformance-report.json: what this evaluator did for every case
npx stryker run                      # mutation testing of src/evaluation and src/protocol (minimum score 85%)
```

Set `BITFLAG_PROTOCOL_DIR` to an extracted release to use it instead of `build/protocol/<version>`. The report can be
compared with another evaluator's using `tools/compare-reports.mjs` in `bitflag-protocol`.

## Adopting a protocol release

The evaluator never reads the protocol repository's `main`; it pins a published release in `protocol.lock.json` (version, asset and SHA-256). When a new protocol release is published:

1. `GH_TOKEN=… scripts/pin-protocol.sh <version>` writes the version, asset name and checksum of that release into the lock file. The version is the release without the `v`, for example `0.1.0-alpha.2`.
2. `GH_TOKEN=… scripts/fetch-protocol-fixtures.sh` downloads and verifies it.
3. Run the tests (`npm test`; `npm run test:browser` runs the conformance suite in a browser). New fixtures that fail point at behavior to implement or fix; add the fix in the same pull request.
4. Open a pull request with the lock change and the fixes.

Nothing else records the protocol version. Until the evaluator has adopted a release, it keeps passing the release it pins; the protocol repository's `cross-language` workflow is what compares both evaluators on a newer one.

### Access in CI

The repository is private, so CI downloads the release with the `PROTOCOL_READ_TOKEN` Actions secret: a fine-grained personal access token with read-only Contents access to `usebitflag/bitflag-protocol`. Tokens expire. When the fetch step fails with `release not found` although the release exists, the token is missing, expired or lacks access; replace the secret.

## Releasing

Nothing installs this package yet (it is private and unpublished), so it has no tags. Tag `main` as `vX.Y.Z-pre` when a consumer needs a version.

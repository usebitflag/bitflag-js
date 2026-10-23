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

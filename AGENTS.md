# AGENTS.md

This file provides guidance for coding agents working in `bitflag-js`.

## Project Overview

`bitflag-js` is the TypeScript evaluation core and, later, the Node and browser client. It is written independently of
`bitflag-php` from the contract in `bitflag-protocol`; both must pass the same fixtures with identical results.

Design context lives in the `bitflag` repository (`docs/evaluation-and-sdk-protocol.md`).

## Project Structure

```
bitflag-js/
├── src/
│   ├── evaluation/   # evaluation order, operators, bucketing, typed results
│   ├── protocol/     # snapshot parsing and validation
│   └── client/ browser/ node/ telemetry/   # added later (M13)
├── tests/            # Vitest
├── package.json      # no runtime dependencies
└── tsconfig.json     # strict
```

## Core Rules

- No runtime dependencies. `src/evaluation` and `src/protocol` import nothing outside the package.
- Browser exports must not pull in Node-only modules or anything that could carry server secrets.
- 64-bit bucketing arithmetic uses `BigInt`.
- Results are typed. A caller-visible failure is a result with a reason, not a thrown error, unless the spec says otherwise.
- Every change goes through a pull request. See `.claude/rules/git-workflow.md`.

Detailed rules: `.claude/rules/typescript.md` and `.claude/rules/git-workflow.md`.

## Commands

Available once the skeleton lands:

- `npm ci`
- `npx tsc --noEmit`
- `npx eslint .`
- `npx vitest run`

# Working in bitflag-js

## Pull requests are mandatory

- Never commit or push directly to `main`, not even for a one-line fix or a docs edit. Create a branch (`feat/…`, `fix/…`, `chore/…`, `docs/…`), push it, and open a pull request against `main`.
- One logical change per pull request. Fill in the PR template, including the "Contracts touched" checklist.
- Wait for the checks to pass before merging. Merge with **squash** so history stays linear, then delete the branch.
- Run `git config core.hooksPath .githooks` once per clone. The `pre-push` hook blocks pushes to `main`.
- GitHub cannot enforce this yet (branch protection needs a paid plan for private repositories). The `main-guard` workflow fails when a commit reaches `main` without a pull request, so treat a red `main-guard` as a mistake to fix.

## Commit identity

Commits use the GitHub noreply address set in this clone's local git config. Do not replace it with a work email.

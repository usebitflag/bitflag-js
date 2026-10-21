# Git Workflow

## Pull requests are mandatory

- Never commit or push directly to `main`, not even for a one-line fix or a docs edit. Create a branch (`feat/…`, `fix/…`, `chore/…`, `docs/…`), push it, and open a pull request against `main`.
- One logical change per pull request. Fill in the PR template, including the "Contracts touched" checklist.
- Wait for the checks to pass before merging. Merge with **squash** so history stays linear; the branch is deleted on merge.
- Run `git config core.hooksPath .githooks` once per clone. The `pre-push` hook blocks pushes to `main`.
- Branch protection is not available yet (the organization is on the GitHub Free plan), so nothing on GitHub blocks a direct push. The `main-guard` workflow fails when a commit reaches `main` without a pull request; treat a red `main-guard` as a mistake to fix.

## Commits

- Commits use the GitHub noreply address set in this clone's local git config. Do not replace it with a work email.
- Write the subject in the imperative, under 72 characters. Explain why in the body when it is not obvious.
- Never commit secrets, `.env` files or keys. Gitleaks scans every pull request.

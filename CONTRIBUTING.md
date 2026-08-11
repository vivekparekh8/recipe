# Contributing to Recipe

Recipe welcomes focused bug fixes, portability improvements, agent fixtures, and replay corpus additions.

## Start here

1. Use Node.js 22 or newer and Git.
2. Fork and clone the repository.
3. Run `npm install --ignore-scripts`.
4. Run `npm test` before and after your change.
5. Keep changes narrow and add a regression test for behavior changes.

## Design constraints

- Preserve deterministic playback as the v1 trust anchor; do not replace it with model regeneration.
- Capture user-visible provenance only. Never add hidden chain-of-thought collection.
- Keep raw transcripts local by default and public artifacts normalized and redacted.
- Treat human edits as first-class provenance rather than labeling mixed work as pure AI.
- Keep adapters thin and put storage, redaction, attribution, publishing, and replay in the shared core.
- Preserve existing Git hooks and repository configuration byte-for-byte outside Recipe's managed block.

## Pull requests

Explain the problem, the user-visible behavior, and how you verified it. Include focused tests and note any operating systems you could not exercise. Avoid unrelated formatting, generated files, and dependency changes.

For larger schema or trust-model changes, open an issue first so compatibility and privacy consequences can be discussed before implementation.

By contributing, you agree that your work is licensed under the repository's MIT License.

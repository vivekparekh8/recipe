# Emotion #3386 Recipe demo

This is a local, PR-ready fix for [emotion-js/emotion](https://github.com/emotion-js/emotion) issue [#3386: `@emotion/babel-plugin` incompatible with Babel 8](https://github.com/emotion-js/emotion/issues/3386). The issue was confirmed open on 2026-07-15, and a public GitHub PR search found no PR referencing #3386.

- Base: `b882bcba85132554992e4bd49e94c95939bbf810`
- Target: `2a88c454952318b8efd3e8e95e0e8117f30fc0e4`
- Branch: `recipe-demo/3386-babel-8-path-hoist`
- Recipe: `5dc918c1-335a-4309-a761-520671f99545`
- Upstream license: [MIT](https://github.com/emotion-js/emotion/blob/main/LICENSE)

## Problem and fix

Babel 8 removed `NodePath#hoist`, so Emotion's Babel plugin crashed while extracting function-local static styles. The patch replaces that removed call with explicit program-scope variable insertion, preserves direct replacement for already top-level styles, adds a regression test that disables `NodePath#hoist`, and adds a patch changeset.

## Reproduce and verify

The standalone Babel 8 reproduction and failure are recorded in `before.txt`. From the restored repository branch, run:

```sh
yarn test packages/babel-plugin/__tests__/babel-8-compat.js --runInBand --no-watchman
yarn test packages/babel-plugin --runInBand --no-watchman
yarn eslint packages/babel-plugin/src/core-macro.js packages/babel-plugin/__tests__/babel-8-compat.js
git diff --check HEAD^ HEAD
node <RECIPE_SOURCE>/src/cli.js inspect HEAD --timeline
node <RECIPE_SOURCE>/src/cli.js replay HEAD
node <RECIPE_SOURCE>/src/cli.js verify HEAD --replay --json
```

Results: the regression test passes 1/1; the complete Babel-plugin suite passes 17 suites, 217 tests, and 215 snapshots; changed-file ESLint and `git diff --check` pass. Recipe replay is `exact`, and verification reports `ok: true` with zero failures.

## Restore from bundle

```sh
git clone demo.git.bundle emotion-3386
cd emotion-3386
git switch recipe-demo/3386-babel-8-path-hoist
git fetch ../demo.git.bundle refs/notes/recipe:refs/notes/recipe
mkdir -p .git/recipes
cp ../recipe.json.zst .git/recipes/2a88c454952318b8efd3e8e95e0e8117f30fc0e4.json.zst
git log -1 --oneline
node <RECIPE_SOURCE>/src/cli.js inspect HEAD --timeline
node <RECIPE_SOURCE>/src/cli.js replay HEAD
node <RECIPE_SOURCE>/src/cli.js publish HEAD --output .git/recipe-publish
node <RECIPE_SOURCE>/src/cli.js verify HEAD --replay --json
```

The bundle contains complete history, the demo branch, and the Recipe note. The normalized Recipe artifact is copied into the clone's local storage before inspect/replay. `publish --output .git/recipe-publish` regenerates the local-only files referenced by the note before full verification. Install dependencies according to Emotion's `CONTRIBUTING.md` before running tests. `commit.patch` can alternatively be applied to the recorded base SHA.

## Limitations

- Babel 8.0.1 declares Node `^22.18.0 || >=24.11.0`; the standalone reproduction ran on Node 22.17.0 with an engine warning but reached and demonstrated the reported plugin crash.
- The local monorepo dependency installation did not complete its unrelated legacy native postinstall phase, so the optional Preconstruct package build was unavailable. The complete affected-package test suite and changed-file lint passed.
- Recipe captured Codex as one child command, so deterministic replay verifies the exact patch but reports `tests: 0/0`; authoritative test output is preserved separately in `after.txt`.
- The five verification warnings are expected for a local-only demo: hosted artifact, release, summary, and manifest URLs were intentionally not published.

No upstream PR was opened. No issue comment, push, or other upstream mutation was performed.

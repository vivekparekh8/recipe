# Material UI #41067 Recipe demo

This local, PR-ready demo fixes persistent `SpeedDialAction` tooltips overlapping action buttons when a `SpeedDial` expands horizontally.

## Source

- Repository: https://github.com/mui/material-ui
- Issue: https://github.com/mui/material-ui/issues/41067
- Base: `307ccfd4fac5a9d1c8a98e470ff3e23b6b403c4d`
- Target: `ae3853d5c903aaf19a7699fcdbe136e9bd838fb2`
- Branch: `recipe-demo/41067-speed-dial-tooltip-placement`
- Recipe ID: `81c6f151-9e19-4867-b3a9-55ca5de6f011`

The issue was verified open through GitHub's public API on 2026-07-15. Four linked implementation PRs were closed without merge, and no active competing PR was found. No upstream PR was opened.

## Fix

Vertical SpeedDials retain the existing `left` tooltip default. Horizontal SpeedDials now default to `bottom`, and the static tooltip renderer implements real `top` and `bottom` positioning, spacing, transform origins, and public utility classes. Regression tests cover all four directions, explicit placement overrides, and both new static placements.

## Reproduce

Before the patch, the public-safe contract probe failed because horizontal static placements were not implemented. The existing jsdom suite still passed because it asserted the old overlapping default.

```bash
node repro-material-ui-41067.mjs
pnpm test:node SpeedDial --run
```

The probe is documented in `before.txt`; it is not part of the upstream patch.

## Verify

Use Node `>=22.22.3` and pnpm `11.11.0`, as required by the source repository.

```bash
pnpm test:node SpeedDial --run
./node_modules/.bin/prettier --check packages/mui-material/src/SpeedDial/SpeedDial.js packages/mui-material/src/SpeedDial/SpeedDial.test.js packages/mui-material/src/SpeedDialAction/SpeedDialAction.js packages/mui-material/src/SpeedDialAction/SpeedDialAction.test.js packages/mui-material/src/SpeedDialAction/speedDialActionClasses.ts
./node_modules/.bin/eslint packages/mui-material/src/SpeedDial/SpeedDial.js packages/mui-material/src/SpeedDial/SpeedDial.test.js packages/mui-material/src/SpeedDialAction/SpeedDialAction.js packages/mui-material/src/SpeedDialAction/SpeedDialAction.test.js packages/mui-material/src/SpeedDialAction/speedDialActionClasses.ts
./node_modules/.bin/tsc -p packages/mui-material/tsconfig.json --noEmit
```

Results: 113 tests passed and 20 environment-specific tests were skipped. Formatting and file-scoped ESLint passed. The TypeScript command passed inside the captured Codex run; an independent rerun later exhausted the coordinator's 2 GB Node heap, as recorded under limitations.

## Recipe

```bash
node "$RECIPE_SOURCE/src/cli.js" inspect HEAD --timeline
node "$RECIPE_SOURCE/src/cli.js" replay HEAD
node "$RECIPE_SOURCE/src/cli.js" verify HEAD --replay --json
```

Replay applied 1/1 agent checkpoint and matched the target exactly. Verification returned `ok: true`, `failureCount: 0`, and replay status `exact`. The five warnings are expected because this local-only demo has no release or upstream artifact URLs.

## Restore Bundle

The bundle is intentionally thin and requires the public base commit.

```bash
git clone https://github.com/mui/material-ui.git material-ui-41067
cd material-ui-41067
git fetch /path/to/demo.git.bundle recipe-demo/41067-speed-dial-tooltip-placement:refs/heads/recipe-demo/41067-speed-dial-tooltip-placement
git fetch /path/to/demo.git.bundle refs/notes/recipe:refs/notes/recipe
git switch recipe-demo/41067-speed-dial-tooltip-placement
```

Place `recipe.json.zst` at `.git/recipes/ae3853d5c903aaf19a7699fcdbe136e9bd838fb2.json.zst` before running Recipe commands from the restored clone.

Then regenerate local publish files and verify:

```bash
node "$RECIPE_SOURCE/src/cli.js" inspect HEAD --timeline
node "$RECIPE_SOURCE/src/cli.js" replay HEAD
node "$RECIPE_SOURCE/src/cli.js" publish HEAD --output .git/recipe-publish
node "$RECIPE_SOURCE/src/cli.js" verify HEAD --replay --json
```

## Limitations

- No browser screenshot or visual-regression run was captured; the regression is covered through deterministic CSS and placement assertions.
- Recipe recorded the agent command and resulting checkpoint, but its normalized bundle contains no separately recorded test events (`0/0`). Authoritative test output is preserved in `after.txt`.
- An independent full Material package typecheck exhausted a 2 GB Node heap after the captured run had already completed the same command successfully.
- The repository was shallow-cloned at the recorded base, so the bundle relies on that public base commit.

Material UI source and the patch remain under the repository's MIT license and attribution. No upstream PR was opened.

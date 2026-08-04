# shadcn-ui Recipe Demo: Issue #10543

This local, PR-ready demo fixes [shadcn-ui/ui issue #10543](https://github.com/shadcn-ui/ui/issues/10543), which remained open when rechecked through GitHub's public API on 2026-07-15. A public search found no open PR referencing `10543`.

- Repository: https://github.com/shadcn-ui/ui
- Base: `bc0705384b51252af26dcc65425b216bf5eb063c`
- Target: `50fd7bf22fcce9c9843a8f940d7a59f3d7b36732`
- Branch: `recipe-demo/10543-align-base-select-popup`
- Recipe: `e3c22a53-36a6-4ba4-b7ae-c9eb3f26a569`
- Provenance: `pure_ai`

## Problem and fix

Base UI aligns selected-item text with the trigger value, but the Select popup remained exactly the anchor width. Horizontal item inset could therefore leave the popup edge short. The fix adds an inset-compensated minimum width only while Base UI reports active item alignment through `data-side="none"`. Disabled alignment and side-position fallbacks keep the original width. Radix styles are unchanged.

## Reproduce and verify

From the restored repository, the pre-fix source check in `commands.txt` exits 1 at the base commit. At the target commit run:

```bash
./node_modules/.bin/vitest run apps/v4/registry/select.test.ts
cd apps/v4 && ./node_modules/.bin/tsc --noEmit
node <RECIPE_SOURCE>/src/cli.js inspect HEAD --timeline
node <RECIPE_SOURCE>/src/cli.js replay HEAD
node <RECIPE_SOURCE>/src/cli.js verify HEAD --replay --json
```

The focused test passed 2/2, all eight Base registry targets built successfully, TypeScript/ESLint/Prettier passed, replay was exact, and Recipe verification returned `ok: true` with zero failures.

The first Codex child invocation used an invalid option order and exited 2 without edits. Recipe preserved the session, and the corrected command resumed it successfully. Both normalized events are retained in `inspect.txt`; `commands.txt` records both invocations.

## Restore from bundle

The compact bundle records the target commit with the upstream base as a prerequisite:

```bash
git clone https://github.com/shadcn-ui/ui.git shadcn-ui-10543
cd shadcn-ui-10543
git fetch ../demo.git.bundle recipe-demo/10543-align-base-select-popup:recipe-demo/10543-align-base-select-popup
git switch recipe-demo/10543-align-base-select-popup
git config user.name "Recipe Demo Reviewer"
git config user.email "recipe-review@example.invalid"
git notes --ref refs/notes/recipe add -F ../recipe-note.txt HEAD
mkdir -p .git/recipes
cp ../recipe.json.zst .git/recipes/50fd7bf22fcce9c9843a8f940d7a59f3d7b36732.json.zst
git log -1 --oneline
node <RECIPE_SOURCE>/src/cli.js inspect HEAD --timeline
node <RECIPE_SOURCE>/src/cli.js replay HEAD
node <RECIPE_SOURCE>/src/cli.js publish HEAD --output .git/recipe-publish
node <RECIPE_SOURCE>/src/cli.js verify HEAD --replay --json
```

The compact Git bundle does not contain the notes ref, so the commands above restore the exact note from the separately included public-safe `recipe-note.txt`. Use `commit.patch` when applying the change to an existing clone. The patch author is intentionally anonymized in this public-safe package; the target commit identity remains recorded by SHA.

## Limitations

This is a source-level and generated-artifact regression demo, not a browser screenshot test. The repository pins Node `v20.5.1`; execution used Node `v22.17.0`. A combined all-style build exhausted temporary disk space, so the eight relevant Base targets were rebuilt sequentially and all passed. Recipe recorded the final edit checkpoint but not Codex's nested test commands (`0/0` replayed tests); their outputs are preserved in `after.txt` and the regression can be rerun with `commands.txt`.

No upstream PR was opened. No push, comment, or write interaction occurred. shadcn-ui remains under its upstream license; this package preserves commit attribution and contains only review/replay artifacts.

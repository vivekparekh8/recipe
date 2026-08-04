## Summary

- replace Babel 7's removed `NodePath#hoist` usage with explicit program-scope insertion
- preserve function-local static style extraction and stable object identity
- add a Babel 8 compatibility regression test and patch changeset

Fixes #3386.

## Tests

- `yarn test packages/babel-plugin/__tests__/babel-8-compat.js --runInBand --no-watchman`
- `yarn test packages/babel-plugin --runInBand --no-watchman`
- `yarn eslint packages/babel-plugin/src/core-macro.js packages/babel-plugin/__tests__/babel-8-compat.js`
- `git diff --check HEAD^ HEAD`

This body is prepared for local review only. No upstream PR was opened.

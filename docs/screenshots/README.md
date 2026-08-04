# Product screenshots

These screenshots are generated from real CLI output against a fresh temporary Git repository.
Dynamic temporary paths and hashes are shortened for legibility.
The SVG files are the canonical, shareable screenshots. Local PNG raster previews are ignored.

Regenerate them with:

```bash
node scripts/generate-screenshots.js
```

- `01-inspect-timeline.svg`: prompt-to-action-to-checkpoint-to-test timeline
- `02-line-attribution.svg`: final line lookup with checkpoint, action, and prompt
- `03-verify-replay.svg`: bundle, attachment, replay, and test verification
- `04-publish.svg`: generated reviewer artifacts and git-note attachment
- `05-replay.svg`: exact deterministic replay summary

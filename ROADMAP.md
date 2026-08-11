# Roadmap

Recipe is an early preview. Priorities are ordered by trust and adoption value rather than by feature count.

## Now: dependable adoption

- Keep macOS, Linux, and Windows installation and replay green.
- Publish a scoped npm package with provenance and a minimal release process.
- Grow the real-world replay corpus and record normalized test events in every demo.
- Stabilize the CLI and schema toward a documented compatibility policy.

## Next: portable trust

- Sign bundles and express Recipe metadata as in-toto-compatible attestations.
- Capture optional environment manifests for stronger dependency-drift diagnosis.
- Add an experimental Agent Client Protocol importer instead of multiplying bespoke adapters.
- Provide a reusable GitHub Actions verification workflow for external projects.

## Later: broader replay

- Diagnose and selectively port recipes onto newer branches without weakening exact-base replay.
- Explore Jujutsu change identity and operation history beyond Git commits.
- Export privacy-safe OpenTelemetry GenAI spans while keeping `recipe.json` authoritative.

Hosted transcript search, mandatory cloud accounts, hidden chain-of-thought capture, and generic IDE features are not roadmap goals.

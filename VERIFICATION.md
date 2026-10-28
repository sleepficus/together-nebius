# Verification

Run `npm ci`, `npm run typecheck`, `npm run build` and `npm test` from a clean source copy. Installation prepares the actual stdio MCP adapter. The first-use path in README uses real local MCP/API records and requires no model-provider key.

The local suite labels deterministic provider fixtures as offline. They do not establish live model success. Two optional hosted-OAuth test files are explicitly excluded by the local runner. The actual Docker-dependent check requires an explicit opt-in on the approved Linux host and is skipped on the Mac. All ordinary offline receipt/auth/review regression tests remain in the suite.

## This release check — 2026-10-28

Fresh source checkout on macOS, Node24.19.0 and Git: npm ci installed225 packages in5seconds and prepared the stdio MCP adapter. Typecheck and Vite build passed; Vite retained its large-chunk advisory (largest JavaScript chunk about668kB uncompressed). The focused onboarding, CLI and private-state placement suites passed15/15 with no skips or failures. The broader existing suite was not rerun for this documentation/metadata release.

The real npm-start entry chose free loopback ports. The documented setup and MCP CLI connected an external identity, posted a Team message, created/claimed one task and reused the same identity/session on a second setup. The actual browser showed that message in Team and the same task assigned to that identity on Work map. No native Claude/Codex registration was installed, no model was launched and no provider was called. The source implementation and frozen exercise remain byte-identical to the reviewed rc3 baseline; public documentation, metadata and manifest are the changes.

Earlier independent fresh-user checks of that baseline covered the edit/candidate/fixed-check/review flow and restart persistence. Those observations are baseline evidence, not new tests of this release. Their private transcripts, machine paths, configurations and workspaces are excluded. Runtime/provider availability and billing were not retested here. Linux/Windows installs and a hosted deployment are not claimed verified.

The optional model allowance is12 requests/$0.05 in conservative reservations per saved workspace, including unknown outcomes. It is not a billing verification. Builder receipts stay outside the public source tree; failure records are retained there rather than presented as passing tests.

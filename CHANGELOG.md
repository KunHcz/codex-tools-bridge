# Changelog

## 0.1.0 — 2026-09-14 (experimental)

Initial standalone source release of the web-orchestrated local tool bridge.

- Extract the active web-session implementation and required gateway/protocol code from the local upstream-derived checkout.
- Exclude browser-driven conversation orchestration, launcher, global conversation cache, deployment state, and private logs.
- Add an independent CLI, read-only doctor, explicit fresh Desktop setup, setup/argument tests, bilingual README, architecture and safety documentation.
- Retain upstream MIT notices and extraction provenance; add a locked minimal runtime dependency set and CI configuration.

Known limits: first Desktop seed still needs a manual start, native compatibility varies by build, passive discovery in standalone mode lacks a Desktop seed, and clean-machine end-to-end acceptance is separate from automated tests. Publishing does not migrate or restart a live deployment.

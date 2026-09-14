# Contributing

Discuss architectural changes before turning the bridge into another agent framework. ChatGPT Web must remain responsible for conversation context and tool orchestration.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run verify
```

Add focused regression tests for changes to routing, result forwarding, cancellation, permission handling, or lifecycle. Use fake native hosts and temporary directories. Tests must not access real user profiles, start a model, change live tunnel state, or operate a real desktop without explicit opt-in.

Keep changes small. Do not add browser-prompt automation, telemetry, automatic global permission changes, secret-collection setup, or new model dependencies. Avoid broad refactors of inherited protocol code without tests and a concrete benefit.

PR descriptions should say what changed, how it was tested, and which live-host behavior remains unverified. Preserve upstream notices. Public issues must contain sanitized examples, not task/session credentials, local private paths, or screenshots of private content.

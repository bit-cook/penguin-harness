# Unreleased

- [2026-08-15] Web App: the bottom-left account menu can switch accounts, and the login page lists the accounts already signed in on this browser (user ids only) for one-click prefill. ([details](2026-08-15-web-app.md))

- [2026-08-15] Core: a provider rejecting a thinking-mode request because the history doesn't bring its `reasoning_content` back (DeepSeek and OpenAI-compatible relays, 400 `invalid_request_error`) no longer burns the reconnect budget on a deterministic failure and leaves the Session dead — thinking goes off the wire for that model context, the engine's own retry re-issues the identical input, and the configured level returns with the next context. ([details](2026-08-15-core.md))

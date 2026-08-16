# Unreleased
- [2026-08-15] The server, CLI and desktop shell share one well-known port, 7376 (was 7364, and the shell used an ephemeral one): a client finds this user's server by probing a single known address, at the cost of one server per user per machine by default. ([details](2026-08-15-server-port.md))

- [2026-08-15] Switching accounts without signing out: the account menu switches between accounts already signed in on this browser with no password (their sessions are parked server-side in an HttpOnly jar), and the login page prefills the ones that are only remembered. ([details](2026-08-15-web-app.md))

- [2026-08-15] Core: a provider rejecting a thinking-mode request because the history doesn't bring its `reasoning_content` back (DeepSeek and OpenAI-compatible relays, 400 `invalid_request_error`) no longer burns the reconnect budget on a deterministic failure and leaves the Session dead — thinking goes off the wire for that model context, the engine's own retry re-issues the identical input, and the configured level returns with the next context. ([details](2026-08-15-core.md))

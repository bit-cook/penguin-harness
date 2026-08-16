# Unreleased

- [2026-08-16] **Machines**: the account menu can point the window at a machine from `~/.ssh/config` — the server probes it, installs or updates this build there automatically, starts its server, opens an SSH tunnel (local port = remote port, remembered per machine) and lands on that server's own login page; agents and workspaces then run on that machine. The capability is platform code behind `/api/machines` (hot-pushable); the shell only permits navigating between loopback origins. Supersedes the desktop "Install Server on Remote Host" menu. ([details](2026-08-16-machines.md))

- [2026-08-15] The desktop build also stages an install image (`stage/payload/penguin/{bin,lib,lib/web}`), so a machine with PenguinHarness can install its own build onto one without. ([details](2026-08-15-desktop-payload.md))

- [2026-08-15] Installs put the program in the platform's data directory (`~/.local/share/penguin`, `%LOCALAPPDATA%\penguin`) instead of `~/.penguin`, migrating an existing install on the next run; the data root stays at `~/.penguin/data`. ([details](2026-08-15-install-layout.md))
- [2026-08-15] The server, CLI and desktop shell share one well-known port, 7376 (was 7364, and the shell used an ephemeral one): a client finds this user's server by probing a single known address, at the cost of one server per user per machine by default. ([details](2026-08-15-server-port.md))

- [2026-08-15] Switching accounts without signing out: the account menu switches between accounts already signed in on this browser with no password (their sessions are parked server-side in an HttpOnly jar), and the login page prefills the ones that are only remembered. ([details](2026-08-15-web-app.md))

- [2026-08-15] Core: a provider rejecting a thinking-mode request because the history doesn't bring its `reasoning_content` back (DeepSeek and OpenAI-compatible relays, 400 `invalid_request_error`) no longer burns the reconnect budget on a deterministic failure and leaves the Session dead — thinking goes off the wire for that model context, the engine's own retry re-issues the identical input, and the configured level returns with the next context. ([details](2026-08-15-core.md))

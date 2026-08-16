# The desktop build also produces an install image

`packages/desktop/scripts/stage.mjs` now emits a second, independent tree beside the app directory electron-builder packs: `stage/payload/penguin/{bin,lib,lib/web}` plus a `universal` package manifest — exactly what `install.sh` unpacks. A machine that has PenguinHarness can therefore hand its own build to a machine that has none, which is the first step of installing a server onto an SSH target.

## Shape

- `lib/` is the CLI package's own `pnpm deploy --prod` output, with `lib/dist/penguin.js` as the entry; the web assets sit **inside** it at `lib/web`.
- `bin/penguin` and `bin/penguin.cmd` are generated from `src/launcher.ts` (unit-tested there, like the app's own launchers) and run on plain Node — never on Electron, which the target machine does not have. They prefer a bundled `node/` runtime if the tree ever carries one, and otherwise need system Node >= 24.
- It comes from its own deploy rather than being rearranged out of `stage/app`: that one is the desktop package's tree, an npm-package layout with the CLI nested under `node_modules`.

Installing it is `install.sh --universal --archive <payload.tar.gz>`; verified end to end by installing the staged tree into a throwaway HOME, where it lands in `~/.local/share/penguin`, reports its version, and serves the Web UI from `lib/web` on port 7376.

## Fixed along the way

The AppImage `penguin` wrapper still resolved `dist/index.js`, an entry that no longer exists — b77ddea ("two bins, no router") renamed it to `dist/penguin.js`, and the test covering the wrapper had the old name spelled out, so it pinned the stale path instead of catching it. The wrapper now uses the same constant as the other launchers and the test derives its expectation from it.

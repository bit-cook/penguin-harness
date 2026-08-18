/**
 * The terminal feature's live resource: a spawned shell whose lifetime and output buffer
 * are runtime-owned, so a platform swap never interrupts it (see hmr/resources.ts for the
 * registry, which knows nothing about this or any other kind).
 *
 * Platform-layer on purpose: what a resource IS — how it spawns, what it buffers, what
 * shutting it down means — is this feature's business, and shipping a new kind must not
 * require touching the runtime. Registration hands the registry a disposer so process
 * exit still cleans it up.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Resources } from "@prismshadow/penguin-core/kernel";

/** Output buffer cap per process (chunks are dropped oldest-first past this). */
const MAX_BUFFER_BYTES = 128 * 1024;

export interface ShellProcResource {
  kind: "shell-proc";
  proc: ChildProcess;
  /** Full buffered output (stdout+stderr interleaved), capped. */
  read(): string;
  write(data: string): void;
  alive(): boolean;
  kill(): void;
}

/** Spawns a shell command whose lifetime and output buffer are runtime-owned. */
export function spawnShellResource(
  resources: Resources,
  id: string,
  command: string,
  cwd: string,
): ShellProcResource {
  const proc = spawn(command, { shell: true, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: string[] = [];
  let bufferedBytes = 0;
  let exited = false;
  const push = (data: Buffer): void => {
    const text = data.toString("utf8");
    chunks.push(text);
    bufferedBytes += text.length;
    while (bufferedBytes > MAX_BUFFER_BYTES && chunks.length > 1) {
      bufferedBytes -= chunks[0]!.length;
      chunks.shift();
    }
  };
  proc.stdout?.on("data", push);
  proc.stderr?.on("data", push);
  proc.on("exit", () => {
    exited = true;
  });
  // 'error' (e.g. spawn failure) must not crash the server; surface it in the buffer.
  proc.on("error", (err) => {
    exited = true;
    push(Buffer.from(`[spawn error] ${err.message}\n`));
  });

  const resource: ShellProcResource = {
    kind: "shell-proc",
    proc,
    read: () => chunks.join(""),
    write: (data) => void proc.stdin?.write(data),
    alive: () => !exited,
    kill: () => {
      if (!exited) proc.kill();
    },
  };
  resources.register(id, resource, resource.kill);
  return resource;
}

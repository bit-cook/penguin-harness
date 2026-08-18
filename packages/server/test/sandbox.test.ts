/**
 * Behavior tests for the sandbox service: the built-in interface's optional
 * dimensions, capability routing across backends, fail-closed refusal, and the
 * platform-boot resource handoff.
 */
import { describe, expect, it } from "vitest";
import { boot, initialDoc } from "@prismshadow/penguin-core/kernel";
import type { SpawnConfiner } from "@prismshadow/penguin-core";
import { HotResources, SPAWN_CONFINER_RESOURCE } from "../src/hmr/resources.js";
import { packagedPlatform } from "../src/platform/platform.js";
import { SandboxService } from "../src/sandbox/index.js";
import type { SandboxDimension, SandboxPolicy, SandboxProvider } from "../src/sandbox/index.js";
import { createTestApp } from "./helpers.js";

const ARGV = ["bash", "-lc", "echo hi"] as const;
const OPTS = { cwd: "/work/project/sub", workspaceDir: "/work/project" };

/** A recording backend; `dimensions` absent = an undeclared (filesystem-only) backend. */
function fake(label: string, dimensions?: readonly SandboxDimension[]) {
  const calls: SandboxPolicy[] = [];
  const provider: SandboxProvider = {
    ...(dimensions !== undefined ? { dimensions } : {}),
    confine(argv, policy) {
      calls.push(policy);
      return {
        argv: [label, "--", ...argv],
        enforcement: "full",
        denialSignatures: ["permission denied"],
        runnerFailureRules: [{ fatalSignatures: [`${label}: `] }],
      };
    },
  };
  return { provider, calls };
}

async function service(
  entries: Array<[string, SandboxProvider | PromiseLike<SandboxProvider | null> | null]>,
): Promise<SandboxService> {
  const svc = new SandboxService(entries);
  await svc.whenReady();
  return svc;
}

describe("sandbox service — the built-in interface and its optional dimensions", () => {
  it("default settings are danger-full-access: argv passes through, no backend is consulted", async () => {
    const dsh = fake("dsh");
    const svc = await service([["dsh-local", dsh.provider]]);
    expect(svc.confiner()([...ARGV], OPTS)).toEqual([...ARGV]);
    expect(dsh.calls).toHaveLength(0);
  });

  it("a confining mode with no backend mounted fails closed", async () => {
    const svc = await service([]);
    svc.configure({ mode: "workspace-write" });
    expect(() => svc.confiner()([...ARGV], OPTS)).toThrow(/no sandbox backend is mounted/);
  });

  it("a backend that fails to load is named in the fail-closed message", async () => {
    const svc = await service([
      ["dsh-local", Promise.reject(new Error("Cannot find module 'landlock-run'"))],
    ]);
    svc.configure({ mode: "read-only" });
    expect(() => svc.confiner()([...ARGV], OPTS)).toThrow(
      /failed to load: dsh-local \(Cannot find module 'landlock-run'\)/,
    );
  });

  it("an installation missing a backend package keeps the platform usable, sandbox aside", async () => {
    // The deployed-machine shape (see scripts/deploy.mjs): the load fails, the default
    // settings keep working, and only a confining mode fails.
    const svc = await service([["dsh-local", Promise.reject(new Error("MODULE_NOT_FOUND"))]]);
    expect(svc.confiner()([...ARGV], OPTS)).toEqual([...ARGV]);
    svc.configure({ mode: "workspace-write" });
    expect(() => svc.confiner()([...ARGV], OPTS)).toThrow(/MODULE_NOT_FOUND/);
  });

  it("an undeclared backend is filesystem-only, and a filesystem policy routes to it", async () => {
    const dsh = fake("dsh");
    const svc = await service([["dsh-local", dsh.provider]]);
    svc.configure({ mode: "workspace-write" });
    expect(svc.confiner()([...ARGV], OPTS)).toEqual(["dsh", "--", ...ARGV]);
    // workspaceRoot is the Workspace, never the per-command cwd.
    expect(dsh.calls[0]).toMatchObject({ mode: "workspace-write", workspaceRoot: "/work/project" });
    expect(svc.backends()).toEqual([{ name: "dsh-local", dimensions: ["fs-write"] }]);
  });

  it("requiring a dimension nothing implements is refused, naming what each backend does", async () => {
    const dsh = fake("dsh");
    const svc = await service([["dsh-local", dsh.provider]]);
    svc.configure({ mode: "workspace-write", network: "none" });
    expect(() => svc.confiner()([...ARGV], OPTS)).toThrow(
      /requires fs-write \+ network, but no mounted sandbox backend implements all of it \(dsh-local: fs-write\)/,
    );
    // Never silently dropped: the backend was not consulted at all.
    expect(dsh.calls).toHaveLength(0);
  });
});

describe("sandbox service — capability routing across backends", () => {
  const entries = () => {
    const dsh = fake("dsh");
    const bwrap = fake("bwrap", ["fs-write", "network", "mask-paths"]);
    return { dsh, bwrap };
  };

  it("a filesystem-only policy takes the first backend covering it (the portable one)", async () => {
    const { dsh, bwrap } = entries();
    const svc = await service([
      ["dsh-local", dsh.provider],
      ["penguin-bwrap", bwrap.provider],
    ]);
    svc.configure({ mode: "workspace-write" });
    expect(svc.confiner()([...ARGV], OPTS)).toEqual(["dsh", "--", ...ARGV]);
    expect(bwrap.calls).toHaveLength(0);
  });

  it("a policy requiring network or mask-paths routes past it to the backend implementing them", async () => {
    const { dsh, bwrap } = entries();
    const svc = await service([
      ["dsh-local", dsh.provider],
      ["penguin-bwrap", bwrap.provider],
    ]);
    svc.configure({ mode: "workspace-write", network: "none", maskPaths: ["/home/u/.ssh"] });
    expect(svc.confiner()([...ARGV], OPTS)).toEqual(["bwrap", "--", ...ARGV]);
    expect(dsh.calls).toHaveLength(0);
    expect(bwrap.calls[0]).toMatchObject({ network: "none", maskPaths: ["/home/u/.ssh"] });
  });

  it("an empty maskPaths list does not require the dimension", async () => {
    const { dsh, bwrap } = entries();
    const svc = await service([
      ["dsh-local", dsh.provider],
      ["penguin-bwrap", bwrap.provider],
    ]);
    svc.configure({ mode: "read-only", maskPaths: [] });
    expect(svc.confiner()([...ARGV], OPTS)).toEqual(["dsh", "--", ...ARGV]);
  });

  it("a backend throw (unusable runner, etc.) propagates — fail-closed end to end", async () => {
    const svc = await service([
      [
        "boom",
        {
          confine() {
            throw new Error("penguin-bwrap cannot confine on this host");
          },
        },
      ],
    ]);
    svc.configure({ mode: "workspace-write" });
    expect(() => svc.confiner()([...ARGV], OPTS)).toThrow(/cannot confine on this host/);
  });
});

describe("sandbox settings ride the parked context across a swap", () => {
  it("a confining mode survives park -> fresh boot instead of resetting to unconfined", async () => {
    const resourcesA = new HotResources();
    const instA = await boot(
      packagedPlatform.impl,
      packagedPlatform.iface,
      initialDoc(packagedPlatform.iface, { motd: "m", sandbox: { mode: "read-only" } }),
      resourcesA,
    );
    try {
      const confinerA = resourcesA.claim<SpawnConfiner>(SPAWN_CONFINER_RESOURCE);
      let resultA: readonly string[] | null = null;
      try {
        resultA = confinerA!([...ARGV], OPTS);
      } catch {
        resultA = null;
      }
      expect(resultA).not.toEqual([...ARGV]);

      const parked = (await instA.api.park()) as { motd: string; sandbox?: { mode: string } };
      expect(parked.sandbox).toEqual({ mode: "read-only" });

      const resourcesB = new HotResources();
      const instB = await boot(
        packagedPlatform.impl,
        packagedPlatform.iface,
        initialDoc(packagedPlatform.iface, parked),
        resourcesB,
      );
      try {
        const confinerB = resourcesB.claim<SpawnConfiner>(SPAWN_CONFINER_RESOURCE);
        let resultB: readonly string[] | null = null;
        try {
          resultB = confinerB!([...ARGV], OPTS);
        } catch {
          resultB = null;
        }
        expect(resultB).not.toEqual([...ARGV]);
      } finally {
        instB.dispose();
      }
    } finally {
      instA.dispose();
    }
  });

  it("a document parked before the sandbox field existed restores as the default (off)", async () => {
    const resources = new HotResources();
    const inst = await boot(
      packagedPlatform.impl,
      packagedPlatform.iface,
      initialDoc(packagedPlatform.iface, { motd: "old-doc" }),
      resources,
    );
    try {
      const confiner = resources.claim<SpawnConfiner>(SPAWN_CONFINER_RESOURCE);
      expect(confiner!([...ARGV], OPTS)).toEqual([...ARGV]);
      const parked = (await inst.api.park()) as { motd: string; sandbox?: unknown };
      expect(parked).toEqual({ motd: "old-doc" });
    } finally {
      inst.dispose();
    }
  });
});

describe("sandbox service — platform boot handoff", () => {
  it("booting the platform registers a working spawn confiner as a runtime resource", async () => {
    const t = await createTestApp();
    try {
      await t.deps.hmr.ensure();
      const confiner = t.deps.hmr.resources.claim<SpawnConfiner>(SPAWN_CONFINER_RESOURCE);
      expect(typeof confiner).toBe("function");
      expect(confiner!([...ARGV], OPTS)).toEqual([...ARGV]);
    } finally {
      await t.cleanup();
    }
  });
});

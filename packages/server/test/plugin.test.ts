/**
 * Behavior tests for the minimal harness plugin seam: the two hooks, their ordering,
 * the two views (definition iface / flattened instance context), and re-delivery on a
 * hot-swap boot.
 */
import { describe, expect, it } from "vitest";
import { boot, initialDoc } from "@prismshadow/penguin-core/kernel";
import { HotResources } from "../src/hmr/resources.js";
import { PluginHost } from "../src/platform/plugin.js";
import type { PenguinContext, PenguinInterface } from "../src/platform/plugin.js";
import { pluginHost } from "../src/platform/plugin.js";
import { packagedPlatform } from "../src/platform/platform.js";

describe("plugin host", () => {
  it("delivers onCreateApp with the definition view and events with the instance view, in registration order", () => {
    const host = new PluginHost();
    const log: string[] = [];
    let seenIface: PenguinInterface | null = null;
    let seenCtx: PenguinContext | null = null;
    host.use({
      onCreateApp: (iface) => {
        seenIface = iface;
        log.push("a:create-app");
      },
      subscribe: (eventName, ctx) => {
        seenCtx = ctx;
        log.push(`a:${eventName}`);
      },
    });
    host.use({ subscribe: (eventName) => log.push(`b:${eventName}`) });

    const iface: PenguinInterface = { workflow: new Map(), tool: new Map() };
    host.createApp(iface);
    const ctx = { workflows: {}, terminals: {} } as unknown as PenguinContext;
    host.emit("create", ctx);

    expect(log).toEqual(["a:create-app", "a:create", "b:create"]);
    expect(seenIface).toBe(iface);
    expect(seenIface!.workflow).toBeInstanceOf(Map);
    expect(seenCtx).toBe(ctx);
  });

  it("a hook-less plugin is fine (both hooks optional)", () => {
    const host = new PluginHost();
    host.use({});
    expect(() => {
      host.createApp({ workflow: new Map(), tool: new Map() });
      host.emit("create", {} as PenguinContext);
    }).not.toThrow();
  });
});

describe("plugin seam on the real platform", () => {
  it("every App creation re-delivers both hooks; the context flattens platform members", async () => {
    const events: Array<{ name: string; ctx: PenguinContext }> = [];
    let createApps = 0;
    pluginHost.use({
      onCreateApp: () => createApps++,
      subscribe: (name, ctx) => events.push({ name, ctx }),
    });

    const resources = new HotResources();
    const instA = await boot(
      packagedPlatform.impl,
      packagedPlatform.iface,
      initialDoc(packagedPlatform.iface, { motd: "m" }),
      resources,
    );
    try {
      expect(createApps).toBe(1);
      expect(events.map((e) => e.name)).toEqual(["create"]);
      // context.* flatten: platform members are directly on the context.
      const ctx = events[0]!.ctx;
      expect(typeof ctx.terminals.keys).toBe("function");
      expect(typeof ctx.workflows.keys).toBe("function");
      expect(typeof ctx.createTerminal).toBe("function");

      // The shell primitive: a live, runtime-owned process a plugin can drive.
      const shell = ctx.shell.spawn("echo plugin-shell-ok", { cwd: process.cwd() });
      const until = Date.now() + 5000;
      while (!shell.read().includes("plugin-shell-ok")) {
        if (Date.now() > until) throw new Error(`shell output never arrived: ${shell.read()}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      shell.kill();

      // Reserved floors: tool factories on the definition view, agent invocation on
      // the instance view — placeholders that answer honestly until they land.
      expect(ctx.tools()).toEqual([]);
      await expect(ctx.agents.run("p", "a", "hi")).rejects.toThrow(/not wired yet/);

      // A second boot (what a hot swap does) is a new App instance: re-delivered.
      const instB = await boot(
        packagedPlatform.impl,
        packagedPlatform.iface,
        initialDoc(packagedPlatform.iface, { motd: "m2" }),
        new HotResources(),
      );
      try {
        expect(createApps).toBe(2);
        expect(events).toHaveLength(2);
      } finally {
        instB.dispose();
      }
    } finally {
      instA.dispose();
    }
  });
});

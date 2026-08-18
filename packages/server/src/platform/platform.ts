/**
 * THE platform: the one hot-swappable unit this build of the server packages.
 *
 * The repo carries exactly one platform — versions exist BETWEEN deployments
 * (this packaged build vs the next bundle pushed over HTTP), not as parallel
 * files. When a future build changes the context shape, it bumps `version`
 * and ships the migrator alongside the new schema; the previous shape lives
 * only in already-parked documents out in the world.
 *
 * PLATFORM LAYER — WHERE POLICY BELONGS. Anything a deployment might want to
 * change (business APIs, what an agent sees, how a capability behaves) goes
 * here rather than in the runtime, and reaches installations by one HTTP push
 * instead of a rebuild. Worth remembering when something looks like it must
 * live in the shell: this code runs INSIDE the server process, so in-process
 * effects (e.g. extending process.env for the shells agents spawn) are
 * deliverable from boot() with no runtime change. See ../hmr/README.md.
 *
 * Tree: platform { terminals: keyed(terminal) } — terminals are the
 * live-state proof (their processes are runtime-owned and survive swaps).
 *
 * This is the business platform that lives on feat/workflow-hmr (the
 * mechanism-only feat/hot-update-mvp packages a bare stub instead — see
 * that branch's platform.ts). A new business API does not grow a route in
 * the runtime: the platform serves its own HTTP through the seam in
 * ../hmr/http-seam.ts, which offers it every request before the runtime's
 * own routes see it. /terminals* is still wired in routes.ts as a legacy
 * convenience for this one surface, and is due to move here.
 */
import { resolveRoot } from "@prismshadow/penguin-core";
import type { Impl, Json, KeyedHandle, Park } from "@prismshadow/penguin-core/kernel";
import { defineIface, keyed, schema, type } from "@prismshadow/penguin-core/kernel";
import { ensureCliOnPath } from "./agent-cli-path.js";
import { machinesHttp } from "./machines/http.js";
import { machinesProxy } from "./machines/proxy.js";
import { MachinesService } from "./machines/service.js";
import type { TerminalApi } from "./terminal.js";
import { TerminalIface, terminalImpl } from "./terminal.js";
import { SPAWN_CONFINER_RESOURCE, spawnShellResource } from "../hmr/resources.js";
import type { PenguinInterface } from "./plugin.js";
import { pluginHost } from "./plugin.js";
import { loadConfiguredPlugins } from "../plugins/loader.js";
import type { SandboxProviderSource } from "../sandbox/index.js";
import { SandboxService } from "../sandbox/index.js";

/**
 * Configured plugins, loaded once per process and memoized: a hot swap re-delivers
 * their hooks to the fresh App (that is the host's job) but must not import or
 * re-register them. There are no built-in plugins to register here — which backends
 * exist is the deployment's plugins.json, not this file's import list.
 */
let configuredPlugins: Promise<void> | null = null;
function ensureConfiguredPlugins(root: string): Promise<void> {
  configuredPlugins ??= loadConfiguredPlugins(root).then((result) => {
    for (const { plugin } of result.loaded) pluginHost.use(plugin);
    for (const [specifier, reason] of result.failed) {
      // Non-fatal by design: the capability a plugin would have provided stays
      // unavailable (the sandbox service then fails closed for a confining policy)
      // rather than the whole platform failing to boot.
      console.warn(`[plugins] skipped ${specifier}: ${reason}`);
    }
  });
  return configuredPlugins;
}
import type { WorkflowApi, WorkflowRegistry, WorkflowTool } from "./workflow.js";
import { WorkflowIface, workflowImpl } from "./workflow.js";

export interface PlatformApi extends Park {
  info(): Json;
  createTerminal(command: string, cwd: string): Promise<{ id: string }>;
  terminals(): KeyedHandle<TerminalApi>;
  workflows(): KeyedHandle<WorkflowApi>;
  workflowTools(): Array<{ workflowId: string; name: string; description: string }>;
  reseedWorkflow(id: string, runCtx: import("./workflow.js").WorkflowRunCtx): void;
}

import type { SandboxSettings } from "../sandbox/index.js";

export type PlatformCtx = {
  motd: string;
  /**
   * Active sandbox settings — parked state, not service memory: a hot swap constructs
   * a fresh SandboxService, and without this field the swap would silently reset a
   * confining deployment to unconfined. Optional so documents parked before the field
   * existed restore as the default (confinement off).
   */
  sandbox?: SandboxSettings;
};

export const PlatformIface = defineIface<PlatformApi, PlatformCtx>({
  name: "platform",
  version: 1,
  context: schema<PlatformCtx>(
    type({
      motd: "string",
      "sandbox?": {
        mode: "'read-only' | 'workspace-write' | 'danger-full-access'",
        "network?": "'none'",
        "maskPaths?": "string[]",
      },
    }),
  ),
  methods: [
    "park",
    "info",
    "createTerminal",
    "terminals",
    "workflows",
    "workflowTools",
    "reseedWorkflow",
  ],
  children: { terminals: keyed(TerminalIface), workflows: keyed(WorkflowIface) },
});

export const platformImpl: Impl<PlatformApi, PlatformCtx> = {
  children: { terminals: terminalImpl, workflows: workflowImpl },
  async create(ctx, context, children) {
    // "What PATH does the agent's shell see" is policy (see ../hmr/README.md), not
    // mechanism: it belongs here, in-process at platform boot, rather than in the
    // Electron shell that forks the server — that's what makes the fix reach
    // already-deployed machines via a normal hot push instead of a rebuild. Idempotent,
    // so re-running it on every create() (including hot swaps) is harmless.
    ensureCliOnPath();
    // "Which machines can this window switch to, and how" is policy of the same kind —
    // the earlier home for it was the Electron shell, which was the layer mistake this
    // README exists to prevent. Living here, the whole capability (host list, probe,
    // auto-install, tunnel) reaches deployed machines by push; tunnels it spawned before
    // a swap are re-adopted through the state file, not held objects.
    const machines = new MachinesService(process.env.PENGUIN_HOME ?? resolveRoot());
    const machinesRoutes = machinesHttp(machines, process.env.PENGUIN_HOME ?? resolveRoot(), {
      // The env var is how the shell marks the server it spawned; env is stable for the
      // process's lifetime, so a hot-pushed bundle reads the same answer as the packaged one.
      desktopMode: process.env.PENGUIN_DESKTOP_TOKEN !== undefined,
    });
    // `/server/<id>/api/…` — the same-origin proxy onto a connected machine's tunnel.
    const serverProxy = machinesProxy((id) => machines.tunnelPortFor(id));
    const terminals = children.terminals as KeyedHandle<TerminalApi>;
    const workflows = children.workflows as KeyedHandle<WorkflowApi>;
    // The plugin seam (see ./plugin.ts): every App creation — packaged boot and each
    // hot-swap boot alike — hands plugins the definition view first, then the live
    // instance context ("create" event). Members stay minimal by instruction; they
    // grow only when a concrete need (sandbox first) names them.
    const createTerminal = async (command: string, cwd: string): Promise<{ id: string }> => {
      const id = `term_${Math.random().toString(36).slice(2, 10)}`;
      // Spawn the live resource on the runtime side first; the node only
      // carries its handle id (linear state).
      spawnShellResource(ctx.resources, `proc_${id}`, command, cwd);
      await terminals.add(id, { procId: `proc_${id}`, command, cwd });
      return { id };
    };
    const tools = new Map<string, { workflowId: string; tool: WorkflowTool }>();
    const registry: WorkflowRegistry = {
      register(workflowId, tool) {
        const existing = tools.get(tool.name);
        if (existing !== undefined) {
          throw new Error(
            `tool '${tool.name}' is already registered by workflow '${existing.workflowId}'`,
          );
        }
        tools.set(tool.name, { workflowId, tool });
        return () => tools.delete(tool.name);
      },
    };
    // Plugins are configuration: load whatever plugins.json names before offering
    // the interface, so a configured backend is registered by the time the sandbox
    // service reads the registry below.
    await ensureConfiguredPlugins(process.env.PENGUIN_HOME ?? resolveRoot());
    // Sandbox backends arrive as plugins through iface.sandbox (see plugin.ts);
    // duplicates are refused, and the service routes policies by capability.
    const sandboxProviders = new Map<string, SandboxProviderSource>();
    const pluginIface: PenguinInterface = {
      workflow: new Map(),
      tool: new Map(),
      sandbox: {
        registerProvider(name, provider) {
          if (sandboxProviders.has(name)) {
            throw new Error(`sandbox provider '${name}' is already registered`);
          }
          sandboxProviders.set(name, provider);
        },
      },
    };
    pluginHost.createApp(pluginIface);
    // "Which commands run confined, under which policy, by which backend" is policy of
    // the same kind as the rest of this file: the whole sandbox capability (../sandbox/
    // — its interface, backends and settings) reaches deployed machines by push. Only
    // core's spawn seam and this resource handoff are mechanism. The confiner is
    // registered overwrite-style and never released on park (see the resource id's
    // doc), so a hot swap never opens an unconfined gap.
    const sandbox = new SandboxService(sandboxProviders);
    // Rehydrate the parked settings (state rides the swap): without this, every hot
    // push would construct a fresh service on defaults and silently un-confine a
    // deployment that had confinement on. Documents parked before the field existed
    // restore with it absent — the default (confinement off) — by design.
    if (context.sandbox !== undefined) sandbox.configure(context.sandbox);
    ctx.resources.register(SPAWN_CONFINER_RESOURCE, sandbox.confiner());
    pluginHost.emit("create", {
      workflows,
      terminals,
      createTerminal,
      sandbox: {
        configure: (settings) => sandbox.configure(settings),
        settings: () => sandbox.currentSettings(),
      },
      shell: {
        // A raw shell is the same runtime-owned live resource a terminal wraps —
        // minus the identity node. It survives swaps in the Resources registry and
        // is killed by the process-exit sweep like every other shell proc.
        spawn: (cmd, opts) =>
          spawnShellResource(
            ctx.resources,
            `shell_${Math.random().toString(36).slice(2, 10)}`,
            cmd,
            opts.cwd,
          ),
      },
      tools: () =>
        [...tools.values()].map(({ workflowId, tool }) => ({
          workflowId,
          name: tool.name,
          description: tool.description,
        })),
      agents: {
        run: async () => {
          throw new Error(
            "agent invocation is not wired yet: the capability lands with the dedicated agent-invocation service",
          );
        },
      },
    });
    // `http` rides beside the iface methods (not IN them: a Request/Response pair is not
    // Json) — the seam calls it in-process on the booted object. See ../hmr/http-seam.ts.
    return {
      http: async (request: Request) =>
        (await machinesRoutes(request)) ?? (await serverProxy(request)),
      park: () => {
        // Omitted while settings are the pristine default (see parkedSettings): a
        // default deployment keeps parking { motd }, compatible with any bundle's
        // schema; once confinement is configured, pushing a sandbox-ignorant bundle
        // blocks rather than silently un-confining.
        const parkedSandbox = sandbox.parkedSettings();
        return {
          motd: context.motd,
          ...(parkedSandbox !== undefined ? { sandbox: parkedSandbox } : {}),
        };
      },
      info: () => ({
        impl: "packaged",
        ifaceVersion: PlatformIface.version,
        motd: context.motd,
        terminals: terminals.keys(),
        workflows: workflows.keys(),
      }),
      createTerminal,
      terminals: () => terminals,
      workflows: () => workflows,
      workflowTools: () =>
        [...tools.values()].map(({ workflowId, tool }) => ({
          workflowId,
          name: tool.name,
          description: tool.description,
        })),
      reseedWorkflow(id, runCtx) {
        const workflow = workflows.get(id);
        if (workflow === undefined) throw new Error(`No workflow '${id}'.`);
        workflow.setup(id, registry, runCtx);
      },
    };
  },
};

/** The packaged bundle the runtime boots when nothing has been pushed yet. */
export const packagedPlatform = { id: "packaged", iface: PlatformIface, impl: platformImpl };

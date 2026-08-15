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
import { spawnShellResource } from "../hmr/resources.js";
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

export type PlatformCtx = { motd: string };

export const PlatformIface = defineIface<PlatformApi, PlatformCtx>({
  name: "platform",
  version: 1,
  context: schema<PlatformCtx>(type({ motd: "string" })),
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
  create(ctx, context, children) {
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
    // `http` rides beside the iface methods (not IN them: a Request/Response pair is not
    // Json) — the seam calls it in-process on the booted object. See ../hmr/http-seam.ts.
    return {
      http: async (request: Request) =>
        (await machinesRoutes(request)) ?? (await serverProxy(request)),
      park: () => ({ motd: context.motd }),
      info: () => ({
        impl: "packaged",
        ifaceVersion: PlatformIface.version,
        motd: context.motd,
        terminals: terminals.keys(),
        workflows: workflows.keys(),
      }),
      async createTerminal(command, cwd) {
        const id = `term_${Math.random().toString(36).slice(2, 10)}`;
        // Spawn the live resource on the runtime side first; the node only
        // carries its handle id (linear state).
        spawnShellResource(ctx.resources, `proc_${id}`, command, cwd);
        await terminals.add(id, { procId: `proc_${id}`, command, cwd });
        return { id };
      },
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

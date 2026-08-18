/**
 * The harness plugin seam — PLATFORM LAYER, minimal by instruction.
 *
 * Vocabulary (set by the user, 2026-08-18):
 *   harness  = Platform (backend) + App (frontend)
 *   workflow = Workflow
 *
 * Two views of the harness:
 *
 *   - {@link PenguinContext} — an INSTANCE of the harness. Platform members flatten
 *     directly onto it (`context.terminals`, not `context.platform.terminals`);
 *     workflow instances live at `context.workflows`.
 *   - {@link PenguinInterface} — the INTERFACE (definition view) of the harness.
 *     Workflow FACTORIES live at `iface.workflow` (a Map).
 *
 * Both are deliberately near-empty: the MVP exists to cover the sandbox capability's
 * needs, and members land only when a concrete need names them — everything else is
 * reserved room, not designed surface.
 *
 * A raw plugin is two hooks:
 *   - `onCreateApp(iface)` — definition-time: fired once per App creation (including
 *     each hot-swap boot, which creates a new App instance) with the interface view.
 *   - `subscribe(eventName, ctx)` — instance-time: the host delivers each event by
 *     calling this with the event's name and the live context. Event names are an
 *     open set for now; `"create"` (fired right after the instance context is
 *     assembled) is the only one the platform emits yet.
 */
import type { KeyedHandle } from "@prismshadow/penguin-core/kernel";
import type { TerminalApi } from "./terminal.js";
import type { WorkflowApi } from "./workflow.js";

/** A workflow factory. Placeholder: the shape lands with the first real factory. */
export type WorkflowFactory = unknown;

/**
 * A tool factory — floor 4, RESERVED. Placeholder like WorkflowFactory: the shape
 * lands with the first plugin-provided tool. The open decision it reserves: whether
 * plugin tools reach agent Environments, which would need a platform→core injection
 * seam along the confineSpawn precedent (a getter re-read per Session).
 */
export type ToolFactory = unknown;

/**
 * A live shell process: the harness's bottom primitive. The shape is the runtime's
 * ShellProcResource (hmr/resources.ts) — spawned processes are runtime-owned live
 * resources, so they survive a platform swap; everything above (terminal = shell +
 * identity; sandbox = a decorator on how shells SPAWN) builds on this.
 */
export interface ShellHandle {
  /** Full buffered output (stdout+stderr interleaved), capped. */
  read(): string;
  write(data: string): void;
  alive(): boolean;
  kill(): void;
}

/** The shell capability: host-provided, plugin-consumed. */
export interface ShellCapability {
  spawn(cmd: string, opts: { cwd: string }): ShellHandle;
}

/** An INSTANCE of the harness: platform members flattened, workflow instances at `workflows`. */
export interface PenguinContext {
  /** Workflow instances (the platform's keyed workflow nodes). */
  workflows: KeyedHandle<WorkflowApi>;
  /**
   * Terminals — a platform member, flattened onto the context per the vocabulary.
   * A terminal is a shell plus identity: its process id parks with the tree and is
   * claimed back from the runtime's resource registry after a swap (or reported
   * `lost()` when it cannot be).
   */
  terminals: KeyedHandle<TerminalApi>;
  /** Spawn a raw shell process (see {@link ShellCapability}). */
  shell: ShellCapability;
  /** Create a terminal — the platform's createTerminal, flattened. */
  createTerminal(command: string, cwd: string): Promise<{ id: string }>;
  /** The tools currently registered on this App instance (workflow tools today). Live view. */
  tools(): Array<{ workflowId: string; name: string; description: string }>;
  /**
   * Agent invocation — floor 5, RESERVED: the runWorkflowAgent seam turned into a
   * capability. Not wired yet (a real invocation service must settle task-mutex /
   * approval / streaming semantics first — see workflow-service.ts); calling it today
   * rejects, honestly.
   */
  agents: {
    run(projectId: string, agentId: string, prompt: string): Promise<string>;
  };
  // context.* — further platform members flatten here as concrete needs land.
}

/** The INTERFACE (definition view) of the harness. */
export interface PenguinInterface {
  /** Workflow factories, keyed by name. */
  workflow: Map<string, WorkflowFactory>;
  /** Tool factories, keyed by name — floor 4, RESERVED (see {@link ToolFactory}). */
  tool: Map<string, ToolFactory>;
}

/** A raw plugin: both hooks optional — a plugin may care about only one side. */
export interface RawPlugin {
  onCreateApp?(iface: PenguinInterface): void;
  subscribe?(eventName: string, ctx: PenguinContext): void;
}

/**
 * The minimal plugin host: registration order is delivery order; hooks are delivered
 * synchronously. One host per server process; the platform drives it at every App
 * creation (see platform.ts), so a plugin registered before boot sees every instance.
 */
export class PluginHost {
  private readonly plugins: RawPlugin[] = [];

  use(plugin: RawPlugin): void {
    this.plugins.push(plugin);
  }

  /** Definition-time dispatch: every plugin's onCreateApp, in registration order. */
  createApp(iface: PenguinInterface): void {
    for (const plugin of this.plugins) plugin.onCreateApp?.(iface);
  }

  /** Instance-time dispatch: deliver one event to every plugin, in registration order. */
  emit(eventName: string, ctx: PenguinContext): void {
    for (const plugin of this.plugins) plugin.subscribe?.(eventName, ctx);
  }
}

/**
 * The process-wide host. Module-level on purpose: plugins register against the
 * harness, not against one platform incarnation — a hot swap creates a new App
 * instance and the host re-delivers onCreateApp/"create" to the same plugins.
 */
export const pluginHost = new PluginHost();

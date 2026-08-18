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

/** An INSTANCE of the harness: platform members flattened, workflow instances at `workflows`. */
export interface PenguinContext {
  /** Workflow instances (the platform's keyed workflow nodes). */
  workflows: KeyedHandle<WorkflowApi>;
  /** Terminals — a platform member, flattened onto the context per the vocabulary. */
  terminals: KeyedHandle<TerminalApi>;
  // context.* — further platform members flatten here as concrete needs land.
}

/** The INTERFACE (definition view) of the harness. */
export interface PenguinInterface {
  /** Workflow factories, keyed by name. */
  workflow: Map<string, WorkflowFactory>;
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

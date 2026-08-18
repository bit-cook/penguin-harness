/**
 * Test fixture: "the NEXT deployed build" of the business platform, WITH workflow
 * support — the same-version push that models a routine rebuild of today's platform
 * arriving over HTTP. Where platform-next.bundle.mjs (iface v2, no workflows child)
 * exercises the migration ladder, this fixture exercises what a normal push must
 * preserve: dynamic workflow nodes ride the parked tree into the new instance, and the
 * upgrade route re-seeds their tool registrations and runCtx bindings afterwards.
 *
 * Intentionally standalone — no kernel/arktype imports, only node builtins — like its
 * sibling fixture: the kernel contracts are structural data any independently built
 * artifact can satisfy.
 */
import { spawn } from "node:child_process";

const ok = (value) => ({ ok: true, value });
const fail = (p) => ({
  ok: false,
  dropped: p.dropped ?? [],
  missing: p.missing ?? [],
  invalid: p.invalid ?? [],
});

/** Minimal strict object schema: fields map name → typeof-kind; "json" accepts anything present. */
function objectSchema(fields) {
  return {
    strictParse(doc, path = "$") {
      if (doc === undefined) return fail({ missing: [path] });
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        return fail({ invalid: [`${path}: expected object`] });
      }
      const dropped = [];
      const missing = [];
      const invalid = [];
      for (const [name, kind] of Object.entries(fields)) {
        const value = doc[name];
        if (!(name in doc)) missing.push(`${path}.${name}`);
        else if (kind !== "json" && typeof value !== kind)
          invalid.push(`${path}.${name}: expected ${kind}`);
      }
      for (const key of Object.keys(doc)) {
        if (!(key in fields)) dropped.push(`${path}.${key}`);
      }
      return dropped.length > 0 || missing.length > 0 || invalid.length > 0
        ? fail({ dropped, missing, invalid })
        : ok(doc);
    },
    describe: () => ({ kind: "object", fields }),
  };
}

const terminalIface = {
  kind: "iface",
  name: "terminal",
  version: 1,
  context: objectSchema({ procId: "string", command: "string", cwd: "string" }),
  methods: ["park", "write", "read", "alive", "lost"],
  children: {},
  migrations: {},
};

const terminalImpl = {
  create(ctx, context) {
    const res = ctx.resources.claim(context.procId);
    const live = res !== undefined && res.kind === "shell-proc" ? res : undefined;
    return {
      park: () => ({ ...context }),
      write: (data) => live?.write(data),
      read: () => (live === undefined ? "[terminal lost: process not claimable]" : live.read()),
      alive: () => live?.alive() ?? false,
      lost: () => live === undefined,
    };
  },
};

const workflowIface = {
  kind: "iface",
  name: "workflow",
  version: 1,
  context: objectSchema({ script: "string", rev: "number", state: "json" }),
  methods: ["park", "describe", "setup", "run"],
  children: {},
  migrations: {},
};

const workflowImpl = {
  create(nodeCtx, context) {
    const factory = new Function("context", `"use strict";\n${context.script}`);
    const obj = factory({ state: context.state });
    let bound = null;
    return {
      park: () => ({ script: context.script, rev: context.rev, state: obj.park?.() ?? null }),
      describe: () => ({ name: obj.name, version: obj.version, rev: context.rev }),
      setup(id, registry, runCtx) {
        bound = runCtx;
        obj.setup?.({
          registerTool(tool) {
            nodeCtx.effect(registry.register(id, tool));
          },
        });
      },
      async run(input) {
        if (!bound) throw new Error("workflow is not activated");
        return await obj.run(input, bound);
      },
    };
  },
};

const platformIface = {
  kind: "iface",
  name: "platform",
  version: 1,
  context: objectSchema({ motd: "string" }),
  methods: [
    "park",
    "info",
    "createTerminal",
    "terminals",
    "workflows",
    "workflowTools",
    "reseedWorkflow",
  ],
  children: {
    terminals: { kind: "keyed", iface: terminalIface },
    workflows: { kind: "keyed", iface: workflowIface },
  },
  migrations: {},
};

const platformImpl = {
  children: { terminals: terminalImpl, workflows: workflowImpl },
  create(ctx, context, children) {
    const terminals = children.terminals;
    const workflows = children.workflows;
    const tools = new Map();
    const registry = {
      register(workflowId, tool) {
        tools.set(tool.name, { workflowId, tool });
        return () => tools.delete(tool.name);
      },
    };
    return {
      park: () => ({ motd: context.motd }),
      info: () => ({
        impl: "workflow-next",
        ifaceVersion: platformIface.version,
        motd: context.motd,
        terminals: terminals.keys(),
        workflows: workflows.keys(),
      }),
      async createTerminal(command, cwd) {
        const id = `term_${Math.random().toString(36).slice(2, 10)}`;
        const procId = `proc_${id}`;
        const proc = spawn(command, { shell: true, cwd, stdio: ["pipe", "pipe", "pipe"] });
        const chunks = [];
        let exited = false;
        proc.stdout?.on("data", (d) => chunks.push(d.toString("utf8")));
        proc.stderr?.on("data", (d) => chunks.push(d.toString("utf8")));
        proc.on("exit", () => (exited = true));
        proc.on("error", () => (exited = true));
        ctx.resources.register(procId, {
          kind: "shell-proc",
          proc,
          read: () => chunks.join(""),
          write: (data) => proc.stdin?.write(data),
          alive: () => !exited,
          kill: () => {
            if (!exited) proc.kill();
          },
        });
        await terminals.add(id, { procId, command, cwd });
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

export const hotPlatform = { id: "workflow-next", iface: platformIface, impl: platformImpl };

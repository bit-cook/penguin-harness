import type { Impl, Json, Park } from "@prismshadow/penguin-core/kernel";
import { defineIface, schema, type } from "@prismshadow/penguin-core/kernel";

export class ScriptContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptContractError";
  }
}

export interface WorkflowTool {
  name: string;
  description: string;
  run(input: unknown): unknown;
}

export interface WorkflowRegistry {
  register(owner: string, tool: WorkflowTool): () => void;
}

export interface WorkflowRunCtx {
  runAgent(prompt: string): Promise<string>;
}

export interface WorkflowObject {
  name: string;
  version: number;
  run(input: unknown, ctx: WorkflowRunCtx): unknown;
  setup?(ctx: { registerTool(tool: WorkflowTool): void }): void;
  park?(): unknown;
}

const WorkflowContract = type({
  name: "string > 0",
  version: "number",
  run: "Function",
  "setup?": "Function",
  "park?": "Function",
});

const ToolContract = type({ name: "string > 0", description: "string", run: "Function" });

export function evaluateWorkflow(script: string, state: Json = null): WorkflowObject {
  let factory: (context: { state: Json }) => unknown;
  try {
    factory = new Function("context", `"use strict";\n${script}`) as typeof factory;
  } catch (err) {
    throw new ScriptContractError(
      `script does not parse as a function body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let value: unknown;
  try {
    value = factory({ state });
  } catch (err) {
    throw new ScriptContractError(
      `script threw while evaluating: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const out = WorkflowContract(value);
  if (out instanceof type.errors) {
    throw new ScriptContractError(`workflow contract violation: ${out.summary}`);
  }
  return out as unknown as WorkflowObject;
}

export type WorkflowCtx = { script: string; rev: number; state: Json };

const JsonType = type("unknown").narrow((value): value is Json => isJson(value));

export interface WorkflowApi extends Park {
  describe(): { name: string; version: number; rev: number };
  setup(id: string, registry: WorkflowRegistry, runCtx: WorkflowRunCtx): void;
  run(input: unknown): Promise<unknown>;
}

export const WorkflowIface = defineIface<WorkflowApi, WorkflowCtx>({
  name: "workflow",
  version: 1,
  context: schema<WorkflowCtx>(type({ script: "string", rev: "number", state: JsonType })),
  methods: ["park", "describe", "setup", "run"],
});

export const workflowImpl: Impl<WorkflowApi, WorkflowCtx> = {
  create(nodeCtx, context) {
    const obj = evaluateWorkflow(context.script, context.state);
    let unloading = false;
    let boundRunCtx: WorkflowRunCtx | null = null;
    nodeCtx.effect(() => {
      unloading = true;
    });
    return {
      park: () => ({
        script: context.script,
        rev: context.rev,
        state: jsonValue(obj.park?.() ?? null, "workflow park state"),
      }),
      describe: () => ({
        name: obj.name,
        version: obj.version,
        rev: context.rev,
      }),
      setup(id, registry, runCtx) {
        boundRunCtx = runCtx;
        obj.setup?.({
          registerTool(tool) {
            if (unloading) {
              throw new ScriptContractError(`workflow '${id}' is unloading; cannot register tools`);
            }
            const checked = ToolContract(tool);
            if (checked instanceof type.errors) {
              throw new ScriptContractError(`tool contract violation: ${checked.summary}`);
            }
            nodeCtx.effect(registry.register(id, checked as unknown as WorkflowTool));
          },
        });
      },
      async run(input) {
        if (!boundRunCtx) throw new Error("workflow is not activated");
        return await obj.run(input, boundRunCtx);
      },
    };
  },
};

function jsonValue(value: unknown, label: string): Json {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("value is undefined");
    return JSON.parse(text) as Json;
  } catch (err) {
    throw new ScriptContractError(
      `${label} is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJson);
}

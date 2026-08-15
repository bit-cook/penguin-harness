import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Json } from "@prismshadow/penguin-core/kernel";
import { agentStateDir } from "@prismshadow/penguin-core";
import type { HmrHost } from "./host.js";
import type { PlatformApi } from "../platform/platform.js";
import { evaluateWorkflow } from "../platform/workflow.js";

export interface WorkflowSummary {
  id: string;
  agentId: string;
  workflowId: string;
  name: string;
  version: number;
  rev: number;
  uiRev: string | null;
  tools: Array<{ name: string; description: string }>;
}

export interface WorkflowInstall {
  projectId: string;
  agentId: string;
  workflowId: string;
  script: string;
  ui?: { files: Record<string, string> };
}

interface ActiveAgent {
  refs: number;
  projectId: string;
  agentId: string;
  slots: Set<string>;
}

export class WorkflowService {
  private readonly active = new Map<string, ActiveAgent>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly hmr: HmrHost,
    private readonly runAgent: (
      projectId: string,
      agentId: string,
      prompt: string,
    ) => Promise<string>,
  ) {}

  async activate(projectId: string, agentId: string): Promise<void> {
    return this.serial(() => this.doActivate(projectId, agentId));
  }

  private async doActivate(projectId: string, agentId: string): Promise<void> {
    const key = agentKey(projectId, agentId);
    const existing = this.active.get(key);
    if (existing) {
      existing.refs++;
      return;
    }
    const entry: ActiveAgent = { refs: 1, projectId, agentId, slots: new Set() };
    this.active.set(key, entry);
    try {
      const dir = workflowsDir(this.root, projectId, agentId);
      const names = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const item of names) {
        if (!item.isDirectory() || !safeId(item.name)) continue;
        await this.inject(entry, item.name);
      }
    } catch (err) {
      this.active.delete(key);
      throw err;
    }
  }

  async deactivate(projectId: string, agentId: string): Promise<void> {
    return this.serial(() => this.doDeactivate(projectId, agentId));
  }

  private async doDeactivate(projectId: string, agentId: string): Promise<void> {
    const key = agentKey(projectId, agentId);
    const entry = this.active.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.active.delete(key);
    await this.hmr.mutate(async (inst) => {
      for (const slotId of entry.slots) {
        const workflow = inst.api.workflows().get(slotId);
        if (!workflow) continue;
        const parked = workflow.park() as { state?: Json };
        const workflowId = slotId.slice(slotId.indexOf("/") + 1);
        await atomicJson(
          statePath(this.root, projectId, agentId, workflowId),
          parked.state ?? null,
        );
        inst.api.workflows().remove(slotId);
      }
    }, false);
  }

  async shutdown(): Promise<void> {
    for (const entry of [...this.active.values()]) {
      entry.refs = 1;
      await this.doDeactivate(entry.projectId, entry.agentId);
    }
  }

  async list(): Promise<WorkflowSummary[]> {
    const inst = await this.hmr.ensure();
    const out: WorkflowSummary[] = [];
    for (const entry of this.active.values()) {
      for (const id of entry.slots) {
        const workflowId = id.slice(id.indexOf("/") + 1);
        out.push(await this.describe(inst.api, entry.projectId, entry.agentId, workflowId));
      }
    }
    return out;
  }

  isActive(projectId: string, agentId: string): boolean {
    return this.active.has(agentKey(projectId, agentId));
  }

  async install(args: WorkflowInstall): Promise<WorkflowSummary | null> {
    return this.serial(() => this.doInstall(args));
  }

  private async doInstall(args: WorkflowInstall): Promise<WorkflowSummary | null> {
    assertId(args.agentId, "agentId");
    assertId(args.workflowId, "workflow id");
    evaluateWorkflow(args.script, null);
    const dir = workflowDir(this.root, args.projectId, args.agentId, args.workflowId);
    await fs.mkdir(dir, { recursive: true });
    await atomicText(path.join(dir, "workflow.js"), args.script);
    if (args.ui) await writeUi(path.join(dir, "ui"), args.ui.files);
    const active = this.active.get(agentKey(args.projectId, args.agentId));
    if (!active) return null;
    await this.replace(active, args.workflowId);
    const inst = await this.hmr.ensure();
    return await this.describe(inst.api, args.projectId, args.agentId, args.workflowId);
  }

  async remove(projectId: string, agentId: string, workflowId: string): Promise<void> {
    return this.serial(() => this.doRemove(projectId, agentId, workflowId));
  }

  private async doRemove(projectId: string, agentId: string, workflowId: string): Promise<void> {
    assertId(agentId, "agentId");
    assertId(workflowId, "workflow id");
    const active = this.active.get(agentKey(projectId, agentId));
    if (active) {
      const id = slotKey(agentId, workflowId);
      await this.hmr.mutate(async (inst) => {
        const workflow = inst.api.workflows().get(id);
        if (workflow) {
          const parked = workflow.park() as { state?: Json };
          await atomicJson(
            statePath(this.root, projectId, agentId, workflowId),
            parked.state ?? null,
          );
          inst.api.workflows().remove(id);
        }
      }, false);
      active.slots.delete(id);
    }
    await fs.rm(workflowDir(this.root, projectId, agentId, workflowId), {
      recursive: true,
      force: true,
    });
  }

  async resolveUi(
    agentId: string,
    workflowId: string,
    rel: string,
  ): Promise<{ bytes: Buffer; path: string } | null> {
    const active = [...this.active.values()].find((entry) => entry.agentId === agentId);
    if (!active || !active.slots.has(slotKey(agentId, workflowId))) return null;
    const base = path.join(workflowDir(this.root, active.projectId, agentId, workflowId), "ui");
    const target = path.resolve(base, rel || "index.html");
    if (target !== path.resolve(base) && !target.startsWith(path.resolve(base) + path.sep))
      return null;
    let file = target;
    try {
      if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html");
      return { bytes: await fs.readFile(file), path: file };
    } catch {
      try {
        const fallback = path.join(base, "index.html");
        return { bytes: await fs.readFile(fallback), path: fallback };
      } catch {
        return null;
      }
    }
  }

  private async replace(entry: ActiveAgent, workflowId: string): Promise<void> {
    const id = slotKey(entry.agentId, workflowId);
    await this.hmr.mutate(async (inst) => {
      const old = inst.api.workflows().get(id);
      const oldPark = old?.park() as { rev?: number; state?: Json } | undefined;
      const source = await fs.readFile(
        path.join(
          workflowDir(this.root, entry.projectId, entry.agentId, workflowId),
          "workflow.js",
        ),
        "utf8",
      );
      const state =
        oldPark?.state ?? (await readState(this.root, entry.projectId, entry.agentId, workflowId));
      evaluateWorkflow(source, state);
      old && inst.api.workflows().remove(id);
      await inst.api.workflows().add(id, { script: source, rev: (oldPark?.rev ?? 0) + 1, state });
      inst.api.reseedWorkflow(id, {
        runAgent: (prompt) => this.runAgent(entry.projectId, entry.agentId, prompt),
      });
    }, false);
    entry.slots.add(id);
  }

  private async inject(entry: ActiveAgent, workflowId: string): Promise<void> {
    await this.replace(entry, workflowId);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async describe(
    api: PlatformApi,
    projectId: string,
    agentId: string,
    workflowId: string,
  ): Promise<WorkflowSummary> {
    const base = summary(api, slotKey(agentId, workflowId));
    return {
      ...base,
      uiRev: await directoryRevision(
        path.join(workflowDir(this.root, projectId, agentId, workflowId), "ui"),
      ),
    };
  }
}

function summary(api: PlatformApi, id: string): Omit<WorkflowSummary, "uiRev"> & { uiRev: null } {
  const workflow = api.workflows().get(id)!;
  const [agentId, ...rest] = id.split("/");
  const workflowId = rest.join("/");
  return {
    id,
    agentId: agentId!,
    workflowId,
    ...workflow.describe(),
    uiRev: null,
    tools: api
      .workflowTools()
      .filter((tool) => tool.workflowId === id)
      .map(({ workflowId: _, ...tool }) => tool),
  };
}

function agentKey(projectId: string, agentId: string): string {
  return `${projectId}\0${agentId}`;
}
function slotKey(agentId: string, workflowId: string): string {
  return `${agentId}/${workflowId}`;
}
function safeId(id: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(id);
}
function assertId(id: string, label: string): void {
  if (!safeId(id)) throw new Error(`${label} is invalid`);
}
function workflowsDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), "workflows");
}
function workflowDir(root: string, projectId: string, agentId: string, workflowId: string): string {
  return path.join(workflowsDir(root, projectId, agentId), workflowId);
}
function statePath(root: string, projectId: string, agentId: string, workflowId: string): string {
  return path.join(workflowDir(root, projectId, agentId, workflowId), "state.json");
}
async function readState(
  root: string,
  projectId: string,
  agentId: string,
  workflowId: string,
): Promise<Json> {
  try {
    return JSON.parse(
      await fs.readFile(statePath(root, projectId, agentId, workflowId), "utf8"),
    ) as Json;
  } catch {
    return null;
  }
}
async function atomicText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}
async function atomicJson(file: string, value: Json): Promise<void> {
  await atomicText(file, JSON.stringify(value, null, 2));
}
async function writeUi(dir: string, files: Record<string, string>): Promise<void> {
  if (typeof files["index.html"] !== "string") throw new Error("workflow UI has no index.html");
  const tmp = `${dir}.${process.pid}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  for (const [rel, value] of Object.entries(files)) {
    const target = path.resolve(tmp, rel);
    if (!target.startsWith(path.resolve(tmp) + path.sep))
      throw new Error(`unsafe workflow UI path: ${rel}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(value, "base64"));
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rename(tmp, dir);
}
export function uiRevision(files: Array<{ path: string; bytes: Buffer }>): string {
  const hash = crypto.createHash("sha1");
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(file.path).update(file.bytes);
  return hash.digest("hex").slice(0, 12);
}
async function directoryRevision(dir: string): Promise<string | null> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  async function walk(base: string, rel = ""): Promise<void> {
    for (const entry of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
      const next = path.join(base, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next, nextRel);
      else if (entry.isFile()) files.push({ path: nextRel, bytes: await fs.readFile(next) });
    }
  }
  await walk(dir);
  return files.some((file) => file.path === "index.html") ? uiRevision(files) : null;
}

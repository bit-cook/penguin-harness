import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentStateDir } from "@prismshadow/penguin-core";
import { buildAppDeps, createApp } from "../src/app.js";
import { apiClient, createTestApp, loginAdmin, testConfig } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import type { RuntimeSession } from "../src/runtime/session-manager.js";

const PROJECT = "admin-default_project";
const AGENT = "default_agent";
const COUNTER = `
  let count = context.state?.count ?? 0;
  return {
    name: "counter",
    version: 1,
    async run(input, ctx) {
      count += input.by ?? 1;
      return { count, agent: input.prompt ? await ctx.runAgent(input.prompt) : null };
    },
    park() { return { count }; }
  };
`;
const COUNTER_V2 = `
  let count = context.state?.count ?? 0;
  return { name: "counter-next", version: 2, run(input) { count += input.by ?? 1; return { count }; }, park() { return { count }; } };
`;

describe("workflow folders", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;

  beforeEach(async () => {
    t = await createTestApp({
      runWorkflowAgent: async (projectId, agentId, prompt) => `${projectId}:${agentId}:${prompt}`,
    });
    api = apiClient(t.app, (await loginAdmin(t.app)).cookie);
  });
  afterEach(async () => t.cleanup());

  it("installs to an inactive Agent folder without injecting, then activation scans it", async () => {
    const res = await api.post("/api/hmr/workflows", payload("count", COUNTER));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ installed: true, active: false });
    expect(await fs.readFile(workflowFile(t.root, AGENT, "count"), "utf8")).toBe(COUNTER);
    expect(await (await api.get("/api/hmr/workflows")).json()).toEqual({ workflows: [] });

    await t.deps.workflows.activate(PROJECT, AGENT);
    expect(await (await api.get("/api/hmr/workflows")).json()).toMatchObject({
      workflows: [
        { id: "default_agent/count", agentId: AGENT, workflowId: "count", name: "counter" },
      ],
    });
  });

  it("binds runAgent to the activated Agent and carries state through a hot reload", async () => {
    await api.post("/api/hmr/workflows", payload("count", COUNTER));
    await t.deps.workflows.activate(PROJECT, AGENT);
    expect(
      await (
        await api.post("/api/hmr/workflows/default_agent%2Fcount/run", {
          input: { by: 2, prompt: "hi" },
        })
      ).json(),
    ).toEqual({
      result: { count: 2, agent: `${PROJECT}:${AGENT}:hi` },
    });
    const reload = await api.post("/api/hmr/workflows/count/reload", payload("count", COUNTER_V2));
    expect(reload.status).toBe(200);
    expect(
      await (
        await api.post("/api/hmr/workflows/default_agent%2Fcount/run", { input: { by: 3 } })
      ).json(),
    ).toEqual({ result: { count: 5 } });
  });

  it("parks state atomically on final deactivation and restores it on activation", async () => {
    await api.post("/api/hmr/workflows", payload("count", COUNTER));
    await t.deps.workflows.activate(PROJECT, AGENT);
    await api.post("/api/hmr/workflows/default_agent%2Fcount/run", { input: { by: 7 } });
    await t.deps.workflows.deactivate(PROJECT, AGENT);
    expect(JSON.parse(await fs.readFile(stateFile(t.root, AGENT, "count"), "utf8"))).toEqual({
      count: 7,
    });
    expect(await (await api.get("/api/hmr/workflows")).json()).toEqual({ workflows: [] });
    await t.deps.workflows.activate(PROJECT, AGENT);
    expect(
      await (
        await api.post("/api/hmr/workflows/default_agent%2Fcount/run", { input: { by: 1 } })
      ).json(),
    ).toEqual({ result: { count: 8, agent: null } });
  });

  it("namespaces equal workflow ids by Agent", async () => {
    await api.post("/api/hmr/workflows", payload("same", COUNTER));
    await api.post("/api/hmr/workflows", payload("same", COUNTER, "helper_agent"));
    await t.deps.workflows.activate(PROJECT, AGENT);
    await t.deps.workflows.activate(PROJECT, "helper_agent");
    const rows = (
      (await (await api.get("/api/hmr/workflows")).json()) as { workflows: Array<{ id: string }> }
    ).workflows;
    expect(rows.map((row) => row.id).sort()).toEqual(["default_agent/same", "helper_agent/same"]);
  });

  it("serves UI from the active Agent folder with scoped fallback", async () => {
    const ui = {
      files: {
        "index.html": b64("<html>folder-ui</html>"),
        "assets/app.js": b64("console.log(1)"),
      },
    };
    await api.post("/api/hmr/workflows", { ...payload("ui", COUNTER), ui });
    expect((await t.app.request("/workflow/default_agent/ui/")).status).toBe(404);
    await t.deps.workflows.activate(PROJECT, AGENT);
    expect(await (await t.app.request("/workflow/default_agent/ui/")).text()).toContain(
      "folder-ui",
    );
    expect(
      (await t.app.request("/workflow/default_agent/ui/assets/app.js")).headers.get("content-type"),
    ).toBe("text/javascript; charset=utf-8");
    expect(await (await t.app.request("/workflow/default_agent/ui/client/route")).text()).toContain(
      "folder-ui",
    );
  });

  it("does not restore workflows from harness before activation, then restores folder state", async () => {
    await api.post("/api/hmr/workflows", payload("count", COUNTER));
    await t.deps.workflows.activate(PROJECT, AGENT);
    await api.post("/api/hmr/workflows/default_agent%2Fcount/run", { input: { by: 4 } });
    await t.deps.workflows.deactivate(PROJECT, AGENT);
    t.deps.hmr.dispose();

    const deps = buildAppDeps(testConfig(t.root), { log: () => {} });
    await deps.authService.seedAdmin();
    const app = createApp(deps);
    const nextApi = apiClient(app, (await loginAdmin(app)).cookie);
    expect(await (await nextApi.get("/api/hmr/workflows")).json()).toEqual({ workflows: [] });
    await deps.workflows.activate(PROJECT, AGENT);
    expect(
      await (
        await nextApi.post("/api/hmr/workflows/default_agent%2Fcount/run", { input: { by: 1 } })
      ).json(),
    ).toEqual({ result: { count: 5, agent: null } });
    await deps.workflows.shutdown();
    deps.hmr.dispose();
    deps.channels.dispose();
    deps.db.close();
  });

  it("activates on SessionManager adopt and deactivates when the runtime entry is removed", async () => {
    await api.post("/api/hmr/workflows", payload("managed", COUNTER));
    const row = {
      sessionId: "session-2026-08-15-03-00-00-aabbccdd",
      projectId: PROJECT,
      agentId: AGENT,
      provider: "test",
      modelId: "test",
      workspace: t.root,
      approvalMode: "allow-all" as const,
      title: null,
      client: "web" as const,
      createdAt: new Date().toISOString(),
    };
    t.deps.sessionsRepo.insert(row);
    t.deps.manager.adopt(row, fakeSession(row.sessionId));
    await waitUntil(async () =>
      (await t.deps.workflows.list()).some((workflow) => workflow.id === `${AGENT}/managed`),
    );
    await api.post(`/api/hmr/workflows/${encodeURIComponent(`${AGENT}/managed`)}/run`, {
      input: { by: 3 },
    });
    t.deps.manager.beginSessionDeletion(row.sessionId);
    await waitUntil(async () => {
      try {
        return (
          JSON.parse(await fs.readFile(stateFile(t.root, AGENT, "managed"), "utf8")).count === 3
        );
      } catch {
        return false;
      }
    });
  });
});

function payload(workflowId: string, script: string, agentId = AGENT) {
  return { projectId: PROJECT, agentId, workflowId, script };
}
function workflowFile(root: string, agentId: string, workflowId: string) {
  return path.join(agentStateDir(root, PROJECT, agentId), "workflows", workflowId, "workflow.js");
}
function stateFile(root: string, agentId: string, workflowId: string) {
  return path.join(agentStateDir(root, PROJECT, agentId), "workflows", workflowId, "state.json");
}
function b64(value: string) {
  return Buffer.from(value).toString("base64");
}
function fakeSession(sessionId: string): RuntimeSession {
  return {
    sessionId,
    async *run() {},
    async *compact() {},
    compactability: () => "empty",
    steer: () => false,
    skipReconnectWait: () => false,
    toolPermission: () => undefined,
    generateTitle: async () => ({ title: "", usage: null }),
  };
}
async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("workflows across a platform hot swap", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let cookie: string;

  // A workflow that registers a tool in setup(), so the swap must restore BOTH halves
  // of the seeding: the tool registration (new create()'s registry starts empty) and
  // the runCtx binding (the old node's closure died with the old instance).
  const TOOLED = `
    let count = context.state?.count ?? 0;
    return {
      name: "tooled-counter",
      version: 1,
      setup(ctx) {
        ctx.registerTool({ name: "count_peek", description: "read the count", run: () => count });
      },
      async run(input, ctx) {
        count += input.by ?? 1;
        return { count, agent: input.prompt ? await ctx.runAgent(input.prompt) : null };
      },
      park() { return { count }; }
    };
  `;

  beforeEach(async () => {
    t = await createTestApp({
      runWorkflowAgent: async (projectId, agentId, prompt) => `${projectId}:${agentId}:${prompt}`,
    });
    cookie = (await loginAdmin(t.app)).cookie;
    api = apiClient(t.app, cookie);
  });
  afterEach(async () => t.cleanup());

  it("a push re-seeds active workflows: tools stay registered, runCtx stays bound, state rides", async () => {
    await api.post("/api/hmr/workflows", payload("count", TOOLED));
    await t.deps.workflows.activate(PROJECT, AGENT);

    // Pre-swap baseline: tool listed, run works, state at 2.
    expect(await (await api.get("/api/hmr/workflows")).json()).toMatchObject({
      workflows: [{ id: "default_agent/count", tools: [{ name: "count_peek" }] }],
    });
    expect(
      await (
        await api.post("/api/hmr/workflows/default_agent%2Fcount/run", { input: { by: 2 } })
      ).json(),
    ).toEqual({ result: { count: 2, agent: null } });

    // The swap: push the workflow-aware next build (same iface version — the routine
    // "rebuild of today's platform" push).
    const bundle = await fs.readFile(
      fileURLToPath(new URL("./fixtures/platform-workflow-next.bundle.mjs", import.meta.url)),
      "utf8",
    );
    const gz = zlib.gzipSync(
      Buffer.from(
        JSON.stringify({
          platform: bundle,
          cli: "export const cli = async () => 0;\n",
          web: { files: { "index.html": b64("<html>workflow-next</html>") } },
        }),
      ),
    );
    const upgraded = await t.app.request("/api/hmr/upgrade", {
      method: "POST",
      headers: { cookie, "content-type": "application/gzip" },
      body: gz,
    });
    expect(upgraded.status).toBe(200);
    expect(((await upgraded.json()) as { status: string }).status).toBe("ok");

    // Post-swap: the workflow node migrated with its state, AND the seeding is back —
    // the tool is listed and run() continues from the pre-swap count with a live
    // runAgent binding. Without the post-upgrade reseed this returns no tools and
    // run() throws "workflow is not activated".
    expect(await (await api.get("/api/hmr/workflows")).json()).toMatchObject({
      workflows: [{ id: "default_agent/count", tools: [{ name: "count_peek" }] }],
    });
    expect(
      await (
        await api.post("/api/hmr/workflows/default_agent%2Fcount/run", {
          input: { by: 3, prompt: "post-swap" },
        })
      ).json(),
    ).toEqual({ result: { count: 5, agent: `${PROJECT}:${AGENT}:post-swap` } });
  });
});

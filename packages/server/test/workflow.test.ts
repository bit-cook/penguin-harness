import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { buildAppDeps, createApp } from "../src/app.js";
import { apiClient, createTestApp, loginAdmin, testConfig } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const COUNTER_V1 = `
  let count = context.state?.count ?? 0;
  return {
    name: "counter",
    version: 1,
    setup(ctx) {
      ctx.registerTool({ name: "counter-value", description: "Reads the counter.", run: () => ({ count }) });
    },
    async run(input, ctx) {
      count += input.by ?? 1;
      const agent = input.prompt ? await ctx.runAgent(input.prompt) : null;
      return { count, agent };
    },
    park() { return { count }; }
  };
`;

const COUNTER_V2 = `
  let count = context.state?.count ?? 0;
  return {
    name: "counter-next",
    version: 2,
    run(input) { count += input.by ?? 1; return { count, upgraded: true }; },
    park() { return { count }; }
  };
`;

const b64 = (value: string) => Buffer.from(value).toString("base64");
const UI_V1 = {
  files: { "index.html": b64("<html>ui-one</html>"), "assets/app.js": b64("console.log('one')") },
};
const UI_V2 = {
  files: { "index.html": b64("<html>ui-two</html>"), "assets/app.css": b64("body{color:red}") },
};

describe("workflow HMR", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;

  beforeEach(async () => {
    t = await createTestApp({ runWorkflowAgent: async (prompt) => `agent:${prompt}` });
    api = apiClient(t.app, (await loginAdmin(t.app)).cookie);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("installs a workflow and exposes its registered tools", async () => {
    const res = await api.post("/api/hmr/workflows", { id: "count", script: COUNTER_V1 });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: "count",
      name: "counter",
      version: 1,
      rev: 1,
      tools: [{ name: "counter-value", description: "Reads the counter." }],
    });

    const list = await api.get("/api/hmr/workflows");
    expect(await list.json()).toMatchObject({ workflows: [{ id: "count", rev: 1 }] });
  });

  it("reports parse and contract violations as precise 400 errors", async () => {
    const parse = await api.post("/api/hmr/workflows", {
      id: "parse",
      script: "return {",
    });
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as { error: { message: string } }).error.message).toMatch(
      /^script does not parse as a function body:/,
    );

    const contract = await api.post("/api/hmr/workflows", {
      id: "contract",
      script: 'return { name: "missing-run", version: 1 };',
    });
    expect(contract.status).toBe(400);
    expect(((await contract.json()) as { error: { message: string } }).error.message).toContain(
      "workflow contract violation",
    );
  });

  it("runs through the injected agent seam and carries parked state across reload", async () => {
    expect((await api.post("/api/hmr/workflows", { id: "count", script: COUNTER_V1 })).status).toBe(
      201,
    );
    const first = await api.post("/api/hmr/workflows/count/run", {
      input: { by: 2, prompt: "hello" },
    });
    expect(await first.json()).toEqual({ result: { count: 2, agent: "agent:hello" } });

    const reload = await api.post("/api/hmr/workflows/count/reload", { script: COUNTER_V2 });
    expect(reload.status).toBe(200);
    expect(await reload.json()).toMatchObject({ name: "counter-next", version: 2, rev: 2 });
    expect(
      await (await api.post("/api/hmr/workflows/count/run", { input: { by: 3 } })).json(),
    ).toEqual({
      result: { count: 5, upgraded: true },
    });
  });

  it("keeps the old instance running when reload validation fails", async () => {
    await api.post("/api/hmr/workflows", { id: "count", script: COUNTER_V1 });
    await api.post("/api/hmr/workflows/count/run", { input: { by: 4 } });
    const failed = await api.post("/api/hmr/workflows/count/reload", {
      script: 'return { name: "broken", version: 2 };',
    });
    expect(failed.status).toBe(400);
    expect(
      await (await api.post("/api/hmr/workflows/count/run", { input: { by: 1 } })).json(),
    ).toEqual({
      result: { count: 5, agent: null },
    });
    expect(await (await api.get("/api/hmr/workflows")).json()).toMatchObject({
      workflows: [{ id: "count", name: "counter", rev: 1 }],
    });

    await api.post("/api/hmr/workflows", {
      id: "other",
      script:
        'return { name: "other", version: 1, setup(ctx) { ctx.registerTool({ name: "taken", description: "taken", run() {} }); }, run() {} };',
    });
    const collision = await api.post("/api/hmr/workflows/count/reload", {
      script:
        'return { name: "collision", version: 2, setup(ctx) { ctx.registerTool({ name: "taken", description: "duplicate", run() {} }); }, run() {} };',
    });
    expect(collision.status).toBe(400);
    expect(await (await api.get("/api/hmr/workflows")).json()).toMatchObject({
      workflows: [{ id: "count", name: "counter", rev: 1 }, { id: "other" }],
    });
  });

  it("restores installed workflow code and state from harness.json", async () => {
    await api.post("/api/hmr/workflows", { id: "count", script: COUNTER_V1 });
    await api.post("/api/hmr/workflows/count/run", { input: { by: 7 } });

    t.deps.hmr.dispose();
    const deps = buildAppDeps(testConfig(t.root), {
      log: () => {},
      runWorkflowAgent: async (prompt) => `restart:${prompt}`,
    });
    await deps.authService.seedAdmin();
    const app = createApp(deps);
    const restartedApi = apiClient(app, (await loginAdmin(app)).cookie);
    expect(await (await restartedApi.get("/api/hmr/workflows")).json()).toMatchObject({
      workflows: [{ id: "count", rev: 1 }],
    });
    expect(
      await (await restartedApi.post("/api/hmr/workflows/count/run", { input: { by: 1 } })).json(),
    ).toEqual({
      result: { count: 8, agent: null },
    });

    deps.hmr.dispose();
    deps.channels.dispose();
    deps.db.close();
  });

  it("installs and serves workflow UI assets with scoped SPA fallback and MIME types", async () => {
    const installed = await api.post("/api/hmr/workflows", {
      id: "a",
      script: COUNTER_V1,
      ui: UI_V1,
    });
    expect(installed.status).toBe(201);
    const summary = (await installed.json()) as { uiRev: string };
    expect(summary.uiRev).toMatch(/^[0-9a-f]{12}$/);

    const index = await t.app.request("/workflow/a/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain("ui-one");
    const js = await t.app.request("/workflow/a/assets/app.js");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toContain("console.log");
    expect(await (await t.app.request("/workflow/a/client/route")).text()).toContain("ui-one");

    await api.post("/api/hmr/workflows", { id: "b", script: COUNTER_V1 });
    expect((await t.app.request("/workflow/b/")).status).toBe(404);
    expect((await t.app.request("/workflow/c/")).status).toBe(404);
  });

  it("rejects workflow UI without index.html and unsafe paths", async () => {
    const missing = await api.post("/api/hmr/workflows", {
      id: "missing",
      script: COUNTER_V1,
      ui: { files: { "app.js": b64("x") } },
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toContain(
      "no index.html",
    );

    const unsafe = await api.post("/api/hmr/workflows", {
      id: "unsafe",
      script: COUNTER_V1,
      ui: { files: { "index.html": b64("ok"), "../escape.js": b64("x") } },
    });
    expect(unsafe.status).toBe(400);
    expect(((await unsafe.json()) as { error: { message: string } }).error.message).toContain(
      "unsafe path",
    );
  });

  it("supports gzip payloads, switches current UI, and broadcasts only changed revs", async () => {
    const events: unknown[] = [];
    const dispose = t.deps.channels
      .get("user:workflow-ui-test")
      .subscribe((event) => events.push(JSON.parse(event.data)));
    const installPayload = { id: "a", script: COUNTER_V1, ui: UI_V1 };
    const install = await t.app.request("/api/hmr/workflows", {
      method: "POST",
      headers: { cookie: (await loginAdmin(t.app)).cookie, "content-type": "application/gzip" },
      body: zlib.gzipSync(Buffer.from(JSON.stringify(installPayload))),
    });
    expect(install.status).toBe(201);
    const firstRev = ((await install.json()) as { uiRev: string }).uiRev;
    expect(events).toEqual([{ type: "workflow_ui_updated", id: "a", rev: firstRev }]);

    const same = await api.post("/api/hmr/workflows/a/reload", { script: COUNTER_V2, ui: UI_V1 });
    expect(((await same.json()) as { uiRev: string }).uiRev).toBe(firstRev);
    expect(events).toHaveLength(1);

    const changed = await api.post("/api/hmr/workflows/a/reload", {
      script: COUNTER_V1,
      ui: UI_V2,
    });
    const nextRev = ((await changed.json()) as { uiRev: string }).uiRev;
    expect(nextRev).not.toBe(firstRev);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: "workflow_ui_updated", id: "a", rev: nextRev });
    expect(await (await t.app.request("/workflow/a/")).text()).toContain("ui-two");
    expect(await (await t.app.request("/workflow/a/assets/app.js")).text()).toContain("ui-two");
    dispose();
  });

  it("keeps two UI artifacts per workflow and restores serving after restart", async () => {
    await api.post("/api/hmr/workflows", { id: "a", script: COUNTER_V1, ui: UI_V1 });
    await api.post("/api/hmr/workflows/a/reload", { script: COUNTER_V1, ui: UI_V2 });
    const ui3 = { files: { "index.html": b64("<html>ui-three</html>") } };
    await api.post("/api/hmr/workflows/a/reload", { script: COUNTER_V1, ui: ui3 });
    const manifest = JSON.parse(
      await fs.readFile(path.join(t.root, "hmr", "harness.json"), "utf8"),
    ) as {
      workflowUi: { a: { artifact: string } };
    };
    const artifacts = await fs.readdir(
      path.dirname(path.join(t.root, "hmr", manifest.workflowUi.a.artifact)),
    );
    expect(artifacts.filter((name) => name.endsWith(".webz"))).toHaveLength(2);

    t.deps.hmr.dispose();
    const deps = buildAppDeps(testConfig(t.root), { log: () => {} });
    await deps.authService.seedAdmin();
    const app = createApp(deps);
    expect(await (await app.request("/workflow/a/")).text()).toContain("ui-three");
    deps.hmr.dispose();
    deps.channels.dispose();
    deps.db.close();
  });
});

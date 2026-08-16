/**
 * Business-platform proof: terminals surviving a hot swap via resource claiming,
 * exercised through the repo's own packaged platform (not the standalone fixture
 * bundle).
 *
 * The dispatch-equivalence case that used to live here went with POST
 * /api/hmr/platform/call: a business API is no longer reached by method name through
 * an RPC envelope but served by the platform itself over the HTTP seam
 * (src/hmr/http-seam.ts), and /terminals* is the last business surface still wired
 * into the runtime's own routes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { apiClient, createTestApp, loginAdmin } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const NEXT_BUNDLE_FILE = fileURLToPath(
  new URL("./fixtures/platform-next.bundle.mjs", import.meta.url),
);

/** The smallest valid web manifest a merged push accepts (see hmr.test.ts's minimalWeb). */
/** The cli artifact is never imported by the server, only content-addressed — see hmr.test.ts. */
const MINIMAL_CLI = "export async function cli(argv) { return 0; }\n";

const MINIMAL_WEB = {
  "index.html": Buffer.from("<html>business</html>").toString("base64"),
};

/** Polls until fn() is truthy (live child processes emit output asynchronously). */
async function until(fn: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("hot update: business platform (terminals)", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let cookie: string;
  let nextBundle: string;

  beforeEach(async () => {
    t = await createTestApp();
    const admin = await loginAdmin(t.app);
    cookie = admin.cookie;
    api = apiClient(t.app, admin.cookie);
    nextBundle = await fs.readFile(NEXT_BUNDLE_FILE, "utf8");
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("pushing the next build as inline bytes migrates the platform; terminals survive", async () => {
    // A `cat` terminal echoes stdin: live proof the same process spans the swap.
    const created = await api.post("/api/hmr/terminals", { command: "cat" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    await api.post(`/api/hmr/terminals/${id}/input`, { data: "before-upgrade\n" });
    await until(async () => {
      const r = await api.get(`/api/hmr/terminals/${id}`);
      return ((await r.json()) as { output: string }).output.includes("before-upgrade");
    });

    // The bundle bytes travel in the request body — exactly what a remote /
    // HTTP-only runtime receives; the optional git specifier is provenance
    // only (echoed, never executed). One atomic version: the web dist rides
    // in the same merged push (see /api/hmr/upgrade in routes.ts).
    const source = { repo: "file:///builds/penguin.git", revision: "deadbeef" };
    const gz = zlib.gzipSync(
      Buffer.from(
        JSON.stringify({
          platform: nextBundle,
          cli: MINIMAL_CLI,
          web: { files: MINIMAL_WEB },
          source,
        }),
      ),
    );
    const upgraded = await t.app.request("/api/hmr/upgrade", {
      method: "POST",
      headers: { cookie, "content-type": "application/gzip" },
      body: gz,
    });
    expect(upgraded.status).toBe(200);
    // The packaged doc is v1; the pushed build is v2 with a 1→2 migrator.
    expect(await upgraded.json()).toEqual({
      status: "ok",
      mode: "migrated",
      impl: "next",
      source,
      web: { rev: expect.any(String) as string },
    });

    const info = (await (await api.get("/api/hmr/platform")).json()) as {
      impl: string;
      info: { impl: string; theme: string };
    };
    expect(info.info.impl).toBe("next");
    expect(info.info.theme).toBe("classic"); // filled by the migrator

    // Same process, buffer intact, still responsive.
    const after = (await (await api.get(`/api/hmr/terminals/${id}`)).json()) as {
      output: string;
      alive: boolean;
      lost: boolean;
    };
    expect(after.alive).toBe(true);
    expect(after.lost).toBe(false);
    expect(after.output).toContain("before-upgrade");

    await api.post(`/api/hmr/terminals/${id}/input`, { data: "after-upgrade\n" });
    await until(async () => {
      const r = await api.get(`/api/hmr/terminals/${id}`);
      return ((await r.json()) as { output: string }).output.includes("after-upgrade");
    });
  });
});

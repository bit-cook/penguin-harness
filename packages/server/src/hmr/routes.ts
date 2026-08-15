/**
 * /api/hmr/*: the hot-update surface.
 *
 * The gate middleware is the runtime half of the stop-the-world protocol:
 * requests arriving during a swap are ENQUEUED on the host's operation queue
 * (awaiting waitIdle), never rejected — a client only ever observes latency,
 * not the freeze. The routes are runtime code: they orchestrate through the
 * platform api, so they survive impl swaps unchanged.
 *
 * RUNTIME LAYER — MECHANISM ONLY (see ./README.md). A new business API must NOT
 * become a route here. It is served by the platform itself, through the HTTP
 * seam (../hmr/http-seam.ts) that offers every request to the booted platform
 * before the runtime's own routes see it — a real route with its own path,
 * verb and status, rather than an RPC envelope clients would have to learn.
 *
 * What remains here is the upgrade channel and the status it needs, which is
 * the one thing the platform is never offered: it is how a broken platform
 * gets replaced.
 */
import zlib from "node:zlib";
import { Hono } from "hono";
import type { Json } from "@prismshadow/penguin-core/kernel";
import { ifaceData } from "@prismshadow/penguin-core/kernel";
import type { AppDeps } from "../app.js";
import { authMiddleware } from "../auth/middleware.js";
import type { AppEnv } from "../auth/middleware.js";
import { HttpError } from "../http/errors.js";
import type { ShellProcResource } from "./resources.js";

/** Bind addresses considered safe by default; anything else needs HTTPS. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function hmrRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const hmr = deps.hmr;
  // Mounted BEFORE the global cookie-auth middleware (see app.ts): this gate
  // does its own auth (admin cookie only — see the network gate above for the
  // other half) rather than relying on the generic middleware being mounted
  // later.
  const cookieAuth = authMiddleware(deps.authService);

  routes.use("*", async (c, next) => {
    // Dangerous-network off: hot APIs load and run code, so on a non-loopback
    // bind (e.g. 0.0.0.0) without HTTPS they answer 403. There is no override.
    if (!LOOPBACK_HOSTS.has(deps.config.host.toLowerCase())) {
      const proto =
        c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
      if (proto !== "https") {
        throw new HttpError(
          403,
          "hmr_disabled",
          "Hot platform APIs are disabled on a non-loopback bind without HTTPS. " +
            "Serve over HTTPS to enable them.",
        );
      }
    }
    const gated = async (): Promise<void> => {
      // The upgrade endpoint enqueues internally; everything else waits out
      // any in-flight swap here (unobservable freeze: latency, not errors).
      if (!c.req.path.endsWith("/upgrade")) await hmr.waitIdle();
      await next();
    };
    // Admin cookie session only. There used to be a second credential here — a
    // per-boot Bearer token published to $PENGUIN_HOME/hmr/api.json — for local
    // tools to call in without a browser session. It was removed: it ran as
    // plaintext on disk, readable by anything running as the same OS user
    // (including an agent's own shell/exec tools, which inherit that user and
    // PENGUIN_HOME), and it was admin-equivalent — making it the single
    // plaintext admin-equivalent secret on disk, i.e. the vulnerability itself.
    // Session tokens and passwords are hashed at rest (auth/service.ts); a local
    // caller now authenticates the same way an operator does: log in with the
    // admin password and present the resulting cookie.
    return cookieAuth(c, async () => {
      if (!c.get("user").isAdmin) {
        throw new HttpError(403, "forbidden", "Hot platform APIs are admin-only.");
      }
      await gated();
    });
  });

  // -- Platform ------------------------------------------------------------

  routes.get("/platform", async (c) => {
    const inst = await hmr.ensure();
    return c.json({
      impl: hmr.currentImplId(),
      iface: ifaceData(inst.iface),
      info: inst.api.info(),
    });
  });

  /** Observability: the current parked document (what an upgrade would carry). */
  routes.get("/platform/park", async (c) => {
    const inst = await hmr.ensure();
    return c.json(inst.park());
  });

  /**
   * THE ONE upgrade endpoint: platform + cli + web move together, atomically —
   * there is no route that updates any of the three alone (see host.ts's module
   * doc). Content-Type application/gzip or application/octet-stream; the raw body
   * is gzip(JSON.stringify({ platform, cli, web: { files }, source? })):
   * - `platform` — the platform's single-file JS ESM source, inline (works over
   *   HTTP alone, remote runtimes included); it must export `hotPlatform`.
   * - `cli` — the CLI's own single-file JS ESM source, inline, a SEPARATE
   *   artifact from `platform`; the server never imports or runs it, only
   *   content-addresses it into the store for packages/cli's own loader.
   * - `web.files` — a { relPath: base64 } manifest of the built web dist.
   * - `source?` — optional provenance (repo + revision), recorded but not run.
   * The server boots the platform AND installs the web dist in memory first;
   * only once BOTH succeed does it persist the version — platform, cli, and web
   * together (one atomic harness.json rename — see host.ts's persistVersion). A
   * boot failure or a bad web manifest leaves the previously committed version
   * untouched.
   */
  routes.post("/upgrade", async (c) => {
    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== "application/gzip" && contentType !== "application/octet-stream") {
      throw new HttpError(
        400,
        "bad_request",
        "expected a gzip(JSON.stringify({ platform, cli, web })) body " +
          "(Content-Type application/gzip or application/octet-stream)",
      );
    }
    let payload: {
      platform?: string;
      cli?: string;
      web?: { files?: Record<string, string> };
      source?: { repo: string; revision: string };
    };
    try {
      const gz = Buffer.from(await c.req.arrayBuffer());
      payload = JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
    } catch (err) {
      throw new HttpError(
        400,
        "bad_request",
        `invalid gzip upgrade payload: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof payload.platform !== "string") {
      throw new HttpError(400, "bad_request", "payload has no `platform` (string)");
    }
    if (typeof payload.cli !== "string") {
      throw new HttpError(400, "bad_request", "payload has no `cli` (string)");
    }
    if (typeof payload.web?.files !== "object" || payload.web.files === null) {
      throw new HttpError(
        400,
        "bad_request",
        "payload has no `web.files` (a { relPath: base64 } map)",
      );
    }
    let outcome;
    try {
      outcome = await hmr.upgradeAll({
        platform: payload.platform,
        cli: payload.cli,
        web: payload.web.files,
        ...(payload.source ? { source: payload.source } : {}),
      });
    } catch (err) {
      throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
    }
    // Live clients (browser tabs AND the desktop window) reload to pick up the
    // new web assets once a version actually lands.
    if (outcome.status === "ok") {
      deps.channels.broadcast(
        "user:",
        { type: "web_updated", rev: outcome.web.rev },
        "server_event",
      );
    }
    // Blocked is a first-class outcome, not an HTTP error: the body carries
    // status + the dropped/missing/invalid paths (input for the upper
    // upgrade-ladder rungs), so clients keep one parsing path.
    return c.json(outcome);
  });


  // -- Workflows -----------------------------------------------------------

  routes.post("/workflows", async (c) => {
    const body = await workflowPayload(c);
    validateWorkflowPayload(body);
    try {
      const id = `${body.agentId}/${body.workflowId ?? body.id}`;
      const previousRev = (await deps.workflows.list()).find(
        (workflow) => workflow.id === id,
      )?.uiRev;
      const summary = await deps.workflows.install({
        projectId: body.projectId!,
        agentId: body.agentId!,
        workflowId: body.workflowId ?? body.id!,
        script: body.script!,
        ...(body.ui ? { ui: body.ui } : {}),
      });
      if (summary?.uiRev && summary.uiRev !== previousRev) {
        deps.channels.broadcast(
          "user:",
          { type: "workflow_ui_updated", id: summary.id, rev: summary.uiRev },
          "server_event",
        );
      }
      return c.json(summary ?? { installed: true, active: false }, 201);
    } catch (err) {
      throw workflowHttpError(err);
    }
  });

  routes.get("/workflows", async (c) => {
    return c.json({ workflows: await deps.workflows.list() });
  });

  routes.post("/workflows/:id/reload", async (c) => {
    const body = await workflowPayload(c);
    body.id ??= c.req.param("id");
    validateWorkflowPayload(body);
    try {
      const id = `${body.agentId}/${body.workflowId ?? body.id}`;
      const previousRev = (await deps.workflows.list()).find(
        (workflow) => workflow.id === id,
      )?.uiRev;
      const summary = await deps.workflows.install({
        projectId: body.projectId!,
        agentId: body.agentId!,
        workflowId: body.workflowId ?? body.id!,
        script: body.script!,
        ...(body.ui ? { ui: body.ui } : {}),
      });
      if (summary?.uiRev && summary.uiRev !== previousRev) {
        deps.channels.broadcast(
          "user:",
          { type: "workflow_ui_updated", id: summary.id, rev: summary.uiRev },
          "server_event",
        );
      }
      return c.json(summary ?? { installed: true, active: false });
    } catch (err) {
      throw workflowHttpError(err);
    }
  });

  routes.delete("/workflows/:id", async (c) => {
    const body = await c.req.json<{ projectId?: string; agentId?: string; workflowId?: string }>();
    if (!body.projectId || !body.agentId)
      throw new HttpError(400, "bad_request", "provide projectId and agentId");
    await deps.workflows.remove(body.projectId, body.agentId, body.workflowId ?? c.req.param("id"));
    return c.json({ ok: true });
  });

  routes.post("/workflows/:id/run", async (c) => {
    const body = await c.req.json<{ input?: unknown }>();
    const id = c.req.param("id");
    const result = await hmr.mutate(async (inst) => {
      const workflow = inst.api.workflows().get(id);
      if (workflow === undefined) throw new HttpError(404, "not_found", "No such workflow.");
      return await workflow.run(body.input ?? null);
    }, false);
    return c.json({ result: toJson(result) });
  });

  // -- Terminals: the live-state proof that a resource survives a platform swap.
  // These are the last business routes left in the runtime. A NEW business API does
  // not grow another one here — it is served by the platform itself through the HTTP
  // seam (./http-seam.ts), and these are due to move there too.

  routes.post("/terminals", async (c) => {
    const body = await c.req.json<{ command?: string; cwd?: string }>();
    const inst = await hmr.ensure();
    const created = await inst.api.createTerminal(
      body.command ?? "cat",
      body.cwd ?? deps.config.root,
    );
    return c.json(created, 201);
  });

  routes.get("/terminals", async (c) => {
    const inst = await hmr.ensure();
    const terminals = inst.api.terminals();
    return c.json({
      terminals: terminals.keys().map((id) => {
        const t = terminals.get(id)!;
        return { id, alive: t.alive(), lost: t.lost() };
      }),
    });
  });

  routes.get("/terminals/:id", async (c) => {
    const inst = await hmr.ensure();
    const t = inst.api.terminals().get(c.req.param("id"));
    if (t === undefined) throw new HttpError(404, "not_found", "No such terminal.");
    return c.json({ output: t.read(), alive: t.alive(), lost: t.lost() });
  });

  routes.post("/terminals/:id/input", async (c) => {
    const body = await c.req.json<{ data: string }>();
    const inst = await hmr.ensure();
    const t = inst.api.terminals().get(c.req.param("id"));
    if (t === undefined) throw new HttpError(404, "not_found", "No such terminal.");
    t.write(body.data);
    return c.json({ ok: true });
  });

  routes.delete("/terminals/:id", async (c) => {
    const id = c.req.param("id");
    const inst = await hmr.ensure();
    const terminals = inst.api.terminals();
    const t = terminals.get(id);
    if (t === undefined) throw new HttpError(404, "not_found", "No such terminal.");
    // Closing a terminal is user intent to end the process: kill and release
    // the runtime resource, then remove the node.
    const procId = (t.park() as { procId?: string }).procId;
    if (procId !== undefined) {
      hmr.resources.claim<ShellProcResource>(procId)?.kill();
      hmr.resources.release(procId);
    }
    terminals.remove(id);
    return c.json({ ok: true });
  });

  return routes;
}

/**
 * JSON.stringify's own notion of "not representable" (function, symbol, a
 * cycle) surfaces as a thrown error, not a silent `undefined` — with one
 * carve-out: a void return (undefined) is a SUCCESSFUL call with no result
 * and maps to null, since the side effect already happened and reporting an
 * error would misread it.
 */
function toJson(value: unknown): Json {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error("result is not JSON-serializable (a function or a symbol)");
  }
  return JSON.parse(text) as Json;
}

function workflowHttpError(err: unknown): Error {
  if (err instanceof HttpError) return err;
  if (err instanceof Error) {
    return new HttpError(400, "bad_request", err.message);
  }
  return new HttpError(400, "bad_request", String(err));
}

type WorkflowPayload = {
  projectId?: string;
  agentId?: string;
  workflowId?: string;
  id?: string;
  script?: string;
  ui?: { files: Record<string, string> };
};

function validateWorkflowPayload(body: WorkflowPayload): void {
  if (!body.projectId || !body.agentId || !(body.workflowId ?? body.id)) {
    throw new HttpError(400, "bad_request", "provide projectId, agentId, and workflowId");
  }
  if (typeof body.script !== "string")
    throw new HttpError(400, "bad_request", "provide `script` (string)");
}

async function workflowPayload(c: {
  req: {
    header(name: string): string | undefined;
    arrayBuffer(): Promise<ArrayBuffer>;
    json<T>(): Promise<T>;
  };
}): Promise<WorkflowPayload> {
  const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  try {
    const body =
      contentType === "application/gzip" || contentType === "application/octet-stream"
        ? (JSON.parse(
            zlib.gunzipSync(Buffer.from(await c.req.arrayBuffer())).toString("utf8"),
          ) as WorkflowPayload)
        : await c.req.json<WorkflowPayload>();
    if (
      body.ui !== undefined &&
      (typeof body.ui !== "object" ||
        body.ui === null ||
        typeof body.ui.files !== "object" ||
        body.ui.files === null ||
        Array.isArray(body.ui.files))
    ) {
      throw new Error("`ui.files` must be an object");
    }
    return body;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
  }
}

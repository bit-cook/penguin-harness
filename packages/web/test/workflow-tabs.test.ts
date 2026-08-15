import { describe, expect, it } from "vitest";
import { retainedTab, workflowTabsFromResponse } from "../src/lib/workflow-tabs";

describe("workflow tabs", () => {
  it("includes only workflows with UI summaries while Chat remains independent", () => {
    expect(
      workflowTabsFromResponse({
        workflows: [
          { id: "with-ui", name: "Dashboard", uiRev: "abc123" },
          { id: "script-only", name: "Worker", uiRev: null },
        ],
      }),
    ).toEqual([{ id: "with-ui", name: "Dashboard", uiRev: "abc123" }]);
    expect(retainedTab("chat", [])).toBe("chat");
  });

  it("falls back to Chat when the active workflow disappears", () => {
    const workflows = [{ id: "remaining", name: "Remaining", uiRev: "rev2" }];
    expect(retainedTab("removed", workflows)).toBe("chat");
    expect(retainedTab("remaining", workflows)).toBe("remaining");
  });
});

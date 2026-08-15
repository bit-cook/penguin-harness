export interface WorkflowTab {
  id: string;
  name: string;
  uiRev: string;
}

export const WORKFLOW_UI_UPDATED_EVENT = "penguin:workflow-ui-updated";

export function workflowTabsFromResponse(value: unknown): WorkflowTab[] {
  if (typeof value !== "object" || value === null || !("workflows" in value)) return [];
  const workflows = (value as { workflows?: unknown }).workflows;
  if (!Array.isArray(workflows)) return [];
  return workflows.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as { id?: unknown; name?: unknown; uiRev?: unknown };
    return typeof row.id === "string" &&
      typeof row.name === "string" &&
      typeof row.uiRev === "string" &&
      row.uiRev.length > 0
      ? [{ id: row.id, name: row.name, uiRev: row.uiRev }]
      : [];
  });
}

export function retainedTab(active: string, workflows: readonly WorkflowTab[]): string {
  if (active === "chat") return "chat";
  return workflows.some((workflow) => workflow.id === active) ? active : "chat";
}

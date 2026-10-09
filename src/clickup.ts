// Podium ClickUp client: thin zero-dep wrapper over https://api.clickup.com/api/v2
// using the personal token header. Pure HTTP — no DB imports, unit-testable.
// The fetch implementation is swappable via globalThis.__podiumFetch
// (the server installs a mock when PODIUM_MOCK_INTEGRATIONS=1).

type FetchImpl = (url: string, init?: any) => Promise<Response>;
const http = (): FetchImpl => (globalThis as any).__podiumFetch || globalThis.fetch;

const CLICKUP_API = "https://api.clickup.com/api/v2";

async function readJson(r: Response): Promise<any> {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _raw: t }; }
}

function needToken(token: string): void {
  if (!token) throw Object.assign(new Error("ClickUp is not connected — add a personal token in Settings"), { status: 400 });
}

export async function clickupReq(token: string, method: string, path: string, body?: Record<string, any>): Promise<any> {
  needToken(token);
  const r = await http()(CLICKUP_API + path, {
    method,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await readJson(r);
  if (!r.ok || j?.err) throw new Error(j?.err || `ClickUp ${path} failed (${r.status})`);
  return j;
}

export interface ClickUpTask {
  id: string;
  name: string;
  status: string;
  status_type: string;
  status_color: string;
  due_date: string | null; // ISO or null
  assignees: { id: string; username: string; email: string }[];
  url: string;
}

function mapTask(t: any): ClickUpTask {
  return {
    id: String(t.id),
    name: t.name || "(untitled)",
    status: t.status?.status || "",
    status_type: t.status?.type || "",
    status_color: t.status?.color || "",
    due_date: t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
    assignees: (t.assignees || []).map((a: any) => ({
      id: String(a.id), username: a.username || "", email: a.email || "",
    })),
    url: t.url || "",
  };
}

/** Verify the token — returns the ClickUp user. */
export async function clickupVerify(token: string): Promise<{ id: string; username: string; email: string }> {
  const j = await clickupReq(token, "GET", "/user");
  const u = j.user || {};
  return { id: String(u.id || ""), username: u.username || "", email: u.email || "" };
}

/** Tasks in a list. */
export async function listTasks(token: string, listId: string): Promise<ClickUpTask[]> {
  if (!listId) throw Object.assign(new Error("No ClickUp list linked — set one on the pod"), { status: 400 });
  const j = await clickupReq(token, "GET", `/list/${encodeURIComponent(listId)}/task`);
  return (j.tasks || []).map(mapTask);
}

/** Create a task in a list. due_date: JS Date | ISO string | null. */
export async function createTask(
  token: string,
  listId: string,
  p: { name: string; description?: string; due_date?: string | null },
): Promise<ClickUpTask> {
  if (!listId) throw Object.assign(new Error("No ClickUp list linked — set one on the pod"), { status: 400 });
  if (!p.name?.trim()) throw Object.assign(new Error("task name is required"), { status: 400 });
  const body: Record<string, any> = { name: p.name.trim() };
  if (p.description?.trim()) body.description = p.description.trim();
  if (p.due_date) {
    const ms = new Date(p.due_date).getTime();
    if (Number.isNaN(ms)) throw Object.assign(new Error("bad due date"), { status: 400 });
    body.due_date = ms;
  }
  const j = await clickupReq(token, "POST", `/list/${encodeURIComponent(listId)}/task`, body);
  return mapTask(j);
}

export interface ClickUpListInfo {
  id: string;
  name: string;
  statuses: { id: string; status: string; type: string; color: string }[];
}

/** List metadata incl. its statuses (needed to resolve the done status). */
export async function getListInfo(token: string, listId: string): Promise<ClickUpListInfo> {
  if (!listId) throw Object.assign(new Error("No ClickUp list linked — set one on the pod"), { status: 400 });
  const j = await clickupReq(token, "GET", `/list/${encodeURIComponent(listId)}`);
  return {
    id: String(j.id),
    name: j.name || "",
    statuses: (j.statuses || []).map((s: any) => ({
      id: String(s.id), status: s.status || "", type: s.type || "", color: s.color || "",
    })),
  };
}

/**
 * Close a task: resolves the list's done/closed status, then PUTs the task
 * to that status. Clean error when the list has no done-type status.
 */
export async function closeTask(token: string, taskId: string, listId: string): Promise<ClickUpTask> {
  const info = await getListInfo(token, listId);
  const done = info.statuses.find((s) => s.type === "done" || s.type === "closed");
  if (!done) {
    throw Object.assign(
      new Error(`ClickUp list "${info.name || listId}" has no done/closed status to move tasks to`),
      { status: 400 },
    );
  }
  const j = await clickupReq(token, "PUT", `/task/${encodeURIComponent(taskId)}`, { status: done.status });
  return mapTask(j);
}

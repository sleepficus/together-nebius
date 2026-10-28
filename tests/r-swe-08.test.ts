// Unit evidence for lane r-swe-08: the Overview stat strip derives from the
// canonical metrics() basis, presence requires an authenticated heartbeat,
// "Changes combined" counts confirmed landings only, "Commits received"
// stays unknown without observation events, and the needs-attention stat
// opens only the records it counts. Same fixtures fail on the frozen
// Pages.tsx and pass on the repaired one.
// Runs with: node --import tsx --test tests/r-swe-08.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { register } from "node:module";
import { createState } from "../lib/core.ts";
import type { Event, ProjectState } from "../lib/types.ts";
import type { UIController, UISelection } from "../src/ui/Shell.tsx";

// Same .css stub the existing pages tests register for the Node loader.
register(`data:text/javascript,${
  encodeURIComponent(
    "export async function load(url, context, nextLoad) {" +
    "if (url.endsWith(\".css\")) {" +
    "return { format: \"module\", source: \"export default {};\", shortCircuit: true };" +
    "} return nextLoad(url, context); }")
}`);
const { OverviewPage, CrewPage } = await import("../src/pages/Pages.tsx");

const t0 = "2026-10-04T08:00:00.000Z";
const freshIso = () => new Date(Date.now() - 30 * 1000).toISOString();
const staleIso = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

const base = { projectId: "p1", revision: 1, createdAt: t0, updatedAt: t0, actorId: "owner-1" };
const rec = <T extends object>(id: string, body: T) => ({ id, ...base, ...body });

let evSeq = 0;
const ev = (type: string, detail: Record<string, unknown>, at?: string): Event => ({
  id: `ev-${++evSeq}`, projectId: "p1", seq: evSeq,
  createdAt: at ?? freshIso(), actorId: "sample-system", actorKind: "system",
  type, detail,
});

function makeState(): ProjectState {
  const state = createState({ id: "p1", goal: "Lane fixture", mode: "sample", now: t0 });
  state.identities["wren"] = rec("wren", { displayName: "Wren", ownerId: "owner-1", creationSource: "owner", status: "active" as const });
  state.members["m-wren"] = rec("m-wren", { identityId: "wren", kind: "core" as const, scopes: [] });
  state.tasks["t1"] = rec("t1", {
    goal: "Owned task", acceptanceCriteria: ["x"], dependencies: [],
    lifecycle: "in-progress" as const, currentAssignmentId: "a1", resultRefs: [],
  });
  state.assignments["a1"] = rec("a1", {
    taskId: "t1", identityId: "wren", sessionId: "s1", role: "builder",
    scopes: [], epoch: 1, leaseExpiresAt: t0, maxUntil: t0, status: "active" as const,
  });
  return state;
}

function addSession(state: ProjectState, source: string, at = freshIso()) {
  state.sessions["s1"] = rec("s1", {
    identityId: "wren", adapter: "sample-cli",
    advertisedCapabilities: [], observedCapabilities: [],
    lastActivityAt: at, lastActivitySource: source, status: "active" as const,
  });
}

function makeController(state: ProjectState) {
  const calls: { type: string; payload: unknown }[] = [];
  const nav: string[] = [];
  const sels: (UISelection | null)[] = [];
  const controller: UIController = {
    state,
    mode: state.project.mode,
    action: async (type: string, payload?: unknown) => {
      calls.push({ type, payload });
      return null;
    },
    projects: [state],
    activeProjectId: state.project.id,
    selectProject: () => {},
    error: null,
    clearError: () => {},
  };
  const props = {
    controller, selection: null as UISelection | null,
    onSelect: (s: UISelection | null) => sels.push(s),
    onNavigate: (p: string) => nav.push(p),
  };
  return { props, calls, nav, sels };
}

function statPair(html: string, label: string): string | null {
  const re = new RegExp(
    `stat-value">([^<]*)</span><span class="stat-label">${label}[^<]*</span>`);
  const m = html.match(re);
  return m ? m[1] : null;
}

/* ---------- Working requires an authenticated heartbeat ---------- */

test("Working now stays Assigned when only non-heartbeat activity is fresh", () => {
  const state = makeState();
  addSession(state, "enrollment-exchange");
  const { props } = makeController(state);
  const html = renderToStaticMarkup(createElement(OverviewPage, props));
  assert.equal(statPair(html, "Assigned"), "1",
    "assignment with fresh non-heartbeat activity reports Assigned, not Working");
  assert.equal(statPair(html, "Working now"), null);
});

test("Working now counts a fresh runner-heartbeat session and a job/event beat", () => {
  const state = makeState();
  addSession(state, "runner heartbeat");
  let html = renderToStaticMarkup(createElement(OverviewPage, makeController(state).props));
  assert.equal(statPair(html, "Working now"), "1");

  // No session beat at all, but a fresh heartbeat event names the assignment.
  const state2 = makeState();
  state2.assignments["a1"].sessionId = undefined;
  state2.events.push(ev("check:heartbeat", { assignmentId: "a1" }));
  html = renderToStaticMarkup(createElement(OverviewPage, makeController(state2).props));
  assert.equal(statPair(html, "Working now"), "1");
});

/* ---------- confirmed integration units ---------- */

test("Changes combined ignores imported/uncorroborated integrated statuses", () => {
  const state = makeState();
  // Restore-trust shape: status flags claim integration with zero confirmed
  // operations and zero confirmation events.
  state.proposals["p-1"] = rec("p-1", {
    taskIds: [], authorId: "wren", base: "aaaa1111", head: "bbbb2222",
    summary: "imported", intendedBehavior: "x", changedPaths: [], evidenceRefs: [], unknowns: [],
    lifecycle: "integrated" as const,
  });
  state.candidates["c-1"] = rec("c-1", {
    base: "aaaa1111", proposalIds: ["p-1"], proposalHeads: { "p-1": "bbbb2222" },
    sha: "cccc3333", policyVersion: 1, status: "integrated" as const,
    checkJobIds: [], reviewIds: [],
  });
  const html = renderToStaticMarkup(createElement(OverviewPage, makeController(state).props));
  assert.equal(statPair(html, "Changes combined"), "0",
    "status flags without confirmed evidence contribute nothing");

  // A confirmation event is the unit that counts.
  state.events.push(ev("integration:confirmed", {
    operationId: "op-1", candidateSha: "cccc3333", newLanding: true,
  }));
  const html2 = renderToStaticMarkup(createElement(OverviewPage, makeController(state).props));
  assert.equal(statPair(html2, "Changes combined"), "1");
});

/* ---------- Commits received: zero vs unknown ---------- */

test("Commits received shows unknown, not an invented count, without observation events", () => {
  const state = makeState();
  state.proposals["p-1"] = rec("p-1", {
    taskIds: [], authorId: "wren", base: "aaaa1111", head: "bbbb2222",
    summary: "submitted", intendedBehavior: "x", changedPaths: [], evidenceRefs: [], unknowns: [],
    lifecycle: "submitted" as const,
  });
  let html = renderToStaticMarkup(createElement(OverviewPage, makeController(state).props));
  assert.equal(statPair(html, "Commits received"), "unknown",
    "proposal heads are not observed commits; the metric stays unknown");

  state.events.push(ev("commit:observed", { sha: "bbbb2222", role: "fork" }));
  html = renderToStaticMarkup(createElement(OverviewPage, makeController(state).props));
  assert.equal(statPair(html, "Commits received"), "1");
});

/* ---------- needs-attention count opens only the records it counts ---------- */

async function withDom(run: () => Promise<void>): Promise<void> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { url: "http://localhost/" });
  const saved = {
    window: globalThis.window, document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const put = (key: "window" | "document" | "navigator", value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  put("window", dom.window);
  put("document", dom.window.document);
  put("navigator", dom.window.navigator);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await run();
  } finally {
    put("window", saved.window);
    put("document", saved.document);
    put("navigator", saved.navigator);
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
  }
}

const click = (el: Element) =>
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

test("Needs help stat opens a counted record, never an unrelated blocker", async () => {
  const state = makeState();
  state.help["h1"] = rec("h1", {
    taskId: "t1", question: "pair?", offeredById: "wren", state: "offered" as const,
  });
  // A ready candidate is a named blocker but is NOT a needs-attention record.
  state.candidates["c-ready"] = rec("c-ready", {
    base: "aaaa1111", proposalIds: [], proposalHeads: {},
    sha: "dddd4444", policyVersion: 1, status: "ready" as const,
    checkJobIds: [], reviewIds: [],
  });
  const { props, sels } = makeController(state);
  await withDom(async () => {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("root")!);
    await act(async () => { root.render(createElement(OverviewPage, props)); });
    const stat = [...document.querySelectorAll("button.stat")]
      .find((b) => b.textContent!.includes("Needs help"))!;
    assert.ok(stat, "needs-attention stat exists");
    assert.ok(stat.textContent!.includes("1"), "counts only the open help record");
    await act(async () => { click(stat); });
    assert.deepEqual(sels[0], { kind: "help", id: "h1" },
      "the count opens a record it actually counts");
    await act(async () => { root.unmount(); });
  });
});

test("Needs help stat is inert at zero even when other blockers exist", async () => {
  const state = makeState();
  state.candidates["c-ready"] = rec("c-ready", {
    base: "aaaa1111", proposalIds: [], proposalHeads: {},
    sha: "dddd4444", policyVersion: 1, status: "ready" as const,
    checkJobIds: [], reviewIds: [],
  });
  const { props, sels } = makeController(state);
  await withDom(async () => {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("root")!);
    await act(async () => { root.render(createElement(OverviewPage, props)); });
    const stat = [...document.querySelectorAll(".stat")]
      .find((el) => el.textContent!.includes("Needs help"))!;
    assert.equal(stat.tagName, "DIV",
      "zero needs-attention records renders an inert stat, not a clickable button");
    click(stat);
    assert.equal(sels.length, 0);
    await act(async () => { root.unmount(); });
  });
});

/* ---------- human actions: windowed, categorized ---------- */

test("Human actions counts only categorized events inside the window", () => {
  const state = makeState();
  state.events.push({
    id: "ev-old", projectId: "p1", seq: 1, createdAt: staleIso(),
    actorId: "owner-1", actorKind: "human", type: "operation:tasks:write",
    humanCategory: "approve",
  });
  let html = renderToStaticMarkup(createElement(OverviewPage, makeController(state).props));
  assert.equal(statPair(html, "Human actions"), "0",
    "a categorized event outside the 10-minute window is not counted");

  state.events.push({
    id: "ev-new", projectId: "p1", seq: 2, createdAt: freshIso(),
    actorId: "owner-1", actorKind: "human", type: "operation:tasks:write",
    humanCategory: "relay",
  });
  html = renderToStaticMarkup(createElement(OverviewPage, makeController(state).props));
  assert.equal(statPair(html, "Human actions"), "1");
  assert.ok(html.includes("last 10 min"), "window is labeled");
});

/* ---------- crew presence follows the same heartbeat rule ---------- */

test("Crew presence pill requires a heartbeat, not bare recent activity", () => {
  const state = makeState();
  addSession(state, "sample-review");
  let html = renderToStaticMarkup(createElement(CrewPage, makeController(state).props));
  assert.ok(html.includes("Assigned · sample"),
    "fresh non-heartbeat activity never reports Working");
  assert.ok(!html.includes("Working · sample"));

  addSession(state, "sample-heartbeat");
  html = renderToStaticMarkup(createElement(CrewPage, makeController(state).props));
  assert.ok(html.includes("Working · sample"),
    "an explicit sample heartbeat reports Working, labeled sample");
});

test("Crew session facts never claim Running observed without a heartbeat", () => {
  const state = makeState();
  addSession(state, "enrollment-exchange");
  const html = renderToStaticMarkup(createElement(CrewPage, makeController(state).props));
  assert.ok(!html.includes("Running observed"),
    "non-heartbeat freshness cannot produce a Running observed claim");
  assert.ok(html.includes("no recent heartbeat"));
});

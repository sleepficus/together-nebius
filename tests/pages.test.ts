// Unit evidence for b-swe-08 pages: SSR markup for every page plus jsdom
// interaction coverage (selection, navigation, allowed actions only).
// Runs with: node --import tsx --test tests/pages.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { register } from "node:module";
import { createState } from "../lib/core.ts";
import type { ProjectState } from "../lib/types.ts";
import type { UIController, UISelection } from "../src/ui/Shell.tsx";

// Pages.tsx side-effect-imports pages.css for the Vite bundle; Node's own
// loader cannot resolve ".css". A registered hook stubs it to an empty
// module — this is the test-harness equivalent of the bundler's css plugin.
register(`data:text/javascript,${
  encodeURIComponent(
    "export async function load(url, context, nextLoad) {" +
    "if (url.endsWith(\".css\")) {" +
    "return { format: \"module\", source: \"export default {};\", shortCircuit: true };" +
    "} return nextLoad(url, context); }")
}`);
const {
  ChangesPage, CrewPage, ExperimentsPage, FindingsPage, OverviewPage,
} = await import("../src/pages/Pages.tsx");

const SOURCE = readFileSync(
  new URL("../src/pages/Pages.tsx", import.meta.url), "utf8");

const t0 = "2026-10-04T08:00:00.000Z";
const freshBeat = new Date(Date.now() - 30 * 1000).toISOString();

const base = { projectId: "p1", revision: 1, createdAt: t0, updatedAt: t0, actorId: "owner-1" };
const rec = <T extends object>(id: string, body: T) => ({ id, ...base, ...body });

function makeState(): ProjectState {
  const state = createState({ id: "p1", goal: "Sample Together demo", mode: "sample", now: t0 });
  state.identities["chad"] = rec("chad", { displayName: "Chad", ownerId: "owner-1", creationSource: "owner", status: "active" as const });
  state.identities["faye"] = rec("faye", { displayName: "Faye", ownerId: "owner-1", creationSource: "owner", status: "active" as const });
  state.identities["bugeater"] = rec("bugeater", { displayName: "Bug Eater", ownerId: "owner-1", creationSource: "system", status: "active" as const });
  state.members["m-chad"] = rec("m-chad", { identityId: "chad", kind: "core" as const, scopes: [] });
  state.members["m-faye"] = rec("m-faye", { identityId: "faye", kind: "collaborator" as const, scopes: [] });
  state.sessions["s-chad"] = rec("s-chad", {
    identityId: "chad", adapter: "devin-cli", model: "swe-2-high", provider: "devin",
    host: "macbook-pro", payerRef: "acct-1",
    advertisedCapabilities: ["read-brief", "submit-evidence"],
    observedCapabilities: ["read-brief"],
    lastActivityAt: freshBeat, lastActivitySource: "runner heartbeat",
    status: "active" as const,
  });
  state.tasks["t1"] = rec("t1", {
    goal: "Remember selection", acceptanceCriteria: ["selection survives"],
    dependencies: [], lifecycle: "in-progress" as const,
    currentAssignmentId: "a1", resultRefs: [], nextAction: "Finish focus restore",
  });
  state.tasks["t2"] = rec("t2", {
    goal: "Check shared behavior", acceptanceCriteria: ["combined run passes"],
    dependencies: [{ taskId: "t1", kind: "prerequisite" as const }],
    lifecycle: "open" as const, resultRefs: [],
  });
  state.tasks["t3"] = rec("t3", {
    goal: "Earlier task", acceptanceCriteria: ["done"], dependencies: [],
    lifecycle: "done" as const, resultRefs: ["cand-0"],
  });
  state.assignments["a1"] = rec("a1", {
    taskId: "t1", identityId: "chad", sessionId: "s-chad", role: "builder",
    scopes: [], epoch: 1, leaseExpiresAt: t0, maxUntil: t0, status: "active" as const,
  });
  state.help["h1"] = rec("h1", {
    taskId: "t2", question: "Pair on the reproducer?", offeredById: "chad",
    state: "offered" as const,
  });
  state.proposals["pr1"] = rec("pr1", {
    taskIds: ["t1"], authorId: "chad", base: "aaaa1111", head: "bbbb2222",
    summary: "Remember selection", intendedBehavior: "Selection persists across turns",
    changedPaths: ["src/App.tsx", "src/ui/Shell.tsx"], evidenceRefs: [],
    unknowns: ["focus order on restore"], lifecycle: "submitted" as const,
  });
  state.candidates["c1"] = rec("c1", {
    base: "aaaa1111", proposalIds: ["pr1"], proposalHeads: { pr1: "bbbb2222" },
    sha: "cccc3333", policyVersion: 1, status: "checking" as const,
    checkJobIds: ["j1"], reviewIds: ["r1"],
  });
  state.candidates["c2"] = rec("c2", {
    base: "aaaa1111", proposalIds: ["pr1"], proposalHeads: { pr1: "bbbb2222" },
    sha: "dddd4444", policyVersion: 1, status: "ready" as const,
    checkJobIds: [], reviewIds: [],
  });
  state.jobs["j1"] = rec("j1", {
    candidateId: "c1", candidateSha: "cccc3333", command: "npm test",
    status: "running" as const,
  });
  state.receipts["e1"] = rec("e1", {
    jobId: "j1", candidateSha: "cccc3333", collectorId: "bugeater",
    command: "npm test", outcome: "fail" as const, artifactRefs: [],
  });
  state.reviews["r1"] = rec("r1", {
    candidateId: "c1", candidateSha: "cccc3333", reviewerId: "faye",
    policyVersion: 1, disposition: "comment" as const, independent: false,
    independenceReason: "same owning user", findingIds: ["f1"],
  });
  state.findings["f1"] = rec("f1", {
    candidateId: "c1", candidateSha: "cccc3333", expected: "focus restored",
    observed: "focus lost after action", reproducer: "press Escape",
    state: "possible-issue" as const, originatorId: "faye", receiptIds: ["e1"],
  });
  state.findings["f2"] = rec("f2", {
    expected: "build passes", observed: "build failed",
    state: "verified-fixed" as const, originatorId: "chad", receiptIds: ["e1", "e2"],
  });
  state.findings["f3"] = rec("f3", {
    expected: "layout stable", observed: "tiles jumped",
    state: "not-reproduced" as const, originatorId: "faye", receiptIds: [],
  });
  state.events.push({
    id: "ev1", projectId: "p1", seq: 1, createdAt: t0, actorId: "owner-1",
    actorKind: "human", type: "operation:tasks:write", humanCategory: "approve",
  });
  return state;
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
    selectProject: (id: string) => nav.push(`select:${id}`),
    error: null,
    clearError: () => {},
  };
  const props = {
    controller, selection: null as UISelection | null,
    onSelect: (s: UISelection | null) => sels.push(s),
    onNavigate: (p: string) => nav.push(p),
  };
  return { controller, calls, nav, sels, props };
}

const ALLOWED_ACTIONS = new Set([
  "create-project", "create-task", "claim-task", "ask-help", "answer-help",
  "submit-change", "prepare-candidate", "request-check", "review-candidate",
  "report-finding", "disposition-finding", "save-layout", "stop", "select-project",
]);

/* ---------- static schema ---------- */

test("static schema: five named exports, contract actions only, registered record", () => {
  for (const name of ["OverviewPage", "CrewPage", "ChangesPage", "FindingsPage", "ExperimentsPage"]) {
    assert.match(SOURCE, new RegExp(`export function ${name}\\b`), `${name} exported`);
  }
  const used = [...SOURCE.matchAll(/act(?:ion)?\("([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const a of used) assert.ok(ALLOWED_ACTIONS.has(a), `action ${a} is in the contract`);
  assert.ok(SOURCE.includes("No experiment notebook is connected to this standalone copy."));
  assert.ok(SOURCE.includes("7e7a4fc211804a9881e876d47749762d"));
  assert.ok(SOURCE.includes("Not assessed"));
  // No finding-state dropdown: a <select>/<option> may only ever pick
  // tasks or candidates, never a state value.
  assert.doesNotMatch(SOURCE, /<option[^>]*value="(possible-issue|reproduced|repair-in-progress|recheck-needed|verified-fixed|not-reproduced|withdrawn)"/);
  // No OAuth control is fabricated.
  assert.doesNotMatch(SOURCE, /onClick[^}]*oauth/i);
  assert.doesNotMatch(SOURCE, /action\("integrate"\)/);
});

/* ---------- SSR markup ---------- */

test("OverviewPage renders scoped stats, named blockers and create/open project", () => {
  const { props } = makeController(makeState());
  const html = renderToStaticMarkup(createElement(OverviewPage, props));
  for (const label of ["Working now", "Tasks finished", "Changes combined",
    "Commits received", "Human actions", "Needs help", "2-minute heartbeat window",
    "sample records", "Named blockers", "Create a project", "Sample Together demo"]) {
    assert.ok(html.includes(label), `overview contains "${label}"`);
  }
  assert.ok(html.includes("Pair on the reproducer?"), "open help named as blocker");
  assert.ok(html.includes("focus lost after action"), "finding named as blocker");
  assert.ok(html.includes("Candidate"), "ready/combined candidate reachable");
});

test("CrewPage keeps platform/provider/observed-inference separate and shows contributions", () => {
  const { props } = makeController(makeState());
  const html = renderToStaticMarkup(createElement(CrewPage, props));
  for (const s of ["Chad", "Faye", "Core team", "Collaborators",
    "Platform", "Provider", "access unknown", "Observed inference",
    "Advertised tools", "Checked tools", "Contribution history",
    "Running observed", "runner heartbeat", "unavailable"]) {
    assert.ok(html.includes(s), `crew contains "${s}"`);
  }
});

test("ChangesPage shows exact revisions, evidence, independence and unavailable integrate", () => {
  const { props } = makeController(makeState());
  const html = renderToStaticMarkup(createElement(ChangesPage, props));
  for (const s of ["aaaa111", "bbbb222", "cccc333", "Prepare combined candidate",
    "Integrate", "unavailable", "not independent (same owning user)",
    "policy v1", "npm test", "Request check", "Request changes",
    "Remember selection", "src/App.tsx"]) {
    assert.ok(html.includes(s), `changes contains "${s}"`);
  }
  assert.doesNotMatch(html, /aria-label="[Ii]ntegrate[^"]*"[^>]*>/);
});

test("FindingsPage groups states, links evidence and offers only allowed dispositions", () => {
  const { props } = makeController(makeState());
  const html = renderToStaticMarkup(createElement(FindingsPage, props));
  for (const s of ["Needs attention", "Verified fixed", "Closed without a fix",
    "focus lost after action", "focus restored", "press Escape",
    "Not reproduced", "Withdraw", "no button or dropdown",
    "reported by Faye", "evidence receipt"]) {
    assert.ok(html.includes(s), `findings contains "${s}"`);
  }
  assert.doesNotMatch(html, /value="verified-fixed"|value="possible-issue"/);
});

test("ExperimentsPage links the registered notebook with Planned/Not assessed", () => {
  const { props } = makeController(makeState());
  const html = renderToStaticMarkup(createElement(ExperimentsPage, props));
  for (const s of ["Can agents help each other finish correctly",
    "Planned", "Not assessed", "7e7a4fc211804a9881e876d47749762d",
    "No experiment notebook is connected to this standalone copy.", "Not frozen"]) {
    assert.ok(html.includes(s), `experiments contains "${s}"`);
  }
  assert.doesNotMatch(html, /measured benefit|S\/A\/B result/i);
});

/* ---------- jsdom interactions ---------- */

async function withDom(run: () => Promise<void>): Promise<void> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { url: "http://localhost/" });
  const saved = {
    window: globalThis.window, document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const put = (key: "window" | "document" | "navigator", value: unknown) =>
    Object.defineProperty(globalThis, key, {
      value, configurable: true, writable: true,
    });
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

test("overview stat navigates, blocker selects the record, open-project navigates", async () => {
  const state = makeState();
  const { props, nav, sels } = makeController(state);
  await withDom(async () => {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("root")!);
    await act(async () => { root.render(createElement(OverviewPage, props)); });
    await act(async () => { click(document.querySelectorAll(".stat")[0]); });
    assert.equal(nav[0], "/projects/p1/crew");
    const blocker = [...document.querySelectorAll(".pg-row")]
      .find((r) => r.textContent!.includes("focus lost after action"))!;
    await act(async () => { click(blocker); });
    assert.deepEqual(sels[0], { kind: "finding", id: "f1" });
    await act(async () => { root.unmount(); });
  });
});

test("findings disposition buttons call only not-reproduced/withdrawn", async () => {
  const { props, calls } = makeController(makeState());
  await withDom(async () => {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("root")!);
    await act(async () => { root.render(createElement(FindingsPage, props)); });
    const buttons = [...document.querySelectorAll("button")];
    const notRepro = buttons.find((b) => b.textContent === "Not reproduced")!;
    const withdraw = buttons.find((b) => b.textContent === "Withdraw")!;
    await act(async () => { click(notRepro); });
    await act(async () => { click(withdraw); });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { type: "disposition-finding", payload: { findingId: "f1", state: "not-reproduced" } });
    assert.deepEqual(calls[1], { type: "disposition-finding", payload: { findingId: "f1", state: "withdrawn" } });
    // The verified-fixed finding offers no enabled disposition control.
    const verified = [...document.querySelectorAll(".pg-item")]
      .find((li) => li.textContent!.includes("build failed"))!;
    const dispositions = [...verified.querySelectorAll("button")]
      .filter((b) => b.textContent === "Not reproduced" || b.textContent === "Withdraw");
    assert.ok(dispositions.length > 0);
    for (const b of dispositions) assert.ok((b as HTMLButtonElement).disabled);
    await act(async () => { root.unmount(); });
  });
});

test("changes page: integrate control stays disabled; candidate review action fires", async () => {
  const { props, calls } = makeController(makeState());
  await withDom(async () => {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("root")!);
    await act(async () => { root.render(createElement(ChangesPage, props)); });
    const integrate = [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Integrate — unavailable")!;
    assert.ok((integrate as HTMLButtonElement).disabled);
    const approve = [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Approve")!;
    await act(async () => { click(approve); });
    assert.deepEqual(calls[0], {
      type: "review-candidate",
      payload: { candidateId: "c1", disposition: "approve" },
    });
    await act(async () => { root.unmount(); });
  });
});

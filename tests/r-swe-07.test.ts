// Unit evidence for lane r-swe-07: collision-free flow layout, readable
// default viewport, narrow list default with explicit-choice persistence,
// bounded create-task form, six visible routes, Add work compose wiring,
// narrow inspector sheet dismiss/Escape/focus restore, semantic list parity.
// Runs with: node --import tsx --test tests/r-swe-07.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createState } from "../lib/core.ts";
import type {
  AgentIdentity, Candidate, CheckJob, Finding, HelpRequest, Member,
  ProjectState, Proposal, Task,
} from "../lib/types.ts";
import {
  FlowList, NODE_BOX, ProjectView, initialView, initialViewport, layoutGraph,
} from "../src/ui/ProjectView.tsx";
import { Inspector } from "../src/ui/Inspector.tsx";
import { Shell } from "../src/ui/Shell.tsx";
import type { UIController, UISelection } from "../src/ui/Shell.tsx";

const t0 = "2026-10-04T08:00:00.000Z";
const base = { projectId: "p1", revision: 1, createdAt: t0, updatedAt: t0, actorId: "owner-1" };
const rec = <T extends object>(id: string, body: T) => ({ id, ...base, ...body }) as T & { id: string };
const sha = (c: string) => c.repeat(40);

const task = (id: string, deps: Task["dependencies"] = []): Task =>
  rec(id, {
    goal: `Goal ${id}`, acceptanceCriteria: ["crit"], dependencies: deps,
    lifecycle: "open" as const, resultRefs: [],
  }) as unknown as Task;

function makeState(): ProjectState {
  const state = createState({ id: "p1", goal: "Lane seven demo", mode: "sample", now: t0 });
  state.identities["chad"] = rec("chad", {
    displayName: "Chad", ownerId: "o", creationSource: "owner", status: "active" as const,
  }) as unknown as AgentIdentity;
  state.members["m1"] = rec("m1", { identityId: "chad", kind: "core" as const, scopes: [] }) as unknown as Member;
  state.tasks["t1"] = task("t1");
  state.tasks["t2"] = task("t2", [{ taskId: "t1", kind: "prerequisite" }]);
  state.tasks["t3"] = task("t3", [{ taskId: "t2", kind: "prerequisite" }]);
  state.proposals["pr1"] = rec("pr1", {
    taskIds: ["t1"], authorId: "chad", base: sha("b"), head: sha("a"),
    summary: "s", intendedBehavior: "i", changedPaths: ["x.ts"],
    evidenceRefs: [], unknowns: [], lifecycle: "ready-to-combine" as const,
  }) as unknown as Proposal;
  state.candidates["c1"] = rec("c1", {
    base: sha("b"), proposalIds: ["pr1"], proposalHeads: { pr1: sha("a") },
    sha: sha("d"), policyVersion: 1, status: "ready" as const,
    checkJobIds: ["j1", "j2"], reviewIds: [],
  }) as unknown as Candidate;
  state.jobs["j1"] = rec("j1", {
    candidateId: "c1", candidateSha: sha("d"), command: "npm test", status: "completed" as const,
  }) as unknown as CheckJob;
  state.jobs["j2"] = rec("j2", {
    candidateId: "c1", candidateSha: sha("d"), command: "npm run typecheck", status: "running" as const,
  }) as unknown as CheckJob;
  state.help["h1"] = rec("h1", {
    taskId: "t3", question: "look?", offeredById: "chad", state: "offered" as const,
  }) as unknown as HelpRequest;
  state.findings["f1"] = rec("f1", {
    candidateId: "c1", candidateSha: sha("d"), expected: "e", observed: "o",
    state: "possible-issue" as const, originatorId: "chad", receiptIds: [],
  }) as unknown as Finding;
  return state;
}

function makeController(state: ProjectState) {
  const calls: { type: string; payload: unknown }[] = [];
  const controller: UIController = {
    state, mode: "sample",
    async action(type: string, payload?: unknown) {
      calls.push({ type, payload });
      return { ok: true, taskId: "task-new" };
    },
    projects: [state], activeProjectId: "p1",
    selectProject() { /* noop */ }, error: null, clearError() { /* noop */ },
  };
  return { controller, calls };
}

interface FakeMQ {
  matches: boolean; media: string; onchange: null;
  addEventListener(t: string, fn: () => void): void;
  removeEventListener(t: string, fn: () => void): void;
  addListener(fn: () => void): void;
  removeListener(fn: () => void): void;
  dispatchEvent(): boolean;
  fire(m: boolean): void;
}
function mqFor(narrow: boolean): FakeMQ {
  const listeners = new Set<() => void>();
  const mq: FakeMQ = {
    matches: narrow, media: "(max-width: 860px)", onchange: null,
    addEventListener: (_t, fn) => { listeners.add(fn); },
    removeEventListener: (_t, fn) => { listeners.delete(fn); },
    addListener: (fn) => { listeners.add(fn); },
    removeListener: (fn) => { listeners.delete(fn); },
    dispatchEvent: () => true,
    fire(m) { mq.matches = m; for (const fn of [...listeners]) fn(); },
  };
  return mq;
}

const GLOBAL_KEYS = [
  "window", "document", "navigator", "localStorage", "sessionStorage",
  "CustomEvent", "KeyboardEvent", "MouseEvent", "ResizeObserver", "matchMedia",
] as const;

async function withDom(narrow: boolean, run: (ctx: { mq: FakeMQ }) => Promise<void>): Promise<void> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { url: "http://localhost/" });
  const mq = mqFor(narrow);
  const w = dom.window as unknown as Record<string, unknown>;
  w.matchMedia = () => mq;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const saved = new Map<string, unknown>();
  const put = (k: string, v: unknown) => {
    if (!saved.has(k)) saved.set(k, (globalThis as Record<string, unknown>)[k]);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  };
  for (const k of GLOBAL_KEYS) {
    put(k, k === "window" ? dom.window : (w[k] ?? (dom.window as never)[k as never]));
  }
  const savedAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await run({ mq });
  } finally {
    for (const k of [...saved.keys()]) put(k, saved.get(k));
    globalThis.IS_REACT_ACT_ENVIRONMENT = savedAct;
  }
}

const click = (el: Element) =>
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
};

function layoutFixture() {
  const state = makeState();
  const tasks = Object.values(state.tasks);
  const cands = Object.values(state.candidates);
  const jobs = Object.values(state.jobs);
  const help = Object.values(state.help)
    .filter((h) => h.state === "offered" || h.state === "accepted");
  const findings = Object.values(state.findings).filter((f) =>
    ["possible-issue", "reproduced", "recheck-needed", "repair-in-progress"].includes(f.state));
  const propTasks = new Map(Object.values(state.proposals).map((p) => [p.id, p.taskIds]));
  const candTaskIds = new Map<string, string[]>(cands.map((c) =>
    [c.id, [...new Set(c.proposalIds.flatMap((p) => propTasks.get(p) ?? []))]]));
  return { tasks, cands, jobs, help, findings, candTaskIds };
}

test("layoutGraph places every record in a distinct non-overlapping rectangle", () => {
  const { tasks, cands, jobs, help, findings, candTaskIds } = layoutFixture();
  const pos = layoutGraph(tasks, cands, jobs, help, findings, new Map(candTaskIds));
  for (const key of ["task:t1", "task:t2", "task:t3", "cand:c1", "job:j1", "job:j2", "ready:c1", "help:h1", "find:f1"]) {
    assert.ok(pos.has(key), `missing node ${key}`);
  }
  // Two check jobs of one candidate never share a rectangle.
  assert.notDeepEqual(pos.get("job:j1"), pos.get("job:j2"));
  // The candidate shares a column with task t2 (same layer): hint must bump.
  const ids = [...pos.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = pos.get(ids[i])!;
      const b = pos.get(ids[j])!;
      const aw = NODE_BOX[a.variant].w;
      const ah = NODE_BOX[a.variant].h;
      const bw = NODE_BOX[b.variant].w;
      const bh = NODE_BOX[b.variant].h;
      const disjoint = a.x + aw <= b.x || b.x + bw <= a.x || a.y + ah <= b.y || b.y + bh <= a.y;
      assert.ok(disjoint, `overlap: ${ids[i]} vs ${ids[j]}`);
    }
  }
  const again = layoutGraph(tasks, cands, jobs, help, findings, new Map(candTaskIds));
  assert.deepEqual([...pos.entries()], [...again.entries()]);
});

test("two candidates over the same linked task never share a rectangle", () => {
  const tasks = [task("u1")];
  const mkCand = (id: string): Candidate => rec(id, {
    base: sha("b"), proposalIds: ["p"], proposalHeads: { p: sha("a") },
    sha: sha(id === "ca" ? "e" : "f"), policyVersion: 1, status: "prepared" as const,
    checkJobIds: [], reviewIds: [],
  }) as unknown as Candidate;
  const cands = [mkCand("ca"), mkCand("cb")];
  const candTaskIds = new Map<typeof cands[0]["id"], string[]>([["ca", ["u1"]], ["cb", ["u1"]]]);
  const pos = layoutGraph(tasks, cands, [], [], [], candTaskIds);
  const a = pos.get("cand:ca")!;
  const b = pos.get("cand:cb")!;
  assert.notDeepEqual(a, b);
  assert.ok(a.y + NODE_BOX.candidate.h <= b.y || b.y + NODE_BOX.candidate.h <= a.y);
});

test("initialViewport keeps a readable near-1:1 zoom anchored at graph origin", () => {
  const v = initialViewport([{ x: 0, y: 0 }, { x: 690, y: 500 }]);
  assert.ok(v.zoom >= 0.9 && v.zoom <= 1, `zoom ${v.zoom}`);
  assert.ok(Math.abs(v.x - 24) < 1e-9);
  assert.ok(Math.abs(v.y - 20) < 1e-9);
  assert.equal(initialViewport([]).zoom, 0.95);
});

test("initialView: narrow defaults to the list, explicit flow is honored", () => {
  assert.equal(initialView(null, true), "progress");
  assert.equal(initialView("progress", false), "progress");
  assert.equal(initialView("flow", true), "flow");
  assert.equal(initialView(null, false), "flow");
});

test("FlowList text alternative covers findings as well as task/help edges", () => {
  const html = renderToStaticMarkup(createElement(FlowList, { state: makeState(), showDone: true }));
  assert.ok(html.includes("Finding on candidate"));
  assert.ok(html.includes("Help linked to"));
  assert.ok(html.includes("needs first"));
});

test("shell renders all six routes and the Add work control", () => {
  const { controller } = makeController(makeState());
  const html = renderToStaticMarkup(createElement(Shell, {
    controller, route: { name: "overview", projectId: "p1" },
    onNavigate: () => {}, selection: null, onSelect: () => {},
    children: createElement("div"),
  }));
  for (const label of ["Overview", "Work map", "Crew", "Changes", "Findings", "Experiments", "Talk to the crew"]) {
    assert.ok(html.includes(`>${label}<`), `missing nav ${label}`);
  }
  assert.ok(html.includes("Add work"));
});

test("Add work navigates to the project and signals the compose-task form", async () => {
  const { controller } = makeController(makeState());
  await withDom(false, async () => {
    const { createRoot } = await import("react-dom/client");
    const nav: string[] = [];
    let composed = 0;
    window.addEventListener("together:compose-task", () => { composed += 1; });
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(createElement(Shell, {
        controller, route: { name: "overview" },
        onNavigate: (p: string) => nav.push(p), selection: null, onSelect: () => {},
        children: createElement("div"),
      }));
    });
    const btn = [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Add work"))!;
    await act(async () => { click(btn); });
    assert.equal(nav[0], "/projects/p1");
    assert.equal(composed, 1);
    assert.equal(sessionStorage.getItem("together.composeTask"), "1");
    await act(async () => { root.unmount(); });
  });
});

test("narrow inspector: hidden by default; Escape closes and restores focus", async () => {
  const { controller } = makeController(makeState());
  const closes: number[] = [];
  await withDom(true, async () => {
    const { createRoot } = await import("react-dom/client");
    const originator = document.createElement("button");
    originator.id = "originator";
    document.body.prepend(originator);
    const root = createRoot(document.getElementById("root")!);
    const el = (sel: UISelection | null) => createElement(Inspector, {
      controller, selection: sel, onClose: () => closes.push(1),
    });
    await act(async () => { root.render(el(null)); });
    assert.equal(document.querySelector(".inspector"), null);
    originator.focus();
    assert.equal(document.activeElement, originator);
    await act(async () => { root.render(el({ kind: "task", id: "t1" })); });
    const aside = document.querySelector("aside.inspector.is-open")!;
    assert.ok(aside, "sheet should open on selection");
    assert.ok(aside.contains(document.activeElement), "focus moves into sheet");
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(closes.length, 1);
    assert.equal(document.activeElement, originator);
    await act(async () => { root.render(el(null)); });
    assert.equal(document.querySelector(".inspector"), null);
    await act(async () => { root.unmount(); });
  });
});

test("narrow default shows Build progress; Add task opens a bounded form then creates", async () => {
  const { controller, calls } = makeController(makeState());
  const sels: (UISelection | null)[] = [];
  await withDom(true, async () => {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(createElement(ProjectView, {
        controller, selection: null, onSelect: (s) => sels.push(s),
      }));
    });
    assert.ok(document.querySelector(".progress"), "list default on narrow");
    assert.equal(document.querySelector(".flow-wrap"), null);
    const add = [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Add work"))! as HTMLButtonElement;
    await act(async () => { click(add); });
    assert.equal(calls.length, 0, "no instant create before the form is used");
    const form = document.querySelector("form.newtask-form")!;
    assert.ok(form);
    const goal = form.querySelector<HTMLInputElement>("#newtask-goal")!;
    const crit = form.querySelector<HTMLTextAreaElement>("#newtask-criteria")!;
    assert.ok(goal.maxLength <= 240 && crit.maxLength <= 2000, "bounded inputs");
    setValue(goal, "Write the regression");
    setValue(crit, "old failure shown\nnew pass shown");
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "create-task");
    assert.deepEqual(calls[0].payload, {
      goal: "Write the regression",
      acceptanceCriteria: ["old failure shown", "new pass shown"],
    });
    assert.deepEqual(sels[0], { kind: "task", id: "task-new" });
    assert.equal(document.querySelector("form.newtask-form"), null);
    await act(async () => { root.unmount(); });
  });
});

test("compose-task event and stored flag open the same form; Escape cancels", async () => {
  const { controller } = makeController(makeState());
  await withDom(true, async () => {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("root")!);
    const mount = () => createElement(ProjectView, {
      controller, selection: null, onSelect: () => {},
    });
    await act(async () => { root.render(mount()); });
    await act(async () => {
      window.dispatchEvent(new window.CustomEvent("together:compose-task"));
    });
    const form = document.querySelector("form.newtask-form")!;
    assert.ok(form, "event opens the form");
    const goal = form.querySelector<HTMLInputElement>("#newtask-goal")!;
    await act(async () => {
      goal.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(document.querySelector("form.newtask-form"), null, "Escape closes");
    // Stored flag path: a cross-route mount consumes the flag and opens once.
    sessionStorage.setItem("together.composeTask", "1");
    await act(async () => { root.unmount(); });
    const root2 = createRoot(document.getElementById("root")!);
    await act(async () => { root2.render(mount()); });
    assert.ok(document.querySelector("form.newtask-form"), "flag opens the form on mount");
    assert.equal(sessionStorage.getItem("together.composeTask"), null, "flag consumed");
    await act(async () => { root2.unmount(); });
  });
});

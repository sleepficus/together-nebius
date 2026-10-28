import {useLeaseTime} from './lease-clock.tsx';
// Project route (seat b-swe-07): Georgia headline, activity rail with
// counts, ReactFlow "Project flow" + semantic "Build progress" list sharing
// one selection, deterministic dependency layout with explicit layout save.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Background, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import type { Edge, Node, NodeChange, NodeProps } from "@xyflow/react";
import {
  ArrowsOut, Bug, CheckCircle, GitMerge, ListChecks, Plus, Question,
  FloppyDisk,
} from "@phosphor-icons/react";
import type {
  Candidate, CheckJob, HelpRequest, Id, ProjectState, Task,
} from "../../lib/types.ts";
import {
  Pill, TASK_PILL, taskDisplayPill, claimState, fmtTime, nameOf, portraitFor, shortSha, taskPill,
} from "./Inspector.tsx";
import type { UIController, UISelection } from "./Shell.tsx";

type Sel = UISelection;

const VIEW_KEY = "together.projectView";
const COMPOSE_EVENT = "together:compose-task";
const COMPOSE_FLAG = "together.composeTask";

type Variant = "task" | "candidate" | "check" | "ready" | "help" | "finding";

/** Conservative card footprints (CSS px) used to keep each column
 * collision-free; rendered cards may be slightly shorter, never wider. */
export const NODE_BOX: Record<Variant, { w: number; h: number }> = {
  task: { w: 255, h: 205 },
  candidate: { w: 250, h: 195 },
  check: { w: 220, h: 175 },
  ready: { w: 180, h: 135 },
  help: { w: 230, h: 135 },
  finding: { w: 230, h: 135 },
};
const X_STEP = 345;
const ROW_GAP = 36;

type CardData = Record<string, unknown> & {
  variant: Variant;
  title: string;
  sub?: string;
  body?: string;
  pill?: { label: string; tone: string };
  portrait?: string;
  aria: string;
  sel: Sel;
  pick: () => void;
  nudge?: (dx: number, dy: number) => void;
};

function CardNode({ data, selected }: NodeProps<Node<CardData>>) {
  return (
    <div
      className={`flownode flownode-${data.variant}${selected ? " sel" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={data.aria}
      aria-pressed={selected}
      onClick={(e) => { e.stopPropagation(); data.pick(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          data.pick();
        } else if (data.nudge && e.key.startsWith("Arrow")) {
          e.preventDefault();
          e.stopPropagation();
          const step = e.shiftKey ? 32 : 8;
          const d: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0], ArrowRight: [step, 0],
            ArrowUp: [0, -step], ArrowDown: [0, step],
          };
          const [dx, dy] = d[e.key] ?? [0, 0];
          data.nudge(dx, dy);
        }
      }}
    >
      {data.portrait
        ? <img className="flownode-portrait" src={data.portrait} alt="" />
        : <span className={`flownode-icon flownode-icon-${data.variant}`} aria-hidden>{ICONS[data.variant]}</span>}
      <div className="flownode-head">
        <span className="flownode-title">{data.title}</span>
        {data.sub && <span className="flownode-sub">{data.sub}</span>}
      </div>
      {data.pill && <Pill label={data.pill.label} tone={data.pill.tone} />}
      {data.body && <p className="flownode-body">{data.body}</p>}
      {data.variant !== "help" && data.variant !== "finding" && (
        <Handle type="target" position={Position.Left} />
      )}
      {data.variant !== "ready" && (
        <Handle type="source" position={data.variant === "help" || data.variant === "finding" ? Position.Top : Position.Right} />
      )}
    </div>
  );
}

const ICONS: Record<Variant, ReactNode> = {
  candidate: <GitMerge size={22} />, check: <ListChecks size={20} />,
  ready: <CheckCircle size={22} />, finding: <Bug size={18} />, help: <Question size={18} />,
  task: <ListChecks size={18} />,
};
const nodeTypes = { card: CardNode };

interface Placed {
  id: string;
  variant: Variant;
  x: number;
  y: number;
}

/** Deterministic left-to-right layered layout over real dependency edges. */
export function layoutGraph(tasks: Task[], candidates: Candidate[], jobs: CheckJob[], help: HelpRequest[], findings: { id: Id; candidateId?: Id }[], candTaskIds: Map<Id, Id[]>): Map<string, Placed> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layerOf = (() => {
    const memo = new Map<string, number>();
    const stack = new Set<string>();
    const depth = (t: Task): number => {
      const hit = memo.get(t.id);
      if (hit !== undefined) return hit;
      if (stack.has(t.id)) return 0; // cycle guard — graph rejects cycles upstream
      stack.add(t.id);
      let l = 0;
      for (const d of t.dependencies) {
        const dep = byId.get(d.taskId);
        if (dep) l = Math.max(l, depth(dep) + 1);
      }
      stack.delete(t.id);
      memo.set(t.id, l);
      return l;
    };
    return depth;
  })();

  const placed = new Map<string, Placed>();
  const colRows = new Map<number, { y: number; h: number }[]>();
  // Every put reserves a real rectangle in its column. A y hint is only a
  // preference — when the slot is taken the node drops to the next free gap,
  // so two records can never share the same rectangle.
  const put = (layer: number, id: string, variant: Variant, yHint?: number): Placed => {
    const rows = colRows.get(layer) ?? [];
    colRows.set(layer, rows);
    const h = NODE_BOX[variant].h;
    let y = yHint ?? rows.reduce((m, r) => Math.max(m, r.y + r.h + ROW_GAP), 0);
    for (;;) {
      const hit = rows.find((r) => y < r.y + r.h + ROW_GAP && y + h + ROW_GAP > r.y);
      if (!hit) break;
      y = hit.y + hit.h + ROW_GAP;
    }
    rows.push({ y, h });
    const p = { id, variant, x: layer * X_STEP, y };
    placed.set(id, p);
    return p;
  };

  const sorted = [...tasks].sort((a, b) =>
    layerOf(a) - layerOf(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const t of sorted) put(layerOf(t), `task:${t.id}`, "task");

  const candPos = new Map<string, Placed>();
  for (const c of [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const linkedLayers = (candTaskIds.get(c.id) ?? [])
      .map((tid) => placed.get(`task:${tid}`))
      .filter(Boolean) as Placed[];
    const layer = linkedLayers.length ? Math.max(...linkedLayers.map((p) => Math.round(p.x / X_STEP))) + 1 : 0;
    const yAvg = linkedLayers.length
      ? linkedLayers.reduce((s, p) => s + p.y, 0) / linkedLayers.length
      : undefined;
    candPos.set(c.id, put(layer, `cand:${c.id}`, "candidate", yAvg));
  }
  for (const j of [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const cp = candPos.get(j.candidateId);
    // Each check job takes its own row in the layer next to its candidate --
    // never stacked on the candidate's own y.
    put(Math.round((cp?.x ?? 0) / X_STEP) + 1, `job:${j.id}`, "check");
  }
  for (const c of candidates) {
    if (c.status === "ready" || c.status === "integrated") {
      const cp = candPos.get(c.id);
      put(Math.round((cp?.x ?? 0) / X_STEP) + 2, `ready:${c.id}`, "ready");
    }
  }
  for (const h of help) {
    if (!h.taskId) continue;
    const tp = placed.get(`task:${h.taskId}`);
    if (tp) {
      put(Math.round(tp.x / X_STEP), `help:${h.id}`, "help", tp.y + NODE_BOX.task.h + ROW_GAP);
    }
  }
  for (const f of findings) {
    if (!f.candidateId) continue;
    const cp = candPos.get(f.candidateId);
    if (cp) {
      put(Math.round(cp.x / X_STEP), `find:${f.id}`, "finding", cp.y + NODE_BOX.candidate.h + ROW_GAP);
    }
  }
  return placed;
}

/** Readable initial viewport: graph top-left at near-1:1 zoom so cards keep
 * their reference size. "Fit view" stays the explicit overview control. */
export function initialViewport(points: { x: number; y: number }[]): { x: number; y: number; zoom: number } {
  if (!points.length) return { x: 24, y: 20, zoom: 0.95 };
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  return { x: 24 - minX * 0.95, y: 20 - minY * 0.95, zoom: 0.95 };
}

/** Default project view: readable list on narrow screens, flow on wide —
 * unless a saved explicit user choice says otherwise. */
export function initialView(saved: string | null, narrow: boolean): "flow" | "progress" {
  return saved === "progress" || (saved !== "flow" && narrow) ? "progress" : "flow";
}

function activityCounts(state: ProjectState): { label: string; sub: string; count: number; word: string }[] {
  const tasks = Object.values(state.tasks);
  const cands = Object.values(state.candidates);
  const findings = Object.values(state.findings);
  const open = tasks.filter((t) => t.lifecycle === "draft" || t.lifecycle === "open").length;
  const building = tasks.filter((t) => t.lifecycle === "claimed" || t.lifecycle === "in-progress").length;
  const checking = cands.filter((c) => c.status === "prepared" || c.status === "checking").length
    + findings.filter((f) => f.state === "possible-issue" || f.state === "reproduced" || f.state === "recheck-needed" || f.state === "repair-in-progress").length;
  const ready = cands.filter((c) => c.status === "ready" || c.status === "integrated").length;
  return [
    { label: "Choose work", sub: "Find what matters", count: open, word: "open" },
    { label: "Build together", sub: "Make progress", count: building, word: "building" },
    { label: "Check together", sub: "Look at the big picture", count: checking, word: "to check" },
    { label: "Ready", sub: "Ship with confidence", count: ready, word: "ready" },
  ];
}

function FlowCanvas({ controller, selection, onSelect, showDone, moved, setMoved, markDirty, registerFns }: {
  controller: UIController;
  selection: Sel | null;
  onSelect: (s: Sel | null) => void;
  showDone: boolean;
  moved: Record<string, { x: number; y: number }>;
  setMoved: (m: Record<string, { x: number; y: number }>) => void;
  markDirty: () => void;
  registerFns: (f: { fit: () => void }) => void;
}) {
  const { state } = controller;
  const leaseNow=useLeaseTime();
  const rf = useReactFlow();

  useEffect(() => {
    registerFns({ fit: () => void rf.fitView({ padding: 0.2, duration: 200 }) });
  }, [rf, registerFns]);

  const { nodes, edges, hiddenDone, view0 } = useMemo(() => {
    const all = Object.values(state.tasks);
    const visible = all.filter((t) => t.lifecycle !== "cancelled" && (showDone || t.lifecycle !== "done"));
    const hidden = all.length - visible.length;
    const cands = Object.values(state.candidates);
    const jobs = Object.values(state.jobs);
    const openHelp = Object.values(state.help).filter((h) => h.state === "offered" || h.state === "accepted");
    const openFindings = Object.values(state.findings).filter((f) =>
      ["possible-issue", "reproduced", "recheck-needed", "repair-in-progress"].includes(f.state));
    const propTasks = new Map<Id, Id[]>();
    for (const pr of Object.values(state.proposals)) propTasks.set(pr.id, pr.taskIds);
    const candTaskIds = new Map<Id, Id[]>();
    for (const c of cands) {
      candTaskIds.set(c.id, [...new Set(c.proposalIds.flatMap((p) => propTasks.get(p) ?? []))]);
    }
    const pos = layoutGraph(visible, cands, jobs, openHelp, openFindings, candTaskIds);

    const selKey = selection ? `${selection.kind === "task" ? "task" : selection.kind === "candidate" ? "cand" : selection.kind === "help" ? "help" : selection.kind === "finding" ? "find" : "x"}:${selection.id}` : "";

    const pick = (sel: Sel) => () => onSelect(sel);
    const nudge = (id: string) => (dx: number, dy: number) => {
      const p = pos.get(`task:${id}`);
      const cur = moved[id] ?? state.tasks[id]?.layout ?? { x: p?.x ?? 0, y: p?.y ?? 0 };
      setMoved({ ...moved, [id]: { x: cur.x + dx, y: cur.y + dy } });
      markDirty();
    };

    const nodes: Node<CardData>[] = [];
    const add = (key: string, draggable: boolean, p: { x: number; y: number }, sel: Sel,
      data: Omit<CardData, "sel" | "pick">) => {
      nodes.push({
        id: key, type: "card", position: p, draggable,
        selected: selKey === key,
        data: { ...data, sel, pick: pick(sel) } as CardData,
      });
    };
    for (const t of visible) {
      const p = pos.get(`task:${t.id}`)!;
      const asg = t.currentAssignmentId ? state.assignments[t.currentAssignmentId] : undefined;
      const [pillLabel, pillTone] = taskDisplayPill(t,state,controller.mode,leaseNow);
      const phase=asg?claimState(state,controller.mode,asg,leaseNow):undefined;
      const who = asg ? `${phase==='current'?'':'Last claim: '}${nameOf(state, asg.identityId)}` : "Unassigned";
      add(`task:${t.id}`, true, moved[t.id] ?? t.layout ?? { x: p.x, y: p.y },
        { kind: "task", id: t.id }, {
          variant: "task", title: t.goal, sub: who,
          body: phase==='expired'?`Claim expired ${fmtTime(asg!.leaseExpiresAt)}. Work and evidence are retained.`:(t.nextAction ?? t.acceptanceCriteria[0] ?? "").slice(0, 90) || undefined,
          pill: { label: pillLabel, tone: pillTone },
          portrait: asg ? portraitFor(asg.identityId, nameOf(state, asg.identityId)) : undefined,
          aria: `Task: ${t.goal}. ${pillLabel}. ${asg ? `${phase==='current'?'Assigned to':'Recorded'} ${who}.` : "Unassigned."} Arrow keys move the card, Enter opens details.`,
          nudge: nudge(t.id),
        });
    }
    for (const c of cands) {
      const p = pos.get(`cand:${c.id}`);
      if (!p) continue;
      add(`cand:${c.id}`, false, p, { kind: "candidate", id: c.id }, {
        variant: "candidate", title: "Combine changes", sub: `Candidate ${shortSha(c.sha)}`,
        body: `${c.proposalIds.length} proposal${c.proposalIds.length === 1 ? "" : "s"} merged onto ${shortSha(c.base)}.`,
        pill: { label: c.status === "checking" ? "Waiting for checks" : c.status, tone: c.status === "ready" || c.status === "integrated" ? "green" : "amber" },
        aria: `System node: combined candidate ${shortSha(c.sha)}, status ${c.status}. Not claimable.`,
      });
    }
    for (const j of jobs) {
      const p = pos.get(`job:${j.id}`);
      if (!p) continue;
      add(`job:${j.id}`, false, p, { kind: "candidate", id: j.candidateId }, {
        variant: "check", title: "Check the result", sub: "Configured check runner", body: j.command,
        pill: { label: j.status === "running" || j.status === "dispatched" ? "Checking" : j.status, tone: j.status === "completed" ? "green" : "amber" },
        aria: `System node: check job ${j.command}, status ${j.status}. Not claimable.`,
      });
    }
    for (const c of cands) {
      if (c.status !== "ready" && c.status !== "integrated") continue;
      const p = pos.get(`ready:${c.id}`);
      if (!p) continue;
      add(`ready:${c.id}`, false, p, { kind: "candidate", id: c.id }, {
        variant: "ready", title: "Ready",
        body: c.status === "integrated" ? "Integrated onto the canonical ref." : "Checks and review satisfied.",
        aria: `System node: ready result for candidate ${shortSha(c.sha)}.`,
      });
    }
    for (const h of openHelp) {
      const p = pos.get(`help:${h.id}`);
      if (!p) continue;
      add(`help:${h.id}`, false, p, { kind: "help", id: h.id }, {
        variant: "help", title: "Help wanted", body: h.question.slice(0, 80),
        pill: { label: h.state === "accepted" ? "Accepted" : "Open", tone: "amber" },
        aria: `Help request: ${h.question}`,
      });
    }
    for (const f of openFindings) {
      const p = pos.get(`find:${f.id}`);
      if (!p) continue;
      add(`find:${f.id}`, false, p, { kind: "finding", id: f.id }, {
        variant: "finding", title: "Finding", body: f.observed.slice(0, 80),
        pill: { label: f.state, tone: "amber" },
        aria: `Finding on candidate: ${f.observed}`,
      });
    }

    const edges: Edge[] = [];
    const link = (id: string, source: string, target: string, className: string, label?: string) =>
      edges.push({ id, source, target, className, label, markerEnd: { type: MarkerType.ArrowClosed } });
    for (const t of visible) {
      for (const d of t.dependencies) {
        if (!pos.has(`task:${d.taskId}`)) continue;
        link(`dep:${d.taskId}->${t.id}:${d.kind}`, `task:${d.taskId}`, `task:${t.id}`,
          d.kind === "prerequisite" ? "e-prereq" : "e-contrib",
          d.kind === "prerequisite" ? "needed first" : "contributes");
      }
    }
    for (const c of cands) {
      for (const tid of candTaskIds.get(c.id) ?? []) {
        if (pos.has(`task:${tid}`)) {
          link(`c:${tid}->${c.id}`, `task:${tid}`, `cand:${c.id}`, "e-contrib", "contributes changes");
        }
      }
      for (const jid of c.checkJobIds) {
        if (pos.has(`job:${jid}`)) {
          link(`j:${c.id}->${jid}`, `cand:${c.id}`, `job:${jid}`, "e-check", "checked by");
        }
      }
      if (pos.has(`ready:${c.id}`)) {
        const job = c.checkJobIds.find((j) => pos.has(`job:${j}`));
        link(`r:${c.id}`, job ? `job:${job}` : `cand:${c.id}`, `ready:${c.id}`, "e-ready");
      }
    }
    for (const h of openHelp) {
      if (h.taskId && pos.has(`help:${h.id}`) && pos.has(`task:${h.taskId}`)) {
        link(`h:${h.id}->${h.taskId}`, `help:${h.id}`, `task:${h.taskId}`, "e-help", "help linked to");
      }
    }
    for (const f of openFindings) {
      if (f.candidateId && pos.has(`find:${f.id}`) && pos.has(`cand:${f.candidateId}`)) {
        link(`f:${f.id}->${f.candidateId}`, `find:${f.id}`, `cand:${f.candidateId}`, "e-help", "finding linked to");
      }
    }
    return { nodes, edges, hiddenDone: hidden, view0: initialViewport(nodes.map((n) => n.position)) };
  }, [state, leaseNow, showDone, moved, selection, onSelect, setMoved, markDirty]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let next: Record<string, { x: number; y: number }> | null = null;
    for (const c of changes) {
      if (c.type === "position" && c.position) {
        next = { ...(next ?? moved), [c.id.replace(/^task:/, "")]: c.position };
      }
    }
    if (next) {
      setMoved(next);
      markDirty();
    }
  }, [moved, setMoved, markDirty]);

  return (
    <div className="flow-wrap">
      <ReactFlow<Node<CardData>>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_event, node) => onSelect(node.data.sel)}
        nodesFocusable={false}
        onPaneClick={() => onSelect(null)}
        deleteKeyCode={null}
        defaultViewport={view0}
        minZoom={0.25}
        maxZoom={1.6}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background gap={24} />
      </ReactFlow>
      {hiddenDone > 0 && (
        <p className="flow-hidden">Showing active work — {hiddenDone} finished/cancelled task{hiddenDone === 1 ? "" : "s"} hidden. Use “Show completed”.</p>
      )}
    </div>
  );
}

const GROUPS: [string, (t: Task) => boolean][] = [
  ["Needs claiming", (t) => t.lifecycle === "draft" || t.lifecycle === "open"],
  ["Building", (t) => t.lifecycle === "claimed" || t.lifecycle === "in-progress"],
  ["Submitted", (t) => t.lifecycle === "submitted"],
  ["Done", (t) => t.lifecycle === "done"],
  ["Cancelled", (t) => t.lifecycle === "cancelled"],
];

function ProgressList({ controller, selection, onSelect }: {
  controller: UIController; selection: Sel | null; onSelect: (s: Sel | null) => void;
}) {
  const { state, mode } = controller;
  const leaseNow=useLeaseTime();
  const tasks = Object.values(state.tasks).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const cands = Object.values(state.candidates);
  const jobs = Object.values(state.jobs);
  const findings = Object.values(state.findings);

  const row = (key: string, sel: Sel, main: ReactNode, meta: ReactNode, pill: ReactNode) => (
    <li key={key}>
      <button type="button"
        className={`progress-row${selection?.kind === sel.kind && selection.id === sel.id ? " sel" : ""}`}
        onClick={() => onSelect(sel)}>
        {main}
        <span className="progress-meta">{meta}</span>
        {pill}
      </button>
    </li>
  );

  return (
    <div className="progress">
      {GROUPS.map(([label, match]) => {
        const list = tasks.filter(match);
        if (!list.length) return null;
        return (
          <section key={label} className="progress-group">
            <h3>{label} <span className="count">{list.length}</span></h3>
            <ul>
              {list.map((t) => {
                const asg = t.currentAssignmentId ? state.assignments[t.currentAssignmentId] : undefined;
                const depNames = t.dependencies
                  .map((d) => state.tasks[d.taskId]?.goal)
                  .filter(Boolean).join(", ");
                return row(
                  t.id, { kind: "task", id: t.id },
                  <span className="progress-main">
                    {asg && <img src={portraitFor(asg.identityId, nameOf(state, asg.identityId))} alt="" className="avatar" />}
                    <span className="progress-title">{t.goal}</span>
                  </span>,
                  <>{asg ? `${claimState(state,mode,asg,leaseNow)==='current'?'':'Last claim: '}${nameOf(state, asg.identityId)}` : "Unassigned"}{depNames ? ` · after ${depNames}` : ""}</>,
                  taskPill(t,state,mode,leaseNow),
                );
              })}
            </ul>
          </section>
        );
      })}
      {(cands.length > 0 || jobs.length > 0 || findings.length > 0) && (
        <section className="progress-group">
          <h3>System records</h3>
          <ul>
            {cands.map((c) => row(
              c.id, { kind: "candidate", id: c.id },
              <span className="progress-main"><GitMerge size={18} aria-hidden /><span className="progress-title">Candidate {shortSha(c.sha)}</span></span>,
              <>{c.proposalIds.length} proposals · policy v{c.policyVersion}{mode === "sample" ? " · sample" : ""}</>,
              <Pill label={c.status} tone={c.status === "ready" || c.status === "integrated" ? "green" : "amber"} />,
            ))}
            {jobs.map((j) => row(
              j.id, { kind: "candidate", id: j.candidateId },
              <span className="progress-main"><ListChecks size={18} aria-hidden /><span className="progress-title">Check {j.command}</span></span>,
              <>on {shortSha(j.candidateSha)}{mode === "sample" ? " · sample" : ""}</>,
              <Pill label={j.status} tone={j.status === "completed" ? "green" : "amber"} />,
            ))}
            {findings.map((f) => row(
              f.id, { kind: "finding", id: f.id },
              <span className="progress-main"><Bug size={18} aria-hidden /><span className="progress-title">{f.observed.slice(0, 60)}</span></span>,
              <>reported {fmtTime(f.createdAt)}</>,
              <Pill label={f.state} tone={f.state === "verified-fixed" ? "green" : "amber"} />,
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Screen-reader and no-graph equivalent: every node and relationship in words. */
export function FlowList({ state, showDone }: { state: ProjectState; showDone: boolean }) {
  const tasks = Object.values(state.tasks).filter((t) => t.lifecycle !== "cancelled" && (showDone || t.lifecycle !== "done"));
  const items: string[] = [];
  for (const t of tasks) {
    const deps = t.dependencies.map((d) => {
      const dt = state.tasks[d.taskId];
      return dt ? `${d.kind === "prerequisite" ? "needs first" : "receives changes from"} “${dt.goal}”` : null;
    }).filter(Boolean).join("; ");
    const asg = t.currentAssignmentId ? nameOf(state, state.assignments[t.currentAssignmentId]?.identityId) : "unassigned";
    items.push(`Task “${t.goal}” — ${t.lifecycle}, ${asg}${deps ? `. ${deps}` : ""}.`);
  }
  for (const c of Object.values(state.candidates)) {
    const props = c.proposalIds.map((p) => state.proposals[p]?.summary ?? p).join("; ");
    items.push(`System: combined candidate ${shortSha(c.sha)} — ${c.status}${props ? `, combines: ${props}` : ""}.`);
  }
  for (const j of Object.values(state.jobs)) {
    items.push(`System: check “${j.command}” on ${shortSha(j.candidateSha)} — ${j.status}.`);
  }
  for (const h of Object.values(state.help)) {
    if (h.state === "offered" || h.state === "accepted") {
      const t = h.taskId ? state.tasks[h.taskId] : undefined;
      items.push(`Help linked to “${t?.goal ?? "project"}”: ${h.question} — ${h.state}.`);
    }
  }
  for (const f of Object.values(state.findings)) {
    if (["possible-issue", "reproduced", "recheck-needed", "repair-in-progress"].includes(f.state)) {
      const c = f.candidateId ? state.candidates[f.candidateId] : undefined;
      items.push(`Finding on candidate ${c ? shortSha(c.sha) : "unknown"}: ${f.observed} — ${f.state}.`);
    }
  }
  return (
    <details className="flow-alt">
      <summary>Text version of this flow</summary>
      <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>
    </details>
  );
}

/** Bounded create-task form: goal plus acceptance criteria — the same
 * purposeful flow the header "Add work" button opens via compose-task. */
function NewTaskForm({ controller, onDone, onSelect }: {
  controller: UIController;
  onDone: () => void;
  onSelect: (s: Sel | null) => void;
}) {
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const goalRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { goalRef.current?.focus(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const g = goal.trim();
    if (!g || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = (await controller.action("create-task", {
        goal: g,
        acceptanceCriteria: criteria.split("\n").map((c) => c.trim()).filter(Boolean),
      })) as { ok?: boolean; error?: string; taskId?: string; task?: { id?: string } } | undefined;
      if (res?.ok === false) throw new Error(res.error ?? "Task could not be created");
      const id = res?.taskId ?? res?.task?.id;
      onDone();
      if (typeof id === "string" && id) onSelect({ kind: "task", id });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="newtask-form" aria-label="Add a task"
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}>
      <label htmlFor="newtask-goal">New task</label>
      <input id="newtask-goal" ref={goalRef} value={goal} maxLength={240} required
        onChange={(e) => setGoal(e.target.value)}
        placeholder="What should this task achieve?" />
      <label htmlFor="newtask-criteria" className="newtask-crit">Acceptance criteria — one per line (optional)</label>
      <textarea id="newtask-criteria" value={criteria} maxLength={2000} rows={3}
        onChange={(e) => setCriteria(e.target.value)}
        placeholder="How will we know it is done?" />
      <div className="newtask-actions">
        <button type="submit" disabled={busy || !goal.trim()}>
          {busy ? "Adding…" : "Add task"}
        </button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
      {err && <p className="insp-error" role="alert">{err}</p>}
    </form>
  );
}

function ProjectViewInner({ controller, selection, onSelect }: {
  controller: UIController; selection: Sel | null; onSelect: (s: Sel | null) => void;
}) {
  const { state, mode } = controller;
  const narrow = typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 860px)").matches;
  const [view, setView] = useState<"flow" | "progress">(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null;
    return initialView(saved, narrow);
  });
  // The preference persists only on an explicit user choice — never as a
  // side effect of a mount or a viewport resize — so a fresh narrow visit
  // defaults to the readable list while a chosen preference stays honored.
  const chooseView = useCallback((v: "flow" | "progress") => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  }, []);
  const [showDone, setShowDone] = useState(false);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const fns = useRef<{ fit: () => void }>({ fit: () => {} });
  const registerFns = useCallback((f: { fit: () => void }) => { fns.current = f; }, []);

  useEffect(() => {
    const onSet = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      if (v === "flow" || v === "progress") chooseView(v);
    };
    window.addEventListener("together:set-view", onSet);
    return () => window.removeEventListener("together:set-view", onSet);
  }, [chooseView]);
  // Crossing the narrow breakpoint re-defaults the view only when the user
  // has not made an explicit choice this session or a saved one earlier.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 860px)");
    const onChange = () => {
      let saved: string | null = null;
      try { saved = localStorage.getItem(VIEW_KEY); } catch { /* private mode */ }
      if (saved !== "flow" && saved !== "progress") setView(mq.matches ? "progress" : "flow");
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // "Add work" (shell header) and this page's "Add task" open the same
  // bounded create form: the flag covers a cross-route mount, the event an
  // already-mounted view.
  const [composeOpen, setComposeOpen] = useState(false);
  const addTaskBtn = useRef<HTMLButtonElement | null>(null);
  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    addTaskBtn.current?.focus();
  }, []);
  const openCompose = useCallback(() => {
    try { sessionStorage.removeItem(COMPOSE_FLAG); } catch { /* private mode */ }
    setComposeOpen(true);
  }, []);
  useEffect(() => {
    window.addEventListener(COMPOSE_EVENT, openCompose);
    try {
      if (sessionStorage.getItem(COMPOSE_FLAG)) openCompose();
    } catch { /* private mode */ }
    return () => window.removeEventListener(COMPOSE_EVENT, openCompose);
  }, [openCompose]);

  const markDirty = useCallback(() => setDirty(true), []);
  const rail = activityCounts(state);
  const core = Object.values(state.members).filter((m) => m.kind === "core").slice(0, 4);

  const saveLayout = async () => {
    setSaving(true);
    try {
      await controller.action("save-layout", {
        positions: Object.fromEntries(Object.entries(moved).map(([id, p]) => [id, p])),
      });
      setMoved({});
      setDirty(false);
    } catch { /* surfaced via controller.error */ }
    setSaving(false);
  };

  const ask = (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    void controller.action("ask-help", { question: question.trim() });
    setQuestion("");
    setAskOpen(false);
  };

  return (
    <div className="project">
      <div className="project-hero">
        <h1 className="headline">The work, together.</h1>
        <p className="subtitle">
          {mode === "sample" ? "Sample project · " : ""}Separate changes. One working result.
        </p>
        <details className="project-brief"><summary>Project brief</summary><p>{state.project.goal}</p></details>
        {controller.connectionUnavailable&&<p role="status" className="stopped-note">Connection unavailable. This work map shows the last saved snapshot, not current host activity.</p>}
        <ol className="activity-rail" aria-label="Activity">
          {rail.map((r, i) => (
            <li key={r.label} className={i === 0 && r.count === 0 ? "done" : r.count > 0 ? "active" : ""}>
              <span className="rail-marker" aria-hidden>{i + 1}</span>
              <span className="rail-label">{r.label}</span>
              <span className="rail-sub">{r.sub}</span>
              <span className="rail-count">{r.count} {r.word}</span>
            </li>
          ))}
        </ol>
        <div className="crew-strip" aria-label="Core crew">
          {core.map((m) => (
            <img key={m.id} src={portraitFor(m.identityId, nameOf(state, m.identityId))} alt={nameOf(state, m.identityId)}
              title={nameOf(state, m.identityId)} className="avatar" />
          ))}
          {mode === "sample" && <span className="crew-note">sample crew</span>}
        </div>
      </div>
      <div className="project-toolbar">
        <div className="view-switch" role="group" aria-label="Project view">
          <button type="button" className={view === "flow" ? "on" : ""} aria-pressed={view === "flow"}
            onClick={() => chooseView("flow")}>Project flow</button>
          <button type="button" className={view === "progress" ? "on" : ""} aria-pressed={view === "progress"}
            onClick={() => chooseView("progress")}>Build progress</button>
        </div>
        {view === "flow" && (
          <>
            <button type="button" onClick={() => fns.current.fit()}>
              <ArrowsOut size={15} aria-hidden /> Fit view
            </button>
            <label className="show-done">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
              Show completed
            </label>
          </>
        )}
        <button type="button" ref={addTaskBtn} disabled={state.stopped}
          aria-expanded={composeOpen}
          onClick={() => setComposeOpen((o) => !o)}>
          <Plus size={15} aria-hidden /> Add work
        </button>
        <button type="button" disabled={state.stopped} onClick={() => setAskOpen((o) => !o)}>
          <Question size={15} aria-hidden /> Help
        </button>
        <button type="button" disabled={state.stopped}
          onClick={() => void controller.action("stop", {})}>Stop work</button>
        {dirty && (
          <button type="button" className="save-layout" disabled={saving} onClick={() => void saveLayout()}>
            <FloppyDisk size={15} aria-hidden /> {saving ? "Saving…" : "Save layout"}
          </button>
        )}
      </div>
      {composeOpen && (
        <NewTaskForm controller={controller} onDone={closeCompose} onSelect={onSelect} />
      )}
      {askOpen && (
        <form className="ask-form" onSubmit={ask}>
          <label htmlFor="ask-q">Ask the crew for help</label>
          <input id="ask-q" value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder="What do you need another pair of eyes on?" />
          <button type="submit" disabled={!question.trim()}>Send</button>
        </form>
      )}
      {state.stopped && <p className="stopped-note">Project is stopped — read-only inspection.</p>}
      {view === "flow" ? (
        <>
          <FlowCanvas controller={controller} selection={selection} onSelect={onSelect}
            showDone={showDone} moved={moved} setMoved={setMoved} markDirty={markDirty}
            registerFns={registerFns} />
          <FlowList state={state} showDone={showDone} />
        </>
      ) : (
        <ProgressList controller={controller} selection={selection} onSelect={onSelect} />
      )}
    </div>
  );
}

export function ProjectView(props: {
  controller: UIController; selection: Sel | null; onSelect: (s: Sel | null) => void;
}) {
  return (
    <ReactFlowProvider>
      <ProjectViewInner {...props} />
    </ReactFlowProvider>
  );
}

import {AttentionStatus} from '../ui/AttentionStatus.tsx';
import {RecoveryPanel} from '../ui/RecoveryPanel.tsx';
import {UseLog} from '../ui/UseLog.tsx';
import {EvidenceWorkbench} from '../ui/EvidenceWorkbench.tsx';
import {CollaborationOverview} from '../ui/CollaborationOverview.tsx';
import {CollaborationQuestions} from '../ui/CollaborationQuestions.tsx';
import {ConnectionSetup} from '../ui/ConnectionSetup.tsx';
// Routed pages (seat b-swe-08): bespoke Overview and Changes layouts, a
// reusable readable list for Crew and Findings, and the registered-
// question Experiments page. Every count and row opens the matching
// record through onSelect (the inspector itself lives in seat b-swe-07),
// or navigates to the route that lists those records. Metrics that the
// records cannot support stay unknown — never zero-by-silence. Controls
// without a controller-contract action (integration, enrollment, OAuth)
// are disabled and say so instead of pretending.
import { useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowRight, ArrowSquareOut, Bug, CheckCircle, CircleDashed,
  ClockCounterClockwise, FileText, Flask, GitMerge, GitPullRequest,
  Info, Link as LinkIcon, ListChecks, Notebook, PlugsConnected,
  Plus, Question, Robot, ShieldCheck, UserPlus, Users, WarningCircle,
} from "@phosphor-icons/react";
import type {
  Assignment, Candidate, CheckJob, EvidenceReceipt, Finding, Id,
  Member, ProjectState, Proposal, Review, Session, Task,
} from "../../lib/types.ts";
import { metrics } from "../../lib/events.ts";
import type { UIController, UISelection } from "../ui/Shell.tsx";
import {
  Pill, fmtTime, nameOf, portraitFor, shortSha, taskPill, MemberClaims,
} from "../ui/Inspector.tsx";
// @ts-ignore — Vite bundles this side-effect import through the module
// graph; the starter tsconfig ships no "*.css" ambient declaration.
import "./pages.css";

export interface PageProps {
  controller: UIController;
  selection: UISelection | null;
  onSelect: (sel: UISelection | null) => void;
  onNavigate: (path: string) => void;
}

const values = <T,>(m: Record<Id, T>): T[] => Object.values(m);
const ACTIVE_HELP = new Set(["offered", "accepted"]);
const OPEN_FINDING = new Set([
  "possible-issue", "reproduced", "recheck-needed", "repair-in-progress",
]);
const CLOSED_FINDING = new Set(["not-reproduced", "withdrawn"]);
const HEARTBEAT_MS = 2 * 60 * 1000;

function fresh(iso: string | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && Date.now() - t < HEARTBEAT_MS;
}

// Working requires a recent authenticated heartbeat — never bare activity.
// The source marker distinguishes a real/session heartbeat ('runner
// heartbeat', 'sample-heartbeat') from any other authenticated write; the
// rule mirrors the canonical metrics() basis in lib/events.ts.
const HEARTBEAT_SOURCE = /heartbeat|runner/i;

function freshHeartbeat(s: Session | undefined): boolean {
  return fresh(s?.lastActivityAt) && HEARTBEAT_SOURCE.test(s?.lastActivitySource ?? "");
}

/** Per-assignment form of the metrics() Working rule: a fresh session
    heartbeat, a fresh job heartbeat owned by the assignment, or a fresh
    heartbeat event naming the assignment. */
function hasHeartbeat(state: ProjectState, a: Assignment): boolean {
  const from = new Date(Date.now() - HEARTBEAT_MS).toISOString();
  if (freshHeartbeat(a.sessionId ? state.sessions[a.sessionId] : undefined)) return true;
  for (const j of values(state.jobs)) {
    const beat = (j as CheckJob & { lastHeartbeatAt?: string }).lastHeartbeatAt;
    if (j.ownerAssignmentId === a.id && beat !== undefined && beat >= from) return true;
  }
  for (const ev of state.events) {
    const d = ev.detail as Record<string, unknown> | undefined;
    if (
      (ev.type === "check:heartbeat" || ev.type === "assignment:heartbeat" || ev.type === "heartbeat")
      && ev.createdAt >= from && d?.assignmentId === a.id
    ) return true;
  }
  return false;
}

function presenceBadge(state: ProjectState, mode: string, a?: Assignment): ReactNode {
  if (!a) return <Pill label="Unassigned" tone="muted" />;
  const label = hasHeartbeat(state, a) ? "Working" : "Assigned";
  return <Pill label={mode === "sample" ? `${label} · sample` : label}
    tone={label === "Working" ? "blue" : "muted"} />;
}

function sel(sel: UISelection | null, kind: UISelection["kind"], id: Id): boolean {
  return sel?.kind === kind && sel.id === id;
}

/* ---------- shared small parts ---------- */

function usePageAction(controller: UIController) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (type: string, payload?: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await controller.action(type, payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, act };
}

function ActionError({ error }: { error: string | null }) {
  return error ? <p className="pg-error" role="alert">{error}</p> : null;
}

function Stat({ value, label, scope, onOpen }: {
  value: ReactNode; label: string; scope: string; onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      <span className="stat-scope">{scope}</span>
    </>
  );
  return onOpen
    ? <button type="button" className="stat" onClick={onOpen}>{body}</button>
    : <div className="stat stat-idle">{body}</div>;
}

function Section({ title, count, hint, children }: {
  title: string; count?: number; hint?: string; children: ReactNode;
}) {
  return (
    <section className="pg-section">
      <h2 className="pg-h2">
        {title}
        {count !== undefined && <span className="count">{count}</span>}
        {hint && <span className="pg-hint">{hint}</span>}
      </h2>
      {children}
    </section>
  );
}

function RecRow({ children, onOpen, active, label }: {
  children: ReactNode; onOpen: () => void; active?: boolean; label: string;
}) {
  return (
    <li>
      <button type="button" aria-label={label}
        className={`pg-row${active ? " sel" : ""}`} onClick={onOpen}>
        {children}
      </button>
    </li>
  );
}

function MiniForm({ id, label, fields, submit, disabled, onSend }: {
  id: string; label: string; fields: string[]; submit: string;
  disabled: boolean; onSend: (values: string[]) => void;
}) {
  const [vals, setVals] = useState<string[]>(fields.map(() => ""));
  const ready = vals.every((v) => v.trim().length > 0) && !disabled;
  return (
    <form className="pg-form" onSubmit={(e: FormEvent) => {
      e.preventDefault();
      if (ready) {
        onSend(vals.map((v) => v.trim()));
        setVals(fields.map(() => ""));
      }
    }}>
      <label htmlFor={id}>{label}</label>
      <div className="pg-form-row">
        {fields.map((ph, i) => (
          <input key={ph} id={i === 0 ? id : undefined} aria-label={ph}
            value={vals[i]}
            onChange={(e) => setVals(vals.map((v, j) => (j === i ? e.target.value : v)))}
            placeholder={ph} />
        ))}
        <button type="submit" disabled={!ready}>{submit}</button>
      </div>
    </form>
  );
}

/* ---------- derived facts ---------- */

interface Blocker {
  key: string;
  sel: UISelection;
  icon: ReactNode;
  title: string;
  meta: string;
  tone: string;
}

function namedBlockers(state: ProjectState): Blocker[] {
  const out: Blocker[] = [];
  for (const f of values(state.findings)) {
    if (!OPEN_FINDING.has(f.state)) continue;
    out.push({
      key: `f:${f.id}`, sel: { kind: "finding", id: f.id }, icon: <Bug size={16} aria-hidden />,
      title: f.observed, meta: `${f.state} · reported by ${nameOf(state, f.originatorId)}`, tone: "amber",
    });
  }
  for (const h of values(state.help)) {
    if (!ACTIVE_HELP.has(h.state)) continue;
    const task = h.taskId ? state.tasks[h.taskId] : undefined;
    out.push({
      key: `h:${h.id}`, sel: { kind: "help", id: h.id }, icon: <Question size={16} aria-hidden />,
      title: h.question, meta: `${h.state}${task ? ` · on “${task.goal}”` : ""}`, tone: "amber",
    });
  }
  for (const j of values(state.jobs)) {
    if (j.status !== "failed" && j.status !== "blocked") continue;
    out.push({
      key: `j:${j.id}`, sel: { kind: "candidate", id: j.candidateId },
      icon: <ListChecks size={16} aria-hidden />,
      title: `Check ${j.status}: ${j.command}`,
      meta: `candidate ${shortSha(j.candidateSha)} — a blocked check is not a defect`, tone: "blue",
    });
  }
  for (const c of values(state.candidates)) {
    if (c.status !== "ready") continue;
    out.push({
      key: `c:${c.id}`, sel: { kind: "candidate", id: c.id },
      icon: <GitMerge size={16} aria-hidden />,
      title: `Candidate ${shortSha(c.sha)} is ready`,
      meta: "checks and review satisfied · integration is a separate authorized operation",
      tone: "green",
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function reviewsFor(state: ProjectState, cand: Candidate): Review[] {
  return cand.reviewIds.map((r) => state.reviews[r]).filter(Boolean) as Review[];
}

function jobsFor(state: ProjectState, cand: Candidate): CheckJob[] {
  return cand.checkJobIds.map((j) => state.jobs[j]).filter(Boolean) as CheckJob[];
}

function receiptsFor(state: ProjectState, sha: string): EvidenceReceipt[] {
  return values(state.receipts).filter((r) => r.candidateSha === sha);
}

const CANDIDATE_TONE: Record<string, string> = {
  ready: "green", integrated: "green", checking: "amber", prepared: "amber",
  failed: "amber", superseded: "muted",
};

/* ---------- Overview ---------- */

export function OverviewPage({ controller, selection, onSelect, onNavigate }: PageProps) {
  const { state, mode } = controller;
  const pid = state.project.id;
  const base = `/projects/${encodeURIComponent(mode==='live'?'live:'+pid:pid)}`;
  const { busy, error, act } = usePageAction(controller);
  const [goal, setGoal] = useState("");
  const [summaryAvailability,setSummaryAvailability]=useState<'loading'|'available'|'unavailable'>('loading');
  const available=mode==='sample'||(!controller.connectionUnavailable&&summaryAvailability==='available');

  // Every stat derives from the canonical metrics() so the numbers match
  // GET /metrics exactly: heartbeat-basis presence, confirmed landings
  // only, windowed observations, and unknown kept distinct from zero.
  const m = useMemo(() => metrics(state), [state]);

  const blockers = useMemo(() => namedBlockers(state), [state]);
  const lastHuman = m.humanActions.eventIds[m.humanActions.eventIds.length - 1];
  const needHelpSel: UISelection | null = m.needsHelp.helpIds.length > 0
    ? { kind: "help", id: m.needsHelp.helpIds[0] }
    : m.needsHelp.blockerIds.length > 0
      ? { kind: "finding", id: m.needsHelp.blockerIds[0] }
      : null;
  const sampleNote = mode === "sample" ? " · sample records" : "";

  const createProject = (e: FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    void act("create-project", { goal: goal.trim() });
    setGoal("");
  };
  const openProject = (id: string) => {
    controller.selectProject(id);
    onNavigate(`/projects/${encodeURIComponent(id)}`);
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Good to see you, Hooman.</h1>
        <p className="page-sub">
          Here’s what the crew has recorded, what’s next, and where you can help{sampleNote}.
        </p>
        <div className="overview-shortcuts"><a href={`${base}?view=talk`} onClick={e=>{e.preventDefault();onNavigate(`${base}?view=talk`)}}>Talk to the crew →</a><a href={base} onClick={e=>{e.preventDefault();onNavigate(base)}}>Open the work map</a></div>
      </header>
      <CollaborationOverview controller={controller} selection={selection} onSelect={onSelect} onNavigate={onNavigate} onAvailabilityChange={setSummaryAvailability}/>
      <CollaborationQuestions controller={controller} available={available}/>

      {state.stopped && (
        <p className="pg-banner"><WarningCircle size={16} aria-hidden />
          This project is stopped — inspection stays read-only and dispatch is disabled.</p>
      )}

      <details className="activity-details"><summary>Activity counts &amp; named blockers</summary>
      {!available&&<p role="status">{summaryAvailability==='loading'&&!controller.connectionUnavailable?'Checking the connection…':'Live records are unavailable. Counts and blocker status are unknown until the connection returns.'}</p>}
      {available&&<section className="pg-section" aria-label="Scoped statistics">
        <div className="stat-strip">
          <Stat value={m.workingNow.value}
            label={m.workingNow.label}
            scope={`distinct sessions · ${Math.round(m.heartbeatFreshnessMs / 60000)}-minute heartbeat window · ${m.workingNow.assignedCount} assigned${sampleNote}`}
            onOpen={() => onNavigate(`${base}/crew`)} />
          <Stat value={`${m.tasksFinished.accepted}/${m.tasksFinished.denominator}`}
            label="Tasks finished"
            scope={`accepted results of non-cancelled tasks${sampleNote}`}
            onOpen={() => onNavigate(base)} />
          <Stat value={m.changesCombined.value}
            label="Changes combined"
            scope={`confirmed canonical landings · last ${m.window.minutes} min · deduplicated by sha/operation${sampleNote}`}
            onOpen={() => onNavigate(`${base}/changes`)} />
          <Stat value={m.commits.unknown ? "unknown" : m.commits.received}
            label={m.commits.unknown
              ? "Commits received"
              : `Commits received · ${m.commits.integrated} integrated`}
            scope={m.commits.unknown
              ? `no commit-observation events recorded — not the same as zero${sampleNote}`
              : `distinct heads observed in last ${m.window.minutes} min, not authored${sampleNote}`}
            onOpen={() => onNavigate(`${base}/changes`)} />
          <Stat value={m.humanActions.total}
            label="Human actions"
            scope={`categorized interventions · last ${m.window.minutes} min${m.humanActions.uncategorizedHumanEvents > 0 ? ` · ${m.humanActions.uncategorizedHumanEvents} uncategorized not counted` : ""}`}
            onOpen={lastHuman ? () => onSelect({ kind: "event", id: lastHuman }) : undefined} />
          <Stat value={m.needsHelp.value}
            label="Needs help"
            scope="open help + reproduced/recheck-needed findings · deduplicated"
            onOpen={needHelpSel ? () => onSelect(needHelpSel) : undefined} />
        </div>
      </section>}

      {available&&<Section title="Named blockers" count={blockers.length}>
        {blockers.length === 0 ? (
          <p className="pg-empty"><CheckCircle size={16} aria-hidden /> No blockers recorded in this snapshot.</p>
        ) : (
          <ul className="pg-list">
            {blockers.map((b) => (
              <RecRow key={b.key} label={b.title} active={sel(selection, b.sel.kind, b.sel.id)}
                onOpen={() => onSelect(b.sel)}>
                <span className={`pg-icn pg-icn-${b.tone}`}>{b.icon}</span>
                <span className="pg-main">
                  <span className="pg-title">{b.title}</span>
                  <span className="pg-sub">{b.meta}</span>
                </span>
                <ArrowRight size={15} aria-hidden />
              </RecRow>
            ))}
          </ul>
        )}
      </Section>}
      </details>

      <Section title="Your projects" count={controller.projects.length}>
        {controller.projects.length === 0 && (
          <p className="pg-empty">No projects yet — create one below to get started.</p>
        )}
        <ul className="pg-list">
          {controller.projects.map((p) => {
            const open = values(p.tasks).filter((t) => t.lifecycle !== "done" && t.lifecycle !== "cancelled").length;
            const current = p.project.id === pid && p.project.mode === mode;
            return (
              <li key={`${p.project.mode}:${p.project.id}`}>
                <div className={`pg-row pg-project${current ? " sel" : ""}`}>
                  <span className="pg-main">
                    <span className="pg-title">{p.project.goal}</span>
                    <span className="pg-sub">
                      {!available&&p.project.mode==='live'?'Last saved snapshot · ':''}{open} open task{open === 1 ? "" : "s"} · updated {fmtTime(p.project.updatedAt)}
                    </span>
                  </span>
                  <Pill label={p.project.mode === "sample" ? "sample" : "live"}
                    tone={p.project.mode === "sample" ? "amber" : "green"} />
                  {current
                    ? <Pill label="current" tone="muted" />
                    : (
                      <button type="button" className="pg-open"
                        onClick={() => openProject(`${p.project.mode}:${p.project.id}`)}>
                        Open <ArrowRight size={14} aria-hidden />
                      </button>
                    )}
                </div>
              </li>
            );
          })}
        </ul>
        <form className="pg-form" onSubmit={createProject}>
          <label htmlFor="new-project">Create a project</label>
          <div className="pg-form-row">
            <input id="new-project" value={goal} disabled={busy}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What should this project achieve?" />
            <button type="submit" disabled={busy || !goal.trim()}>
              <Plus size={15} aria-hidden /> Create
            </button>
          </div>
        </form>
        <ActionError error={error} />
      </Section>
    </div>
  );
}

/* ---------- Crew ---------- */

function sessionFacts(s: Session): [string, string][] {
  const platform = s.status === "revoked"
    ? "Grant revoked"
    : s.status === "ended"
      ? "Host offline"
      : freshHeartbeat(s)
        ? "Running observed · heartbeat"
        : "Connected to platform · no recent heartbeat";
  return [
    ["Platform", platform],
    ["Provider", `${s.provider ?? "not recorded"} · access unknown`],
    ["Observed inference", s.observedCapabilities.length
      ? s.observedCapabilities.join(", ") : "not assessed"],
    ["Adapter", `${s.adapter ?? "not recorded"}${s.harness ? ` · ${s.harness}` : ""}`],
    ["Model", s.model ?? "not recorded"],
    ["Host", s.host ?? "not recorded"],
    ["Payer", s.payerRef ?? "not recorded"],
    ["Last activity", `${fmtTime(s.lastActivityAt)}${s.lastActivitySource ? ` · ${s.lastActivitySource}` : " · source unrecorded"}`],
  ];
}

function MemberCard({ controller, member, selection, onSelect }: {
  controller: UIController; member: Member;
  selection: UISelection | null; onSelect: (s: UISelection | null) => void;
}) {
  const { state, mode } = controller;
  const identity = state.identities[member.identityId];
  const sessions = values(state.sessions).filter((s) => s.identityId === member.identityId);
  const authored = values(state.proposals).filter((p) => p.authorId === member.identityId);
  const reviews = values(state.reviews).filter((r) => r.reviewerId === member.identityId);
  const reported = values(state.findings).filter((f) => f.originatorId === member.identityId);
  const doneAsg = values(state.assignments).filter(
    (a) => a.identityId === member.identityId && a.status === "completed").length;
  const advertised = [...new Set(sessions.flatMap((s) => s.advertisedCapabilities))];
  const checked = [...new Set(sessions.flatMap((s) => s.observedCapabilities))];

  return (
    <article className={`pg-card${sel(selection, "member", member.id) ? " sel" : ""}`}>
      <header className="pg-card-head">
        <img src={portraitFor(member.identityId, nameOf(state, member.identityId))} alt="" className="avatar" />
        <button type="button" className="pg-linklike"
          onClick={() => onSelect({ kind: "member", id: member.id })}>
          <h3>{identity?.displayName ?? member.identityId}</h3>
        </button>
        <Pill label={member.kind} tone={member.kind === "core" ? "green" : "muted"} />
        {identity && <Pill label={identity.status} tone={identity.status === "active" ? "blue" : "muted"} />}
      </header>

      <dl className="pg-facts">
        <div><dt>Claims</dt><dd><MemberClaims state={state} mode={mode} identityId={member.identityId}/></dd></div>
      </dl>

      {sessions.length > 0 && (
        <div className="pg-subsec">
          <h4><PlugsConnected size={14} aria-hidden /> Connections</h4>
          {sessions.map((s) => (
            <dl key={s.id} className="pg-kv">
              {sessionFacts(s).map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          ))}
        </div>
      )}

      {(advertised.length > 0 || checked.length > 0) && (
        <dl className="pg-facts">
          <div><dt>Advertised tools</dt><dd>{advertised.join(", ") || "none"}</dd></div>
          <div><dt>Checked tools</dt><dd>{checked.join(", ") || "none checked"}</dd></div>
        </dl>
      )}

      <div className="pg-subsec">
        <h4><FileText size={14} aria-hidden /> Contribution history</h4>
        <ul className="pg-contribs">
          <li>{authored.length} change proposal{authored.length === 1 ? "" : "s"} authored</li>
          <li>{reviews.length} review{reviews.length === 1 ? "" : "s"} given
            {reviews.length > 0 && ` · ${reviews.filter((r) => r.independent).length} independent`}</li>
          <li>{reported.length} finding{reported.length === 1 ? "" : "s"} reported</li>
          <li>{doneAsg} assignment{doneAsg === 1 ? "" : "s"} completed</li>
        </ul>
        {authored.slice(0, 3).map((p) => (
          <button key={p.id} type="button" className="pg-chip"
            onClick={() => onSelect({ kind: "proposal", id: p.id })}>
            {p.summary} <code>{shortSha(p.head)}</code>
          </button>
        ))}
      </div>
    </article>
  );
}

export function CrewPage({ controller, selection, onSelect, onNavigate }: PageProps) {
  const { state, mode } = controller;
  const { busy, error, act } = usePageAction(controller);
  void onNavigate;
  const members = values(state.members)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const core = members.filter((m) => m.kind === "core");
  const collab = members.filter((m) => m.kind !== "core");

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title"><Users size={34} weight="duotone" aria-hidden /> Who can help?</h1>
        <p className="page-sub">
          Core team and current collaborators — assignments, observed activity,
          checked capabilities and factual contributions{mode === "sample" ? " · sample crew" : ""}.
        </p>
      </header>

      <ConnectionSetup controller={controller}/><RecoveryPanel controller={controller}/><AttentionStatus controller={controller}/>
      <Section title="Core team" count={core.length}>
        {core.length === 0 && <p className="pg-empty">No core members recorded.</p>}
        <div className="pg-grid">
          {core.map((m) => (
            <MemberCard key={m.id} controller={controller} member={m}
              selection={selection} onSelect={onSelect} />
          ))}
        </div>
      </Section>

      <Section title="Collaborators" count={collab.length}>
        {collab.length === 0 && <p className="pg-empty">No visiting collaborators recorded.</p>}
        <div className="pg-grid">
          {collab.map((m) => (
            <MemberCard key={m.id} controller={controller} member={m}
              selection={selection} onSelect={onSelect} />
          ))}
        </div>
      </Section>

      <Section title="Work with this crew">
        <MiniForm id="crew-help" label="Ask or offer help"
          fields={["What should a helper look at?"]} submit="Send help request"
          disabled={busy || state.stopped}
          onSend={([q]) => void act("ask-help", { question: q })} />
        <p className="pg-note">
          <UserPlus size={14} aria-hidden /> Invitations and join approvals are
          owner-managed enrollment — unavailable in this prototype surface rather
          than faked. Help delivery is not acceptance, and acceptance is not a
          running session.
        </p>
        <ActionError error={error} />
      </Section>
    </div>
  );
}

/* ---------- Changes ---------- */

function ProposalItem({ controller, proposal: p, selection, onSelect }: {
  controller: UIController; proposal: Proposal;
  selection: UISelection | null; onSelect: (s: UISelection | null) => void;
}) {
  const { state } = controller;
  const reports = values(state.authorReports).filter((r) => r.proposalId === p.id);
  const tasks = p.taskIds.map((id) => state.tasks[id]).filter(Boolean) as Task[];
  const shown = p.changedPaths.slice(0, 6);
  return (
    <li className="pg-item">
      <button type="button" className={`pg-row${sel(selection, "proposal", p.id) ? " sel" : ""}`}
        aria-label={`Proposal: ${p.summary}`}
        onClick={() => onSelect({ kind: "proposal", id: p.id })}>
        <span className="pg-icn"><GitPullRequest size={18} aria-hidden /></span>
        <span className="pg-main">
          <span className="pg-title">{p.summary}</span>
          <span className="pg-sub">
            {nameOf(state, p.authorId)} · <code>{shortSha(p.base)}</code>
            {" → "}<code>{shortSha(p.head)}</code>
            {" · "}{p.changedPaths.length} file{p.changedPaths.length === 1 ? "" : "s"}
            {" · "}{fmtTime(p.updatedAt)}
          </span>
        </span>
        <Pill label={p.lifecycle}
          tone={p.lifecycle === "integrated" ? "green"
            : p.lifecycle === "changes-requested" ? "amber"
            : p.lifecycle === "withdrawn" ? "muted" : "blue"} />
      </button>
      <div className="pg-detail">
        {shown.map((f) => <code key={f} className="pg-chip">{f}</code>)}
        {p.changedPaths.length > shown.length && (
          <span className="pg-sub">+{p.changedPaths.length - shown.length} more</span>
        )}
        {tasks.map((t) => (
          <button key={t.id} type="button" className="pg-chip"
            onClick={() => onSelect({ kind: "task", id: t.id })}>
            <LinkIcon size={12} aria-hidden /> {t.goal}
          </button>
        ))}
        {p.unknowns.length > 0 && (
          <span className="pg-sub"><WarningCircle size={12} aria-hidden />
            {" "}{p.unknowns.length} declared unknown{p.unknowns.length === 1 ? "" : "s"}</span>
        )}
        {reports.map((r) => (
          <span key={r.id} className="pg-sub pg-report">
            Author report {fmtTime(r.createdAt)} — author-reported, not independent evidence
          </span>
        ))}
      </div>
    </li>
  );
}

function CandidateCard({ controller, cand: c, selection, onSelect }: {
  controller: UIController; cand: Candidate;
  selection: UISelection | null; onSelect: (s: UISelection | null) => void;
}) {
  const { state, mode } = controller;
  const { busy, error, act } = usePageAction(controller);
  const jobs = jobsFor(state, c);
  const receipts = receiptsFor(state, c.sha);
  const reviews = reviewsFor(state, c);
  const findings = values(state.findings).filter((f) => f.candidateId === c.id);
  const unresolved = findings.filter((f) => OPEN_FINDING.has(f.state));
  const proposals = c.proposalIds.map((p) => state.proposals[p]).filter(Boolean) as Proposal[];
  const integrateOp = c.integrateOperationId ? state.operations[c.integrateOperationId] : undefined;
  const independent = reviews.filter((r) => r.independent && r.disposition === "approve");

  return (
    <article className={`pg-card${sel(selection, "candidate", c.id) ? " sel" : ""}`}>
      <header className="pg-card-head">
        <span className="pg-icn pg-icn-amber"><GitMerge size={18} aria-hidden /></span>
        <button type="button" className="pg-linklike"
          onClick={() => onSelect({ kind: "candidate", id: c.id })}>
          <h3>Candidate <code>{shortSha(c.sha)}</code></h3>
        </button>
        <Pill label={c.status} tone={CANDIDATE_TONE[c.status] ?? "muted"} />
      </header>

      <dl className="pg-facts">
        <div><dt>Base</dt><dd><code>{shortSha(c.base)}</code></dd></div>
        <div><dt>Policy</dt><dd>v{c.policyVersion}{mode === "sample" ? " · sample" : ""}</dd></div>
        <div><dt>Created</dt><dd>{fmtTime(c.createdAt)}</dd></div>
        {integrateOp && (
          <div><dt>Integrate op</dt>
            <dd><code>{integrateOp.id}</code> · effect {integrateOp.effect}</dd>
          </div>
        )}
      </dl>

      <div className="pg-subsec">
        <h4><FileText size={14} aria-hidden /> Exact proposal heads</h4>
        <ul className="pg-contribs">
          {proposals.map((p) => (
            <li key={p.id}>
              <button type="button" className="pg-linklike"
                onClick={() => onSelect({ kind: "proposal", id: p.id })}>
                {p.summary}
              </button>
              {" "}<code>{shortSha(c.proposalHeads[p.id] ?? p.head)}</code>
            </li>
          ))}
        </ul>
      </div>

      <div className="pg-subsec">
        <h4><ListChecks size={14} aria-hidden /> Check evidence</h4>
        {jobs.length === 0 && receipts.length === 0 && (
          <p className="pg-sub">No check jobs or receipts recorded{mode === "sample" ? " · sample" : ""}.</p>
        )}
        <ul className="pg-contribs">
          {jobs.map((j) => (
            <li key={j.id}>
              <code>{j.command}</code> — {j.status}
              {j.deadlineAt ? ` · deadline ${fmtTime(j.deadlineAt)}` : ""}
              {mode === "sample" ? " · sample" : ""}
            </li>
          ))}
          {receipts.map((r) => (
            <li key={r.id}>
              <code>{r.command}</code> — <strong>{r.outcome}</strong>
              {" · collector "}“{nameOf(state, r.collectorId)}” · independent runner evidence
            </li>
          ))}
        </ul>
      </div>

      <div className="pg-subsec">
        <h4><ShieldCheck size={14} aria-hidden /> Reviews</h4>
        {reviews.length === 0 && (
          <p className="pg-sub">No reviews recorded — the required independent review is outstanding.</p>
        )}
        <ul className="pg-contribs">
          {reviews.map((r) => (
            <li key={r.id}>
              {nameOf(state, r.reviewerId)}: {r.disposition}
              {r.independent
                ? " · independent"
                : ` · not independent (${r.independenceReason})`}
              {" · policy v"}{r.policyVersion}
            </li>
          ))}
        </ul>
      </div>

      {unresolved.length > 0 && (
        <div className="pg-subsec">
          <h4><Bug size={14} aria-hidden /> Unresolved findings</h4>
          <ul className="pg-contribs">
            {unresolved.map((f) => (
              <li key={f.id}>
                <button type="button" className="pg-linklike"
                  onClick={() => onSelect({ kind: "finding", id: f.id })}>
                  {f.observed}
                </button>
                {" — "}{f.state}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="pg-actions">
        <button type="button" disabled={busy || state.stopped}
          onClick={() => void act("request-check", { candidateId: c.id })}>
          Request check
        </button>
        <button type="button" disabled={busy || state.stopped}
          onClick={() => void act("review-candidate", { candidateId: c.id, disposition: "approve" })}>
          Approve
        </button>
        <button type="button" disabled={busy || state.stopped}
          onClick={() => void act("review-candidate", { candidateId: c.id, disposition: "request-changes" })}>
          Request changes
        </button>
        <button type="button" disabled={busy || state.stopped}
          onClick={() => void act("review-candidate", { candidateId: c.id, disposition: "comment" })}>
          Comment
        </button>
        <button type="button" disabled title="Integration is a separate authorized operation on the canonical ref">
          Integrate — unavailable
        </button>
      </div>
      <p className="pg-note">
        {independent.length === 0
          ? "No independent approval yet — an author, second session or descendant cannot satisfy review policy."
          : `${independent.length} independent approval${independent.length === 1 ? "" : "s"} recorded.`}
        {" "}Integration is a separate authorized operation — it never runs from
        this page, so the button stays unavailable rather than pretend.
      </p>
      <MiniForm id={`f-${c.id}`} label="Report a finding on this candidate"
        fields={["Expected behavior", "Observed behavior"]} submit="Report finding"
        disabled={busy || state.stopped}
        onSend={([exp, obs]) => void act("report-finding", {
          candidateId: c.id, expected: exp, observed: obs,
        })} />
      <ActionError error={error} />
    </article>
  );
}

export function ChangesPage({ controller, selection, onSelect, onNavigate }: PageProps) {
  const { state, mode } = controller;
  const { busy, error, act } = usePageAction(controller);
  void onNavigate;
  const proposals = values(state.proposals).sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const candidates = values(state.candidates).sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const ready = proposals.filter(
    (p) => p.lifecycle === "submitted" || p.lifecycle === "ready-to-combine");
  const openTasks = values(state.tasks).filter(
    (t) => t.lifecycle !== "done" && t.lifecycle !== "cancelled");
  const [taskId, setTaskId] = useState("");

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title"><GitPullRequest size={34} weight="duotone" aria-hidden /> Review changes</h1>
        <p className="page-sub">
          Exact revisions, check evidence and reviews for proposed and combined
          code{mode === "sample" ? " · sample records" : ""}.
        </p>
      </header>

      <div className="pg-actions">
        <button type="button" className="primary"
          disabled={busy || state.stopped || ready.length === 0}
          title={ready.length === 0 ? "No submitted or ready proposals to combine" : `Combine ${ready.length} proposal(s) onto the canonical base`}
          onClick={() => void act("prepare-candidate", {})}>
          <GitMerge size={15} aria-hidden /> Prepare combined candidate{ready.length > 0 ? ` (${ready.length})` : ""}
        </button>
      </div>

      <Section title="Proposed changes" count={proposals.length}>
        {proposals.length === 0 && (
          <p className="pg-empty">No change proposals recorded yet.</p>
        )}
        <ul className="pg-list">
          {proposals.map((p) => (
            <ProposalItem key={p.id} controller={controller} proposal={p}
              selection={selection} onSelect={onSelect} />
          ))}
        </ul>
        <form className="pg-form" onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const summary = String(fd.get("summary") ?? "").trim();
          if (!summary) return;
          void act("submit-change", {
            summary,
            intendedBehavior: String(fd.get("intent") ?? "").trim() || undefined,
            taskIds: taskId ? [taskId] : [],
            base: String(fd.get("base") ?? "").trim() || undefined,
            head: String(fd.get("head") ?? "").trim() || undefined,
          });
          e.currentTarget.reset();
          setTaskId("");
        }}>
          <label htmlFor="chg-summary">Offer a change for review</label>
          <div className="pg-form-row">
            <input id="chg-summary" name="summary" placeholder="What does this change do?" />
            <select aria-label="Linked task" value={taskId}
              onChange={(e) => setTaskId(e.target.value)}>
              <option value="">No linked task</option>
              {openTasks.map((t) => (
                <option key={t.id} value={t.id}>{t.goal.slice(0, 48)}</option>
              ))}
            </select>
          </div>
          <div className="pg-form-row">
            <input name="intent" placeholder="Intended behavior (optional)" />
            <input name="base" aria-label="Base commit" placeholder="base SHA (optional)" />
            <input name="head" aria-label="Head commit" placeholder="head SHA (optional)" />
            <button type="submit" disabled={busy || state.stopped}>
              <Plus size={15} aria-hidden /> Submit change
            </button>
          </div>
        </form>
      </Section>

      <Section title="Combined candidates" count={candidates.length}>
        {candidates.length === 0 && (
          <p className="pg-empty">No combined candidates yet — prepare one from submitted proposals.</p>
        )}
        {candidates.map((c) => (
          <CandidateCard key={c.id} controller={controller} cand={c}
            selection={selection} onSelect={onSelect} />
        ))}
      </Section>
      <ActionError error={error} />
    </div>
  );
}

/* ---------- Findings ---------- */

function FindingItem({ controller, finding: f, selection, onSelect }: {
  controller: UIController; finding: Finding;
  selection: UISelection | null; onSelect: (s: UISelection | null) => void;
}) {
  const { state } = controller;
  const { busy, error, act } = usePageAction(controller);
  const cand = f.candidateId ? state.candidates[f.candidateId] : undefined;
  const repair = f.linkedTaskId ? state.tasks[f.linkedTaskId] : undefined;
  const open = f.state === "possible-issue" || f.state === "reproduced";
  const recheckable = f.candidateId
    && (f.state === "recheck-needed" || f.state === "repair-in-progress" || f.state === "reproduced");
  const receipts = f.receiptIds.map((r) => state.receipts[r]).filter(Boolean);

  return (
    <li className="pg-item">
      <button type="button" className={`pg-row${sel(selection, "finding", f.id) ? " sel" : ""}`}
        aria-label={`Finding: ${f.observed}`}
        onClick={() => onSelect({ kind: "finding", id: f.id })}>
        <span className="pg-icn pg-icn-amber"><Bug size={16} aria-hidden /></span>
        <span className="pg-main">
          <span className="pg-title">{f.observed}</span>
          <span className="pg-sub">
            reported by {nameOf(state, f.originatorId)} · {fmtTime(f.createdAt)}
            {cand ? ` · candidate ` : ""}{cand ? <code>{shortSha(cand.sha)}</code> : null}
            {f.severity ? ` · ${f.severity}` : ""}
          </span>
        </span>
        <Pill label={f.importedUnverified ? `Imported · unverified (${f.importedState ?? f.state})` : f.state} tone={f.state === "verified-fixed" ? "green" : CLOSED_FINDING.has(f.state) ? "muted" : "amber"} />
      </button>
      <div className="pg-detail">
        <span className="pg-sub"><strong>Expected:</strong> {f.expected}</span>
        {f.reproducer && <span className="pg-sub"><strong>Reproduce:</strong> <code>{f.reproducer}</code></span>}
        {repair && (
          <button type="button" className="pg-chip"
            onClick={() => onSelect({ kind: "task", id: repair.id })}>
            <LinkIcon size={12} aria-hidden /> repair: {repair.goal} {taskPill(repair)}
          </button>
        )}
        {receipts.length > 0 && (
          <span className="pg-sub">{receipts.length} evidence receipt{receipts.length === 1 ? "" : "s"} linked</span>
        )}
        {f.note && <span className="pg-sub">note: {f.note}</span>}
        <span className="pg-actions pg-actions-inline">
          <button type="button" disabled={busy || !open || state.stopped}
            onClick={() => void act("disposition-finding", { findingId: f.id, state: "not-reproduced" })}>
            Not reproduced
          </button>
          <button type="button" disabled={busy || !open || state.stopped}
            onClick={() => void act("disposition-finding", { findingId: f.id, state: "withdrawn" })}>
            Withdraw
          </button>
          {recheckable && (
            <button type="button" disabled={busy || state.stopped}
              onClick={() => void act("request-check", { candidateId: f.candidateId })}>
              Request recheck
            </button>
          )}
        </span>
        <ActionError error={error} />
      </div>
    </li>
  );
}

export function FindingsPage({ controller, selection, onSelect, onNavigate }: PageProps) {
  const { state, mode } = controller;
  const { busy, error, act } = usePageAction(controller);
  void onNavigate;
  const findings = values(state.findings).sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const open = findings.filter((f) => OPEN_FINDING.has(f.state));
  const verified = findings.filter((f) => f.state === "verified-fixed");
  const closed = findings.filter((f) => CLOSED_FINDING.has(f.state));
  const candidates = values(state.candidates);
  const [candId, setCandId] = useState("");

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title"><Bug size={34} weight="duotone" aria-hidden /> What did checking reveal?</h1>
        <p className="page-sub">
          Recorded check and agent findings — expected versus observed behavior,
          reproductions, linked repairs and honest dispositions
          {mode === "sample" ? " · sample records" : ""}.
        </p>
      </header>

      <Section title="Needs attention" count={open.length}>
        {open.length === 0 && (
          <p className="pg-empty"><CheckCircle size={16} aria-hidden /> Nothing needs attention right now.</p>
        )}
        <ul className="pg-list">
          {open.map((f) => (
            <FindingItem key={f.id} controller={controller} finding={f}
              selection={selection} onSelect={onSelect} />
          ))}
        </ul>
      </Section>

      <Section title="Verified fixed" count={verified.length}
        hint="derived only from authenticated recheck receipts">
        {verified.length === 0 && (
          <p className="pg-empty">No verified fixes recorded.</p>
        )}
        <ul className="pg-list">
          {verified.map((f) => (
            <FindingItem key={f.id} controller={controller} finding={f}
              selection={selection} onSelect={onSelect} />
          ))}
        </ul>
      </Section>

      <Section title="Closed without a fix" count={closed.length}
        hint="false alarms and withdrawn findings stay visible">
        {closed.length === 0 && (
          <p className="pg-empty">No false alarms or withdrawn findings.</p>
        )}
        <ul className="pg-list">
          {closed.map((f) => (
            <FindingItem key={f.id} controller={controller} finding={f}
              selection={selection} onSelect={onSelect} />
          ))}
        </ul>
      </Section>

      <Section title="Report a finding">
        <form className="pg-form" onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const expected = String(fd.get("expected") ?? "").trim();
          const observed = String(fd.get("observed") ?? "").trim();
          if (!expected || !observed) return;
          void act("report-finding", {
            expected, observed,
            ...(candId ? { candidateId: candId } : {}),
          });
          e.currentTarget.reset();
          setCandId("");
        }}>
          <label htmlFor="fd-exp">Expected and observed behavior</label>
          <div className="pg-form-row">
            <input id="fd-exp" name="expected" placeholder="Expected behavior" />
            <input name="observed" aria-label="Observed behavior" placeholder="Observed behavior" />
            {candidates.length > 0 && (
              <select aria-label="On candidate" value={candId}
                onChange={(e) => setCandId(e.target.value)}>
                <option value="">No candidate link</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>candidate {shortSha(c.sha)}</option>
                ))}
              </select>
            )}
            <button type="submit" disabled={busy || state.stopped}>
              <Bug size={15} aria-hidden /> Report
            </button>
          </div>
        </form>
        <p className="pg-note">
          <Info size={14} aria-hidden /> A finding becomes “Verified fixed” only
          when an authenticated recheck links the original failing and repaired
          passing runs of the same reproducer — no button or dropdown here can
          manufacture that state.
        </p>
        <ActionError error={error} />
      </Section>
    </div>
  );
}

/* ---------- Experiments ---------- */

export function ExperimentsPage({ controller, selection, onSelect, onNavigate }: PageProps) {
  const { mode } = controller;
  void selection;
  void onSelect;
  void onNavigate;
  return (
    <div className="page">
      <EvidenceWorkbench controller={controller}/><UseLog controller={controller}/>
      <header className="page-head">
        <h1 className="page-title"><Flask size={34} weight="duotone" aria-hidden /> Does this way of working help?</h1>
        <p className="page-sub">
          The registered experiment and its honest status — no results are
          invented or implied{mode === "sample" ? " · sample project" : ""}.
        </p>
      </header>

      <Section title="Registered question">
        <article className="pg-card">
          <header className="pg-card-head">
            <span className="pg-icn"><Notebook size={18} aria-hidden /></span>
            <h3>Can agents help each other finish correctly—with less coordination work?</h3>
          </header>
          <dl className="pg-facts">
            <div><dt>Status</dt><dd><Pill label="Planned" tone="blue" /></dd></div>
            <div><dt>Assessment</dt><dd><Pill label="Not assessed" tone="muted" /></dd></div>
            <div><dt>Record</dt><dd><code>7e7a4fc211804a9881e876d47749762d</code></dd></div>
          </dl>
          <p className="pg-note">
            This question is registered in the existing experiment notebook as
            Planned and Not assessed. No collaboration benefit has been measured
            by this specification or this prototype.
          </p>
          <p className="pg-note">No experiment notebook is connected to this standalone copy.</p>
        </article>
      </Section>

      <Section title="Protocol status">
        <dl className="pg-facts">
          <div><dt>Protocol freeze</dt>
            <dd><CircleDashed size={14} aria-hidden /> Not frozen in this build — protocol JSON,
              content hash and equal arm budgets are not yet locked.</dd></div>
          <div><dt>Evaluation cases</dt>
            <dd><CircleDashed size={14} aria-hidden /> None recorded — one development case per arm
              is separate from later frozen fresh cases.</dd></div>
          <div><dt>Human-effort log</dt>
            <dd><CircleDashed size={14} aria-hidden /> None recorded — human time is an explicit
              record, never inferred from monitoring.</dd></div>
        </dl>
        <p className="pg-note">
          <ClockCounterClockwise size={14} aria-hidden /> This page links the
          existing notebook only. It does not build a second notebook or
          database, and it records no measurements of its own.
        </p>
        <p className="pg-note">
          <Robot size={14} aria-hidden /> Connection facts on the Crew page keep
          platform connection, provider authentication and observed inference
          separate — an OAuth control is not offered here because none is
          verified.
        </p>
      </Section>
    </div>
  );
}

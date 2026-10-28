import {useLeaseTime} from './lease-clock.tsx';
// Right-side inspector / detail panel (seat b-swe-07).
// Selection kinds are frozen by the build contract; all writes go through
// the 09 controller's action() — this module owns no state of its own.
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowRight, Bug, CheckCircle, FileText, GitMerge, Question, Sparkle,
  WarningCircle, X,
} from "@phosphor-icons/react";
import type {
  Assignment, Candidate, CheckJob, EvidenceReceipt, Event, Finding,
  HelpRequest, Id, Member, ProjectState, Proposal, Review, Task,
} from "../../lib/types.ts";
import type { UIController, UISelection } from "./Shell.tsx";

type Ctl = Pick<UIController, "state" | "mode" | "action" | "error">;

export const PORTRAITS = [
  "/assets/portrait-green.png",
  "/assets/portrait-blue.png",
  "/assets/portrait-checker.png",
];

/** Assigned sample portraits; other seats have stable labelled placeholders. */
export function portraitFor(id: string, displayName?: string): string {
  const assigned:Record<string,string>={'agent-wren':PORTRAITS[1],'agent-fern':PORTRAITS[0],'agent-tess':PORTRAITS[2]};
  if(assigned[id])return assigned[id];
  const names:Record<string,string>={steve:'ST',chad:'CH',faye:'FA',way:'WA',command:'CO',field:'FI',vision:'VI',dot:'DO'};
  const initials=displayName?.trim().split(/\s+/).map(word=>[...word].find(c=>/[\p{L}\p{N}]/u.test(c))??'').filter(Boolean).slice(0,2).join('').toUpperCase().slice(0,4);
  const label=initials||names[id.toLowerCase()]||'AG';
  return 'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52"><circle cx="26" cy="26" r="26" fill="#dcebdd"/><text x="26" y="31" text-anchor="middle" font-family="system-ui,sans-serif" font-size="15" fill="#235a47">${label}</text></svg>`);
}

export function nameOf(state: ProjectState, id: Id | undefined): string {
  if (!id) return "unassigned";
  return state.identities[id]?.displayName ?? state.members[id]?.identityId ?? id;
}

export function fmtTime(iso: string | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "none";
}

export const TASK_PILL: Record<string, [string, string]> = {
  draft: ["Draft", "muted"], open: ["Open", "muted"],
  claimed: ["Claimed", "blue"], "in-progress": ["Building", "blue"],
  submitted: ["Submitted", "amber"], done: ["Done", "green"],
  cancelled: ["Cancelled", "muted"],
};

export function Pill({ label, tone }: { label: string; tone: string }) {
  return <span className={`pill pill-${tone}`}>{label}</span>;
}

/** View-only lease classification; never changes recorded assignment status. */
export function claimState(state: ProjectState, mode: string, assignment: Assignment, now=Date.now()): 'current'|'expired'|'prior'|'unknown' {
  if (assignment.status === 'expired') return 'expired';
  if (assignment.status !== 'active') return 'prior';
  if (mode !== 'sample') {
    const until=Date.parse(assignment.leaseExpiresAt);
    if (!Number.isFinite(until)) return 'unknown';
    if (until<=now) return 'expired';
  }
  const task=state.tasks[assignment.taskId];
  if (!task) return 'unknown';
  if (assignment.role==='owner' && task.currentAssignmentId!==assignment.id) return 'prior';
  return 'current';
}

export function taskDisplayPill(t: Task, state?: ProjectState, mode='sample', now=Date.now()): [string,string] {
  const claim=t.currentAssignmentId?state?.assignments[t.currentAssignmentId]:undefined;
  if (state && claim) {
    const phase=claimState(state,mode,claim,now);
    if (phase!=='current') return [phase==='expired'?'Lease expired':phase==='unknown'?'Lease unknown':'Prior claim','amber'];
  }
  return TASK_PILL[t.lifecycle]??[t.lifecycle,'muted'];
}
export function taskPill(t: Task, state?: ProjectState, mode='sample', now=Date.now()): ReactNode {
  const [label,tone]=taskDisplayPill(t,state,mode,now);return <Pill label={label} tone={tone}/>;
}

export function MemberClaims({state,mode,identityId,now:observedNow}:{state:ProjectState;mode:string;identityId:string;now?:number}) {
  const clockNow=useLeaseTime();const now=observedNow??clockNow;
  const records=Object.values(state.assignments).filter(a=>a.identityId===identityId);
  const live=records.filter(a=>claimState(state,mode,a,now)==='current');
  const history=records.filter(a=>claimState(state,mode,a,now)!=='current');
  return <div className="member-claims">
    {live.length?<><strong>Current claims</strong>{live.map(a=><div className="member-claim" key={a.id}><span>{state.tasks[a.taskId]?.goal??a.taskId} · {a.role}</span>{presencePill(state,mode,a,now)}</div>)}</>:<span>No current claim</span>}
    {history.length>0&&<><strong>Expired / prior claim history</strong>{history.map(a=>{const phase=claimState(state,mode,a,now);return <div className="member-claim" key={a.id}><span>{state.tasks[a.taskId]?.goal??a.taskId} · {a.role}</span><small>{phase==='expired'?'Lease expired':phase==='unknown'?'Lease unknown':'Prior claim'} · epoch {a.epoch} · recorded status {a.status} · until {fmtTime(a.leaseExpiresAt)}</small></div>})}</>}
  </div>;
}

/** Working requires an observed recent heartbeat; otherwise Assigned. */
export function presencePill(state: ProjectState, mode: string, assignment?: Assignment, now=Date.now()): ReactNode {
  if (!assignment) return <Pill label="Unassigned" tone="muted" />;
  const phase=claimState(state,mode,assignment,now);
  if(phase!=='current')return <Pill label={phase==='expired'?'Lease expired':phase==='unknown'?'Lease unknown':'Prior claim'} tone="amber"/>;
  const sess = assignment.sessionId ? state.sessions[assignment.sessionId] : undefined;
  const cutoff = new Date(now - 2 * 60 * 1000).toISOString();
  const fresh = Boolean(
    (sess?.lastActivityAt && sess.lastActivityAt >= cutoff && /heartbeat|runner/i.test(sess.lastActivitySource ?? '')) ||
    Object.values(state.jobs).some(j => j.ownerAssignmentId === assignment.id && (j as CheckJob & { lastHeartbeatAt?: string }).lastHeartbeatAt && (j as CheckJob & { lastHeartbeatAt?: string }).lastHeartbeatAt! >= cutoff) ||
    state.events.some(e => e.createdAt >= cutoff && ['check:heartbeat', 'assignment:heartbeat', 'heartbeat'].includes(e.type) && (e.detail as Record<string, unknown> | undefined)?.assignmentId === assignment.id)
  );
  const label = fresh ? "Working" : "Assigned";
  return <Pill label={mode === "sample" ? `${label} · sample` : label} tone={fresh ? "blue" : "muted"} />;
}

function currentAssignment(state: ProjectState, task: Task): Assignment | undefined {
  return task.currentAssignmentId ? state.assignments[task.currentAssignmentId] : undefined;
}

function nextActionFor(state: ProjectState): string {
  const open = Object.values(state.tasks).filter((t) => t.lifecycle !== "done" && t.lifecycle !== "cancelled");
  const need = open.find((t) => t.nextAction) ?? open.find((t) => t.lifecycle === "open" || t.lifecycle === "draft");
  if (need) return need.nextAction ?? `Claim or assign “${need.goal}”.`;
  const cand = Object.values(state.candidates).find((c) => c.status === "checking" || c.status === "prepared");
  if (cand) return `Wait for checks on candidate ${shortSha(cand.sha)}.`;
  const ready = Object.values(state.candidates).find((c) => c.status === "ready");
  if (ready) return `Review and integrate candidate ${shortSha(ready.sha)}.`;
  return "All set together.";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="insp-row">
      <span className="insp-label">{label}</span>
      <span className="insp-value">{children}</span>
    </div>
  );
}

function ListRow({ label, items }: { label: string; items: ReactNode[] }) {
  if (!items.length) return null;
  return (
    <Row label={label}>
      <ul className="insp-list">{items.map((i, k) => <li key={k}>{i}</li>)}</ul>
    </Row>
  );
}

function useAction(controller: Ctl) {
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
  return error ? <p className="insp-error" role="alert">{error}</p> : null;
}

function FieldForm({ id, label, fields, submit, disabled, onSend }: {
  id: string; label: string; fields: string[][];
  submit: string; disabled: boolean; onSend: (values: string[]) => void;
}) {
  const [values, setValues] = useState<string[]>(fields.map(() => ""));
  const ready = values.every((v) => v.trim().length > 0) && !disabled;
  return (
    <form className="insp-form" onSubmit={(e: FormEvent) => {
      e.preventDefault();
      if (ready) {
        onSend(values.map((v) => v.trim()));
        setValues(fields.map(() => ""));
      }
    }}>
      <label htmlFor={id}>{label}</label>
      {fields.map(([ph], i) => (
        <input key={ph} id={i === 0 ? id : undefined} aria-label={ph} value={values[i]}
          onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
          placeholder={ph} />
      ))}
      <button type="submit" disabled={!ready}>{submit}</button>
    </form>
  );
}

function TaskDetail({ controller, task }: { controller: Ctl; task: Task }) {
  const { state, mode } = controller;
  const leaseNow=useLeaseTime();
  const { busy, error, act } = useAction(controller);
  const asg = currentAssignment(state, task);
  const deps = task.dependencies
    .map((d) => ({ dep: state.tasks[d.taskId], kind: d.kind }))
    .filter((d) => d.dep);
  const proposals = Object.values(state.proposals).filter((p) => p.taskIds.includes(task.id));
  const files = [...new Set(proposals.flatMap((p) => p.changedPaths))];

  return (
    <>
      <h2 id="insp-title">{task.goal}</h2>
      <Row label="Status">{taskPill(task,state,mode,leaseNow)}</Row>
      {asg && claimState(state,mode,asg,leaseNow)!=='current' && <Row label="Recorded task lifecycle">{task.lifecycle}</Row>}
      <Row label="Plan revision">{String(task.requiredPlanRevisionId??"not recorded")}</Row>
      <Row label="Last update">{fmtTime(task.updatedAt)}</Row>
      {task.retiredFromPlanAt&&<Row label="Plan membership">Retired from adopted plan; work retained</Row>}
      {Array.isArray(task.planHistory)&&<Row label="Prior revisions">{task.planHistory.length} recorded in source history</Row>}
      <Row label={asg&&claimState(state,mode,asg,leaseNow)!=='current'?"Last claim":"Assigned to"}>
        {asg ? (
          <span className="insp-who">
            <img src={portraitFor(asg.identityId, nameOf(state, asg.identityId))} alt="" className="avatar" />
            {nameOf(state, asg.identityId)} · {asg.role}
          </span>
        ) : "Nobody yet"}
        {" "}{presencePill(state, mode, asg,leaseNow)}
      </Row>
      {asg && (
        <Row label="Lease">
          epoch {asg.epoch} · expires {fmtTime(asg.leaseExpiresAt)}
        </Row>
      )}
      <ListRow label="Acceptance" items={task.acceptanceCriteria} />
      <ListRow label="Depends on" items={deps.map((d) => (
        <span key={d.dep.id}>{d.dep.goal} <em>({d.kind === "prerequisite" ? "prerequisite" : "contributes changes"})</em></span>
      ))} />
      <ListRow label="Files touched" items={files.map((f) => <code key={f}>{f}</code>)} />
      <div className="insp-next">
        <ArrowRight size={16} aria-hidden /> {task.nextAction ?? "No recorded next action."}
      </div>
      <div className="insp-actions">
        <button type="button" disabled={busy || state.stopped}
          onClick={() => void act("claim-task", { taskId: task.id })}>
          Claim this task
        </button>
      </div>
      <FieldForm id="ask-help" label="Ask for help on this task"
        fields={[["What should a helper look at?"]]} submit="Send help request"
        disabled={busy || state.stopped}
        onSend={([q]) => void act("ask-help", { taskId: task.id, question: q })} />
      {state.stopped && <p className="insp-note">Project stopped — actions unavailable, inspection stays read-only.</p>}
      <ActionError error={error} />
    </>
  );
}

function CandidateDetail({ controller, cand }: { controller: Ctl; cand: Candidate }) {
  const { state, mode } = controller;
  const { busy, error, act } = useAction(controller);
  const jobs = cand.checkJobIds.map((j) => state.jobs[j]).filter(Boolean) as CheckJob[];
  const receipts = Object.values(state.receipts).filter((r) => r.candidateSha === cand.sha);
  const reviews = cand.reviewIds.map((r) => state.reviews[r]).filter(Boolean) as Review[];
  const findings = Object.values(state.findings).filter((f) => f.candidateId === cand.id);
  const proposals = cand.proposalIds.map((p) => state.proposals[p]).filter(Boolean) as Proposal[];

  return (
    <>
      <h2 id="insp-title"><GitMerge aria-hidden /> Combined candidate</h2>
      <Row label="SHA"><code>{shortSha(cand.sha)}</code></Row>
      <Row label="Status"><Pill label={cand.status} tone={cand.status === "ready" || cand.status === "integrated" ? "green" : "amber"} /></Row>
      <Row label="Base"><code>{shortSha(cand.base)}</code></Row>
      <Row label="Policy">v{cand.policyVersion}</Row>
      <ListRow label="Proposals" items={proposals.map((p) => (
        <span key={p.id}>{p.summary} <code>{shortSha(cand.proposalHeads[p.id] ?? p.head)}</code></span>
      ))} />
      <ListRow label="Checks" items={jobs.map((j) => (
        <span key={j.id}><code>{j.command}</code> — {j.status}{mode === "sample" ? " (sample)" : ""}</span>
      ))} />
      <ListRow label="Evidence" items={receipts.map((r: EvidenceReceipt) => (
        <span key={r.id}><code>{r.command}</code> — {r.outcome}</span>
      ))} />
      <ListRow label="Reviews" items={reviews.map((r) => (
        <span key={r.id}>{nameOf(state, r.reviewerId)}: {r.disposition}
          {r.independent ? " · independent" : ` · not independent (${r.independenceReason})`}</span>
      ))} />
      <ListRow label="Findings" items={findings.map((f) => (
        <span key={f.id}><Bug aria-hidden /> {f.observed} — {f.state}</span>
      ))} />
      <div className="insp-actions">
        <button type="button" disabled={busy || state.stopped}
          onClick={() => void act("request-check", { candidateId: cand.id })}>Request check</button>
        <button type="button" disabled={busy || state.stopped}
          onClick={() => void act("review-candidate", { candidateId: cand.id, disposition: "approve" })}>Approve</button>
        <button type="button" disabled={busy || state.stopped}
          onClick={() => void act("review-candidate", { candidateId: cand.id, disposition: "request-changes" })}>Request changes</button>
      </div>
      <p className="insp-note">Integration is a separate authorized operation and is unavailable here — it never runs from this panel.</p>
      <FieldForm id="f-exp" label="Report a finding on this candidate"
        fields={[["Expected behavior"], ["Observed behavior"]]} submit="Report finding"
        disabled={busy || state.stopped}
        onSend={([exp, obs]) => void act("report-finding", { candidateId: cand.id, expected: exp, observed: obs })} />
      <ActionError error={error} />
    </>
  );
}

function FindingDetail({ controller, finding }: { controller: Ctl; finding: Finding }) {
  const { state } = controller;
  const { busy, error, act } = useAction(controller);
  const cand = finding.candidateId ? state.candidates[finding.candidateId] : undefined;
  const open = finding.state === "possible-issue" || finding.state === "reproduced";
  return (
    <>
      <h2 id="insp-title"><Bug aria-hidden /> Finding</h2>
      <Row label="State"><Pill label={finding.importedUnverified ? `Imported · unverified (${finding.importedState ?? finding.state})` : finding.state} tone={finding.state === "verified-fixed" ? "green" : "amber"} /></Row>
      <Row label="Expected">{finding.expected}</Row>
      <Row label="Observed">{finding.observed}</Row>
      {finding.reproducer && <Row label="Reproduce"><code>{finding.reproducer}</code></Row>}
      {finding.severity && <Row label="Severity">{finding.severity}</Row>}
      <Row label="Reported by">{nameOf(state, finding.originatorId)}</Row>
      {cand && <Row label="Candidate"><code>{shortSha(cand.sha)}</code></Row>}
      {finding.note && <Row label="Note">{finding.note}</Row>}
      <div className="insp-actions">
        <button type="button" disabled={busy || !open || state.stopped}
          onClick={() => void act("disposition-finding", { findingId: finding.id, state: "not-reproduced" })}>Not reproduced</button>
        <button type="button" disabled={busy || !open || state.stopped}
          onClick={() => void act("disposition-finding", { findingId: finding.id, state: "withdrawn" })}>Withdraw</button>
      </div>
      <p className="insp-note">Verified fixed only derives from an authenticated recheck receipt — never from this panel.</p>
      <ActionError error={error} />
    </>
  );
}

function HelpDetail({ controller, help }: { controller: Ctl; help: HelpRequest }) {
  const { state } = controller;
  const { busy, error, act } = useAction(controller);
  const task = help.taskId ? state.tasks[help.taskId] : undefined;
  return (
    <>
      <h2 id="insp-title"><Question aria-hidden /> Help request</h2>
      <Row label="State"><Pill label={help.state} tone={help.state === "offered" ? "amber" : "blue"} /></Row>
      <Row label="Question">{help.question}</Row>
      {help.expectedContribution && <Row label="Wanted">{help.expectedContribution}</Row>}
      {task && <Row label="Task">{task.goal}</Row>}
      <Row label="From">{nameOf(state, help.offeredById)}</Row>
      {help.acceptedById && <Row label="Accepted by">{nameOf(state, help.acceptedById)}</Row>}
      {help.expiresAt && <Row label="Expires">{fmtTime(help.expiresAt)}</Row>}
      {help.answer && <Row label="Answer">{help.answer}</Row>}
      <FieldForm id="help-answer" label="Answer this request"
        fields={[["What did you find?"]]} submit="Send answer"
        disabled={busy || state.stopped}
        onSend={([a]) => void act("answer-help", { helpId: help.id, answer: a })} />
      <ActionError error={error} />
    </>
  );
}

function ProposalDetail({ controller, proposal }: { controller: Ctl; proposal: Proposal }) {
  const { state } = controller;
  return (
    <>
      <h2 id="insp-title"><FileText aria-hidden /> Change proposal</h2>
      <Row label="Summary">{proposal.summary}</Row>
      <Row label="State"><Pill label={proposal.lifecycle} tone={proposal.lifecycle === "integrated" ? "green" : "blue"} /></Row>
      <Row label="Author">{nameOf(state, proposal.authorId)}</Row>
      <Row label="Base → head"><code>{shortSha(proposal.base)} → {shortSha(proposal.head)}</code></Row>
      <Row label="Intent">{proposal.intendedBehavior}</Row>
      <ListRow label="Files" items={proposal.changedPaths.map((f) => <code key={f}>{f}</code>)} />
      <ListRow label="Unknowns" items={proposal.unknowns} />
      <Row label="Tasks">{proposal.taskIds.map((id) => state.tasks[id]?.goal ?? id).join(", ")}</Row>
    </>
  );
}

function MemberDetail({ controller, member }: { controller: Ctl; member: Member }) {
  const { state, mode } = controller;
  const identity = state.identities[member.identityId];
  const sessions = Object.values(state.sessions).filter((s) => s.identityId === member.identityId);
  return (
    <>
      <h2 id="insp-title">{identity?.displayName ?? member.identityId}</h2>
      <p><img src={portraitFor(member.identityId, nameOf(state, member.identityId))} alt="" className="avatar avatar-lg" /></p>
      <Row label="Membership">{member.kind}</Row>
      <Row label="Status">{identity?.status ?? "unknown"}</Row>
      <Row label="Claims"><MemberClaims state={state} mode={mode} identityId={member.identityId}/></Row>
      <ListRow label="Sessions" items={sessions.map((s) => (
        <span key={s.id}>{s.adapter ?? "adapter"} {s.model ? `· ${s.model}` : ""} — {s.status}
          {s.lastActivityAt ? `, seen ${fmtTime(s.lastActivityAt)}` : ""}</span>
      ))} />
      <p className="insp-note">Presence is observed activity only — a quiet session is uncertain, not dead.</p>
    </>
  );
}

function EventDetail({ controller, event }: { controller: Ctl; event: Event }) {
  const { state } = controller;
  return (
    <>
      <h2 id="insp-title">Event #{event.seq}</h2>
      <Row label="Type"><code>{event.type}</code></Row>
      <Row label="Actor">{nameOf(state, event.actorId)} ({event.actorKind})</Row>
      <Row label="At">{fmtTime(event.createdAt)}</Row>
      {event.result && <Row label="Result">{event.result}</Row>}
      {event.uncertainty && <Row label="Uncertainty">{event.uncertainty}</Row>}
      {event.humanCategory && <Row label="Human action">{event.humanCategory}</Row>}
      {event.detail !== undefined && (
        <Row label="Detail"><pre className="insp-pre">{JSON.stringify(event.detail, null, 2)}</pre></Row>
      )}
    </>
  );
}

function Summary({ controller }: { controller: Ctl }) {
  const { state, mode } = controller;
  const participants = Object.values(state.members);
  const handoff = Object.values(state.handoffs).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const readyProposals = Object.values(state.proposals).filter((p) => p.lifecycle === "ready-to-combine" || p.lifecycle === "submitted");
  const existingCandidates = Object.values(state.candidates).filter(c => !["integrated", "superseded"].includes(c.status));
  const { busy, error, act } = useAction(controller);
  return (
    <>
      <h2 id="insp-title">Building together</h2>
      <p className="insp-sub">
        Project participants and their recorded assignments. An assignment is not proof that a runtime is currently working.
        {mode === "sample" ? " Sample crew and assigned states." : ""}
      </p>
      <ul className="crew">
        {participants.map((m) => {
          return (
            <li key={m.id}>
              <img src={portraitFor(m.identityId, nameOf(state, m.identityId))} alt="" className="avatar" />
              <span className="crew-name">{nameOf(state, m.identityId)} <small>({m.kind})</small></span>
              <div className="crew-task"><MemberClaims state={state} mode={mode} identityId={m.identityId}/></div>
            </li>
          );
        })}
      </ul>
      <div className="insp-next"><ArrowRight size={16} aria-hidden /> Next: {nextActionFor(state)}</div>
      {mode === "sample" && (
        <p className="flavor"><Sparkle size={14} aria-hidden /> <span className="flavor-tag">System · scripted flavor</span> “A lot of commits. Let&apos;s see what changed.”</p>
      )}
      <div className="insp-actions">
        <button type="button" className="primary"
          onClick={() => window.dispatchEvent(new CustomEvent("together:set-view", { detail: "progress" }))}>
          View build progress <ArrowRight size={16} aria-hidden />
        </button>
        {readyProposals.length > 0 && (
          <button type="button" disabled={busy || state.stopped}
            onClick={() => void act("prepare-candidate", { proposalIds: readyProposals.map(p => p.id) })}>
            {existingCandidates.length ? "Prepare another combined candidate" : "Prepare a candidate"} from {readyProposals.length} contribution{readyProposals.length === 1 ? "" : "s"}
          </button>
        )}
        {existingCandidates.map(c => <a key={c.id} href={`/projects/${encodeURIComponent(mode === "live" ? `live:${state.project.id}` : state.project.id)}?kind=candidate&item=${encodeURIComponent(c.id)}`}>View prepared candidate {shortSha(c.sha)} · {c.status}</a>)}
      </div>
      {existingCandidates.length > 0 && readyProposals.length > 0 && <p className="insp-note">Open an existing candidate to inspect its checks. Preparing again combines all currently submitted contributions; an identical result may be reused. Preparation never integrates code.</p>}
      {handoff && (
        <details className="insp-handoff">
          <summary><FileText size={14} aria-hidden /> Read handoff</summary>
          <dl>
            <dt>Done</dt><dd>{handoff.done}</dd>
            <dt>Next</dt><dd>{handoff.next}</dd>
            <dt>Uncertain</dt><dd>{handoff.uncertain}</dd>
            <dt>Verify first</dt><dd>{handoff.verifyFirst}</dd>
            <dt>Do not repeat</dt><dd>{handoff.doNotRepeat}</dd>
          </dl>
        </details>
      )}
      <ActionError error={error} />
    </>
  );
}

export function Inspector({ controller, selection, onClose, embedded=false }: {
  controller: Ctl;
  selection: UISelection | null;
  onClose: () => void;
  embedded?: boolean;
}) {
  const { state } = controller;
  const panelRef = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = selection !== null;

  // On narrow viewports the inspector is a dismissible sheet over the main
  // list: it renders only while a record is selected, so "Close inspector"
  // and Escape actually remove it and the task list is the default view.
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 860px)").matches
      : false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 860px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (open && !embedded) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      panelRef.current?.querySelector<HTMLElement>("#insp-title, button")?.focus();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          returnFocus.current?.focus?.();
        }
      };
      document.addEventListener("keydown", onKey, true);
      return () => document.removeEventListener("keydown", onKey, true);
    }
    return undefined;
  }, [open, selection?.kind, selection?.id, onClose]);

  let body: ReactNode;
  if (!selection) {
    body = <Summary controller={controller} />;
  } else {
    const found =
      selection.kind === "task" ? state.tasks[selection.id]
      : selection.kind === "candidate" ? state.candidates[selection.id]
      : selection.kind === "proposal" ? state.proposals[selection.id]
      : selection.kind === "finding" ? state.findings[selection.id]
      : selection.kind === "member" ? state.members[selection.id]
      : selection.kind === "help" ? state.help[selection.id]
      : selection.kind === "event" ? state.events.find((e) => e.id === selection.id)
      : undefined;
    if (!found) {
      body = <p className="insp-note"><WarningCircle aria-hidden /> This {selection.kind} is no longer available.</p>;
    } else if (selection.kind === "task") {
      body = <TaskDetail controller={controller} task={found as Task} />;
    } else if (selection.kind === "candidate") {
      body = <CandidateDetail controller={controller} cand={found as Candidate} />;
    } else if (selection.kind === "proposal") {
      body = <ProposalDetail controller={controller} proposal={found as Proposal} />;
    } else if (selection.kind === "finding") {
      body = <FindingDetail controller={controller} finding={found as Finding} />;
    } else if (selection.kind === "member") {
      body = <MemberDetail controller={controller} member={found as Member} />;
    } else if (selection.kind === "event") {
      body = <EventDetail controller={controller} event={found as Event} />;
    } else {
      body = <HelpDetail controller={controller} help={found as HelpRequest} />;
    }
  }

  if (embedded) return <div className="inspector-inner">{body}</div>;
  if (narrow && !open) return null;
  return (
    <aside className={`inspector${open ? " is-open" : ""}`} ref={panelRef} aria-label="Inspector">
      <div className="inspector-inner">
        {open && <button type="button" className="inspector-close" aria-label="Close inspector"
          onClick={() => { onClose(); returnFocus.current?.focus?.(); }}>
          <X size={18} aria-hidden />
        </button>}
        {state.project.mode === "sample" && <p className="sample-tag"><CheckCircle size={14} aria-hidden /> Sample records</p>}
        {body}
      </div>
    </aside>
  );
}

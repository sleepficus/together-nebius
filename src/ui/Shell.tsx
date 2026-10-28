import {CrewInspector} from './CrewInspector.tsx';
// Navigation shell (seat b-swe-07): header brand, six exact routes,
// project picker, theme + humor-mute preferences (local-only), error bar,
// and the shared Inspector column beside routed page content.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Bug, Clover, Confetti, Flask, FlowArrow, GitPullRequest, House, Moon,
  ChatCircle, Plus, Sun, Users, WarningCircle,
} from "@phosphor-icons/react";
import type { ProjectState } from "../../lib/types.ts";
import { LiveAccess } from './LiveAccess.tsx';
import { fmtTime } from "./Inspector.tsx";

export type RouteName =
  | "overview" | "project" | "crew" | "changes" | "findings" | "experiments";

export interface ShellRoute {
  name: RouteName;
  projectId?: string;
  view?: 'talk';
}

export interface UISelection {
  kind: "task" | "candidate" | "proposal" | "finding" | "member" | "event" | "help";
  id: string;
}

/** Structural shape of the 09 useProject() controller. */
export interface UIController {
  state: ProjectState;
  mode: "sample" | "live";
  action(type: string, payload?: unknown): Promise<unknown>;
  projects: ProjectState[];
  activeProjectId: string;
  selectProject(id: string): void;
  error: string | null;
  connectionUnavailable?: boolean;
  clearError(): void;
}

const THEME_KEY = "together.theme";
const HUMOR_KEY = "together.muteHumor";

function pref(key: string, fallback: string): string {
  if (typeof localStorage === "undefined") return fallback;
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function savePref(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

function NavLink({ href, active, icon, label, onNavigate, disabled }: {
  href: string; active: boolean; icon: ReactNode; label: string;
  onNavigate: (path: string) => void; disabled?: boolean;
}) {
  return (
    <a
      href={disabled ? undefined : href}
      className={`navlink${active ? " active" : ""}${disabled ? " disabled" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        e.preventDefault();
        if (!disabled) onNavigate(href);
      }}
    >
      {icon}
      <span>{label}</span>
    </a>
  );
}

export function Shell({ controller, route, onNavigate, children, selection, onSelect }: {
  controller: UIController;
  route: ShellRoute;
  onNavigate: (path: string) => void;
  children: ReactNode;
  selection: UISelection | null;
  onSelect: (sel: UISelection | null) => void;
}) {
  const { state, mode } = controller;
  const talking = route.view === 'talk';
  const pid = controller.activeProjectId || route.projectId || "";
  const [theme, setTheme] = useState(() => pref(THEME_KEY, "light"));
  const [humorMuted, setHumorMuted] = useState(() => pref(HUMOR_KEY, "off") === "on");

  useEffect(()=>{const header=document.querySelector('.shell-header');if(!header)return;const measure=()=>document.documentElement.style.setProperty('--together-header-height',header.getBoundingClientRect().height+'px');measure();if(typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(measure);observer.observe(header);return()=>observer.disconnect();},[]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    savePref(THEME_KEY, theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.humor = humorMuted ? "muted" : "on";
    savePref(HUMOR_KEY, humorMuted ? "on" : "off");
  }, [humorMuted]);

  const projectBase = pid ? `/projects/${encodeURIComponent(mode === 'live' ? `live:${pid}` : pid)}` : "";
  const nav = [
    { name: "overview" as RouteName, label: "Overview", icon: <House size={16} aria-hidden />, href: "/" },
    { name: "project" as RouteName, label: "Project", icon: <FlowArrow size={16} aria-hidden />, href: projectBase },
    { name: "crew" as RouteName, label: "Crew", icon: <Users size={16} aria-hidden />, href: `${projectBase}/crew` },
    { name: "changes" as RouteName, label: "Changes", icon: <GitPullRequest size={16} aria-hidden />, href: `${projectBase}/changes` },
    { name: "findings" as RouteName, label: "Findings", icon: <Bug size={16} aria-hidden />, href: `${projectBase}/findings` },
    { name: "experiments" as RouteName, label: "Experiments", icon: <Flask size={16} aria-hidden />, href: "/experiments" },
  ];

  const onPickProject = useCallback((key: string) => {
    if (!key) return;
    // Picker values carry a mode prefix; URLs keep the bare project id.
    const id = key.startsWith("live:") ? key.slice(5)
      : key.startsWith("sample:") ? key.slice(7) : key;
    controller.selectProject(key);
    onNavigate(`/projects/${encodeURIComponent(key.startsWith('live:') ? key : id)}`);
  }, [controller, onNavigate]);

  return (
    <div className={`shell${talking ? ' talk-mode' : ''}${route.name==='overview'?' overview-mode':''}`}>
      <header className="shell-header">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); onNavigate("/"); }}>
          <Clover size={28} weight="fill" aria-hidden className="brand-icon" />
          <span className="brand-name">Together</span>
        </a>
        <div className="header-context">
          <span className={`context-dot${mode === "sample" ? " sample" : ""}`} aria-hidden />
          <span className="context-name">
            {mode === "sample" ? "Sample workspace" : "Crew workspace"}
          </span>
          <span className="context-sub">Last updated {fmtTime(state.project.updatedAt)}</span>
        </div>
        <nav className="shell-nav" aria-label="Project">
          <NavLink href={`${projectBase}?view=talk`} label="Talk to the crew" icon={<ChatCircle size={16} aria-hidden />} active={talking} disabled={!pid} onNavigate={onNavigate}/>
          {nav.map((n) => (
            <NavLink key={n.name} {...n} label={n.name==='project'?'Work map':n.label} active={!talking && route.name === n.name}
              disabled={n.name !== "overview" && n.name !== "experiments" && !pid}
              onNavigate={onNavigate} />
          ))}
        </nav>
        <div className="header-tools">
          <label className="project-picker">
            <span className="sr-only">Active project</span>
            <select
              value={mode === "live" ? `live:${pid}` : `sample:${pid}`}
              onChange={(e) => onPickProject(e.target.value)}>
              {controller.projects.length === 0 && <option value="">No projects</option>}
              {controller.projects.map((p) => (
                <option key={`${p.project.mode}:${p.project.id}`}
                  value={p.project.mode === "live" ? `live:${p.project.id}` : `sample:${p.project.id}`}>
                  {p.project.goal.slice(0, 32)}{p.project.mode === "sample" ? " (sample)" : " (live)"}
                </option>
              ))}
            </select>
          </label>
          <details className="header-preferences"><summary>Display</summary><div className="display-options"><div className="theme-switch" role="group" aria-label="Theme">
            <button type="button" aria-pressed={theme === "light"} title="Light theme"
              onClick={() => setTheme("light")}><Sun size={16} aria-hidden /></button>
            <button type="button" aria-pressed={theme === "dark"} title="Dark theme"
              onClick={() => setTheme("dark")}><Moon size={16} aria-hidden /></button>
          </div>
          <button type="button" className="humor-toggle" aria-pressed={humorMuted}
            title={humorMuted ? "Show scripted flavor" : "Mute scripted flavor"}
            onClick={() => setHumorMuted((m) => !m)}>
            <Confetti size={16} aria-hidden />
          </button>
          </div></details>
          {route.name !== 'project' && <button type="button" className="add-work" disabled={!pid || state.stopped}
            onClick={() => {
              if (!pid) return;
              // Same purposeful flow as the project page's Add task: land on
              // the project and open the bounded create form. The flag covers
              // a cross-route mount; the event an already-mounted view.
              if (typeof window !== "undefined") {
                try { sessionStorage.setItem("together.composeTask", "1"); } catch { /* private mode */ }
                window.dispatchEvent(new CustomEvent("together:compose-task"));
              }
              onNavigate(projectBase);
            }}>
            <Plus size={16} aria-hidden /> Add work
          </button>}
          <LiveAccess controller={controller} onNavigate={onNavigate} />
          <span className="user-badge" aria-label={mode === "live" ? "Live owner" : "Sample owner"}>
            {String(state.project.actorId ?? "?").slice(0, 2).toUpperCase()}
          </span>
        </div>
      </header>
      {controller.error && (
        <div className="error-bar" role="alert">
          <WarningCircle size={16} aria-hidden />
          {controller.connectionUnavailable?<div><span>Live connection unavailable. Your work is retained; current status can’t be confirmed.</span><details><summary>Connection details</summary>{controller.error}</details></div>:<span>{controller.error}</span>}
          <button type="button" onClick={() => controller.clearError()}>Dismiss</button>
        </div>
      )}
      <div className="shell-body">
        <main className="shell-main" hidden={talking}>{children}</main>
        <CrewInspector controller={controller} selection={selection}
          expanded={talking} onTalk={() => onNavigate(`${projectBase}?view=talk`)}
          onClose={() => talking ? onNavigate(projectBase) : onSelect(null)} />
      </div>
    </div>
  );
}

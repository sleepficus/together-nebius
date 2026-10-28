import {LeaseClock} from './ui/lease-clock.tsx';
import './ui/collaboration-questions.css';
import {CollaborationQuestions} from './ui/CollaborationQuestions.tsx';
import {SharedWork} from './ui/SharedWork.tsx';
// App root (seat b-swe-07): one 09 controller, six-route history router,
// ?kind=&item= selection restore, Browser Back restores route + selection.
import { useCallback, useEffect, useState } from "react";
import { useProject } from "./data/useProject.ts";
import {
  ChangesPage, CrewPage, ExperimentsPage, FindingsPage, OverviewPage,
} from "./pages/Pages.tsx";
import { Shell } from "./ui/Shell.tsx";
import type { RouteName, ShellRoute, UISelection } from "./ui/Shell.tsx";
import { ProjectView } from "./ui/ProjectView.tsx";

const KINDS = new Set(["task", "candidate", "proposal", "finding", "member", "event", "help"]);

function loc(): { pathname: string; search: string } {
  if (typeof window === "undefined" || !window.location) {
    return { pathname: "/", search: "" };
  }
  return window.location;
}

function parseLocation(l: { pathname: string; search: string }): {
  route: ShellRoute; selection: UISelection | null;
} {
  let route: ShellRoute = { name: "overview" };
  const path = l.pathname.replace(/\/+$/, "") || "/";
  const m = path.match(/^\/projects\/([^/]+)(?:\/(crew|changes|findings))?$/);
  if (["/crew", "/changes", "/findings"].includes(path)) {
    route = { name: path.slice(1) as RouteName };
  } else if (path === "/experiments") {
    route = { name: "experiments" };
  } else if (m) {
    route = { name: (m[2] ?? "project") as RouteName, projectId: decodeURIComponent(m[1]) };
  }
  const params = new URLSearchParams(l.search);
  if (route.name === 'project' && params.get('view') === 'talk') route.view = 'talk';
  const kind = params.get("kind");
  const item = params.get("item");
  const selection = kind && item && KINDS.has(kind)
    ? { kind: kind as UISelection["kind"], id: item }
    : null;
  return { route, selection };
}

export default function App() {
  const controller = useProject();
  const [{ route, selection }, setLoc] = useState(() => parseLocation(loc()));

  useEffect(() => {
    const onPop = () => {
      setLoc(parseLocation(loc()));
      const y = (window.history.state as { scrollY?: number } | null)?.scrollY;
      if (typeof y === "number") requestAnimationFrame(() => window.scrollTo(0, y));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Cloud wiring: a durable same-origin browser session (cookie) resumes
  // live mode silently on load; unauthenticated sessions stay on sample
  // with no fabricated failure, and Connect live stays manual.
  useEffect(() => {
    if (controller.mode === "sample") {
      void controller.action("connect-live").catch(() => undefined);
    }
    // Once on mount — the controller object is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One lifecycle-bound work-event reader. Chat delivery/opened cursors and
  // provider runtimes are deliberately outside this refresh path.
  useEffect(() => {
    if (controller.mode !== 'live' || !controller.pollEvents) return;
    let stopped=false, inFlight=false, timer:ReturnType<typeof setTimeout>;
    const update=async()=>{
      clearTimeout(timer);if(stopped||inFlight)return;inFlight=true;
      try {await controller.pollEvents!();} catch { /* Retain work and retry the existing read path. */ } finally {inFlight=false;if(!stopped)timer=setTimeout(update,document.hidden?30000:2000);}
    };
    const visible=()=>{if(!document.hidden)void update();};
    void update();document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[controller,controller.mode,controller.activeProjectId]);

  const push = useCallback((url: string, scroll: "top" | "keep") => {
    if (typeof window === "undefined") return;
    if(url!==window.location.pathname+window.location.search&&!window.dispatchEvent(new CustomEvent("together:before-navigate",{cancelable:true})))return;
    const here = window.location.pathname + window.location.search;
    window.history.replaceState({ scrollY: window.scrollY }, "", here);
    if (url !== here) window.history.pushState({ scrollY: 0 }, "", url);
    setLoc(parseLocation(loc()));
    if (scroll === "top") window.scrollTo(0, 0);
  }, []);

  const onNavigate = useCallback((path: string) => push(path, "top"), [push]);

  const onSelect = useCallback((sel: UISelection | null) => {
    const l = loc();
    const params = new URLSearchParams(l.search);
    if (sel) {
      params.set("kind", sel.kind);
      params.set("item", sel.id);
    } else {
      params.delete("kind");
      params.delete("item");
    }
    const q = params.toString();
    push(l.pathname + (q ? `?${q}` : ""), "keep");
  }, [push]);

  // Route-chosen project becomes the controller's active project.
  useEffect(() => {
    if (route.projectId && route.projectId !== controller.activeProjectId && route.projectId !== `${controller.mode}:${controller.activeProjectId}`) {
      controller.selectProject(route.projectId);
    }
  }, [route.projectId, controller]);

  // Page JSX is recomputed every render: the controller reference is stable
  // while its state mutates, so memoizing on it would freeze the page.
  const props = { controller, selection, onSelect, onNavigate };
  const page = (() => {
    switch (route.name) {
      case "project":
        return route.view==='talk' ? null : <div><ProjectView controller={controller} selection={selection} onSelect={onSelect} /><details className="work-context"><summary>Collaboration decisions &amp; evidence</summary><CollaborationQuestions controller={controller}/></details><SharedWork controller={controller}/></div>;
      case "crew":
        return <CrewPage {...props} />;
      case "changes":
        return <ChangesPage {...props} />;
      case "findings":
        return <FindingsPage {...props} />;
      case "experiments":
        return <ExperimentsPage {...props} />;
      default:
        return <OverviewPage {...props} />;
    }
  })();

  return (
    <LeaseClock state={controller.state} mode={controller.mode}><Shell controller={controller} route={route} onNavigate={onNavigate}
      selection={selection} onSelect={onSelect}>
      {page}
    </Shell></LeaseClock>
  );
}

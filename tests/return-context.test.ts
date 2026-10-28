import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {ReturnBrief} from '../src/ui/CrewInspector.tsx';
import type {UIController} from '../src/ui/Shell.tsx';
import {createState} from '../lib/core.ts';

test('Return to work hides an obsolete plan or stop state, including late responses', async () => {
  const dom = new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
  const keys = ['window','document','navigator','fetch','IS_REACT_ACT_ENVIRONMENT'];
  const saved = new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const put = (k:string,v:unknown)=>Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});
  put('window',dom.window);put('document',dom.window.document);put('navigator',dom.window.navigator);put('IS_REACT_ACT_ENVIRONMENT',true);
  const brief = {revisionId:1,planRevisionId:'plan-a',stopped:false,omissions:[]};
  let finish: (r:Response)=>void;
  put('fetch',()=>new Promise<Response>(resolve=>{finish=resolve}));
  const {createRoot} = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const controller = (revision:number,plan:string,stopped:boolean):UIController=>{
    const state=createState({id:'fixture',goal:'Context freshness regression',mode:'sample',actorId:'fixture-owner',now:'2026-10-05T06:00:00Z'});
    state.project.revision=revision;state.project.adoptedPlanRevisionId=plan;state.stopped=stopped;
    return {mode:'live',activeProjectId:'fixture',state,projects:[state],action:async()=>undefined,selectProject:()=>{},error:null,clearError:()=>{}};
  };
  const render = async(c:UIController)=>act(async()=>root.render(createElement(ReturnBrief,{controller:c})));
  const read = async()=>act(async()=>{document.querySelector('button')!.click()});
  const respond = async(value:any)=>act(async()=>{finish(new Response(JSON.stringify(value),{status:200}));});
  try {
    await render(controller(1,'plan-a',false));await read();await respond(brief);
    assert.match(document.body.textContent!,/Project open/);
    await render(controller(1,'plan-a',true));
    assert.doesNotMatch(document.body.textContent!,/Project open/);
    assert.match(document.body.textContent!,/Workspace changed/);
    await render(controller(1,'plan-b',false));
    assert.doesNotMatch(document.body.textContent!,/Plan: plan-a/);
    await read();await render(controller(2,'plan-b',true));await respond(brief);
    assert.doesNotMatch(document.body.textContent!,/Project open|Plan: plan-a/);
    await read();await respond({...brief,revisionId:2,planRevisionId:'plan-b',stopped:true});
    assert.match(document.body.textContent!,/Plan: plan-b/);
    assert.match(document.body.textContent!,/New worker writes stopped/);
  } finally {
    await act(async()=>root.unmount());dom.window.close();
    for(const [k,d] of saved){if(d)Object.defineProperty(globalThis,k,d);else delete (globalThis as any)[k];}
  }
});

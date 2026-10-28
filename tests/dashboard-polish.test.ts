import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readApiJson} from '../src/ui/api-json.ts';
import {createProjectController} from '../src/data/useProject.ts';
import {createState} from '../lib/core.ts';
import {register} from 'node:module';
import {CollaborationQuestions} from '../src/ui/CollaborationQuestions.tsx';
import {Shell} from '../src/ui/Shell.tsx';
register('data:text/javascript,'+encodeURIComponent('export async function load(url,ctx,next){if(url.endsWith(".css"))return {format:"module",source:"export default {};",shortCircuit:true};return next(url,ctx);}'));
const {OverviewPage}=await import('../src/pages/Pages.tsx');

test('polish: proxy HTML and empty responses never surface raw JSON errors or HTML',async()=>{
 for(const response of [new Response('<html>private proxy detail</html>',{status:502}),new Response('',{status:200})]){
  await assert.rejects(readApiJson(response),(e:any)=>e.status===response.status&&/server response/.test(e.message)&&!e.message.includes('<html>')&&!e.message.includes('Unexpected'));
 }
 await assert.rejects(readApiJson(new Response(JSON.stringify({error:{message:'internal upstream stack'}}),{status:503})),/temporarily unavailable/);
 await assert.rejects(readApiJson(new Response('{}',{status:401})),/Reconnect.*draft/);
});
test('polish: domain rejection reasons remain useful and success remains unchanged',async()=>{
 await assert.rejects(readApiJson(new Response(JSON.stringify({error:{message:'Candidate SHA changed'}}),{status:409})),/Candidate SHA changed/);
 assert.deepEqual(await readApiJson(Response.json({ok:true})),{ok:true});
});
test('polish: unavailable live dashboard hides false zero/no-blocker assurances',()=>{
 const state=createState({id:'p',goal:'Private trial',mode:'live'});
 const controller={state,mode:'live',activeProjectId:'p',projects:[state],connectionUnavailable:true,error:null,action:async()=>({ok:true}),selectProject:()=>{},clearError:()=>{}} as any;
 const html=renderToStaticMarkup(createElement(OverviewPage,{controller,selection:null,onSelect:()=>{},onNavigate:()=>{}}));
 assert.match(html,/Counts and blocker status are unknown/);assert.doesNotMatch(html,/No blockers right now|No blockers recorded|class="stat"/);
 const answers=renderToStaticMarkup(createElement(CollaborationQuestions,{controller}));
 assert.match(answers,/Current status unavailable/);assert.doesNotMatch(answers,/No detected code conflict|No candidate reviews recorded/);
});
test('polish: dismissing a connection error does not restore false availability; successful refresh does',async()=>{
 const live=createState({id:'p',goal:'Live test',mode:'live'});let down=false;
 const controller=createProjectController({storage:null,fetcher:async()=>down?new Response('<html>bad gateway</html>',{status:502}):Response.json(live)});
 controller.selectProject('live:p');await new Promise(r=>setTimeout(r,0));assert.equal(controller.mode,'live');
 down=true;await controller.action('refresh');assert.equal(controller.connectionUnavailable,true);
 controller.clearError();assert.equal(controller.connectionUnavailable,true);assert.equal(controller.state.project.goal,'Live test');
 down=false;await controller.action('refresh');assert.equal(controller.connectionUnavailable,false);assert.equal(controller.error,null);
});
test('polish: roomy chat has a direct URL and preserves the existing mounted conversations',()=>{
 const controller=createProjectController({storage:null,fetcher:null});
 const html=renderToStaticMarkup(createElement(Shell,{controller,route:{name:'project',view:'talk'},onNavigate:()=>{},children:null,selection:null,onSelect:()=>{}}));
 assert.match(html,/view=talk/);assert.match(html,/chat-workspace/);assert.match(html,/Work map/);
 assert.match(html,/compose-team/);assert.match(html,/compose-lounge/);assert.match(html,/Our crew/);
 assert.doesNotMatch(html,/class="add-work"/); // Only the work-map create control remains.
});
test('polish: a broken project listing is not mistaken for a successful connection with no projects',async()=>{
 const c=createProjectController({storage:null,fetcher:async path=>path.endsWith('/session')?Response.json({ok:true}):new Response('<html>upstream down</html>',{status:502})});
 await assert.rejects(c.action('connect-live'),/server response/);assert.equal(c.mode,'sample');
});

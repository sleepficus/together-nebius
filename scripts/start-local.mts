// Local startup over the shared API. Existing saved state is reopened;
// provider inference and external agent work require explicit actions.
import {mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, lstatSync, chmodSync,realpathSync} from 'node:fs';
import {resolve, dirname, basename, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createServer as createNetServer} from 'node:net';
import {createServer as createViteServer} from 'vite';
import react from '@vitejs/plugin-react';
import {startLocalServer} from '../cloud/local-server.ts';
import {ensureWorkspace,fixedDemoRunner,CHECK_COMMAND} from '../local/demo-workspace.ts';
import {LocalNemo} from '../local/nemo.ts';
import type {RunnerService} from '../lib/types.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host='127.0.0.1';
function cliPort(value:string, name:string):number {
  if(!/^\d+$/.test(value)||Number(value)<0||Number(value)>65535)throw new Error(`${name} must be 0..65535 (0 chooses a free port)`);
  return Number(value);
}
export function parseOptions(args:string[], env:NodeJS.ProcessEnv=process.env){
  let port=cliPort(env.TOGETHER_DEMO_PORT??'0','UI port');
  let apiPort=cliPort(env.TOGETHER_DEMO_API_PORT??'0','API port');
  let stateDir=resolve(env.TOGETHER_STATE_DIR??resolve(root,'.runtime/local'));
  for(let i=0;i<args.length;i++){
    if(args[i]==='--port')port=cliPort(args[++i]??'','UI port');
    else if(args[i]==='--api-port')apiPort=cliPort(args[++i]??'','API port');
    else if(args[i]==='--state-dir'){const value=args[++i];if(!value?.trim())throw Error('--state-dir needs a directory');stateDir=resolve(value);}
    else throw new Error('Use: npm start -- [--port NUMBER] [--api-port NUMBER] [--state-dir PATH]');
  }
  if(port!==0&&port===apiPort)throw new Error('UI and API ports must differ');
  return {port,apiPort,stateDir};
}
async function portAvailable(port:number){
  const server=createNetServer();
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(port,host,yes);});
  const address=server.address();const available=typeof address==='object'&&address?address.port:port;
  await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));
  return available;
}
function plannedRealPath(path:string){
  let ancestor=path;const suffix:string[]=[];
  while(!existsSync(ancestor)){suffix.unshift(basename(ancestor));const parent=dirname(ancestor);if(parent===ancestor)throw Error('State directory has no existing parent');ancestor=parent;}
  return resolve(realpathSync(ancestor),...suffix);
}
export async function startDemo(options:{port:number;apiPort:number;stateDir?:string}){
  const uiPort=await portAvailable(options.port);await portAvailable(options.apiPort);
  const runtime=resolve(root,'.runtime');
  mkdirSync(runtime,{recursive:true,mode:0o700});
  const stat=lstatSync(runtime);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid()))throw new Error('.runtime must be an owned regular directory');
  chmodSync(runtime,0o700);
  const stateDir=resolve(options.stateDir??resolve(runtime,'local'));
  const realState=plannedRealPath(stateDir),publicRoot=realpathSync(resolve(root,'public'));
  if(realState===publicRoot||realState.startsWith(publicRoot+sep))throw Error('Private state must be outside the public asset tree');
  if(realState===realpathSync(root))throw Error('Use a separate private state directory, not the source root');
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  const stateStat=lstatSync(stateDir);if(!stateStat.isDirectory()||stateStat.isSymbolicLink()||(process.getuid&&stateStat.uid!==process.getuid()))throw Error('State must be an owned regular directory');chmodSync(stateDir,0o700);
  const lock=resolve(stateDir,'app.lock');
  if(existsSync(lock)){const prior=JSON.parse(readFileSync(lock,'utf8'));let alive=true;try{process.kill(prior.pid,0)}catch{alive=false}if(alive)throw Error('This local workspace is already open');unlinkSync(lock);}
  writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
  const tokenFile=resolve(stateDir,'owner-token');
  if(!existsSync(tokenFile))writeFileSync(tokenFile,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  if(lstatSync(tokenFile).isSymbolicLink())throw Error('Owner token must be a regular file');chmodSync(tokenFile,0o600);
  const token=readFileSync(tokenFile,'utf8').trim();
  const projectId='local-demo';
  const repo=ensureWorkspace(stateDir),nemoState=resolve(stateDir,'nemo');let nemo:LocalNemo;let checker:RunnerService;
  const local=startLocalServer({port:options.apiPort,ownerTokens:[{ownerId:'demo-owner',token}],stateDir,sessionTtlSeconds:30*86400,
    gitRepo:repo,gitProjectId:projectId,defaultCheckCommand:CHECK_COMMAND,
    localAgent:{fetch:(request,pid)=>nemo.fetch(request,pid)},
    runnerFactory:collector=>(checker=fixedDemoRunner(repo,nemoState,collector,result=>nemo.recordCheck(result))),
    seedProjects:[{id:projectId,goal:'Your first Together project'}]});
  nemo=new LocalNemo({stateDir:nemoState,repo,projectId,ownerToken:token,api:local.api,requireSharedTask:true,cancelCheck:jobId=>checker.cancel({projectId,jobId}),key:()=>{
    if(process.env.NEBIUS_API_KEY)return process.env.NEBIUS_API_KEY;
    try{return process.env.NEBIUS_API_KEY_FILE?readFileSync(process.env.NEBIUS_API_KEY_FILE,'utf8').trim():undefined}catch{return undefined}
  }});
  let vite:Awaited<ReturnType<typeof createViteServer>>|undefined;
  const close=async()=>{
    await nemo.close();
    await vite?.close();
    local.server.closeAllConnections();
    if(local.server.listening)await new Promise<void>((done,fail)=>local.server.close(error=>error?fail(error):done()));
    if(existsSync(lock))unlinkSync(lock);
  };
  try{
    const apiPort=await local.listening;
    let origin='';
    const destination=`/projects/${encodeURIComponent('live:'+projectId)}?view=talk`;
    vite=await createViteServer({root,configFile:false,plugins:[react(),{
      name:'together-disposable-local-login',
      configureServer(server){server.middlewares.use(async(req,res,next)=>{
        let path:string;try{path=decodeURIComponent(new URL(req.url??'/', 'http://localhost').pathname)}catch{res.statusCode=400;res.end('Invalid path');return;}
        const diskPath=path.startsWith('/@fs/')?resolve(path.slice(4)):resolve(root,'.'+path);
        if(diskPath===stateDir||diskPath.startsWith(stateDir+sep)||/(?:^|\/)(?:\.runtime|\.private|\.git|\.env(?:\.[^/]*)?)(?:\/|$)/.test(path)){res.statusCode=403;res.end('Private local files are not served');return;}
        if(req.url!=='/local-login')return next();
        res.setHeader('cache-control','no-store');
        if(req.method==='GET'){
          res.setHeader('content-type','text/html; charset=utf-8');
          res.end(`<!doctype html><html><title>Together local</title><body><h1>Together, on your computer</h1><p>Opening your saved local workspace. Nemotron runs only when you ask. Sample mode remains available at <a href="/">Overview</a>.</p><p id="status"></p><script>fetch('/local-login',{method:'POST',credentials:'same-origin'}).then(r=>{if(!r.ok)throw Error('Local sign-in failed');location.replace(${JSON.stringify(destination)})}).catch(e=>document.getElementById('status').textContent=e.message)</script></body></html>`);
          return;
        }
        if(req.method!=='POST'||req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){
          res.statusCode=403;res.end('Same-origin local sign-in required');return;
        }
        try{
          const reply=await local.api.fetch(new Request(`http://${host}:${apiPort}/api/v1/session`,{
            method:'POST',headers:{authorization:`Bearer ${token}`,origin}}));
          res.statusCode=reply.status;
          const cookie=reply.headers.get('set-cookie');if(cookie)res.setHeader('set-cookie',cookie);
          res.setHeader('content-type','application/json');res.end(JSON.stringify({signedIn:reply.ok,destination}));
        }catch{res.statusCode=500;res.end('Local sign-in unavailable');}
      });}
    }],server:{host,port:uiPort,strictPort:true,allowedHosts:['127.0.0.1','localhost'],
      fs:{strict:true,deny:['.env','.env.*','**/.git/**','**/.runtime/**','**/.private/**','*.{crt,pem,key}',stateDir.replaceAll('\\','/')+'/**']},
      proxy:{'/api':`http://${host}:${apiPort}`}},build:{target:'es2022'},
      optimizeDeps:{include:['react','react-dom/client']}});
    await vite.listen();
    // Finish dependency scanning before exposing startup/shutdown to callers.
    await vite.environments.client.depsOptimizer?.scanProcessing;
    const address=vite.httpServer!.address();
    const port=typeof address==='object'&&address?address.port:options.port;
    origin=`http://${host}:${port}`;
    writeFileSync(lock,JSON.stringify({pid:process.pid,origin,apiOrigin:`http://${host}:${apiPort}`,projectId}),{mode:0o600});
    return {origin,apiOrigin:`http://${host}:${apiPort}`,stateDir,projectId,close};
  }catch(error){await close();throw error;}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const demo=await startDemo(parseOptions(process.argv.slice(2)));
    console.log(`Together local workspace: ${demo.origin}/local-login`);
    console.log(`Sample mode: ${demo.origin}/ — sample activity stays separate.`);
    console.log('Connect your agent with npm run agent:setup. No inference starts automatically. Ctrl-C stops this installation.');
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;await demo.close();};
    process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  }catch(error){console.error(error instanceof Error?error.message:'Local startup failed');process.exitCode=1;}
}

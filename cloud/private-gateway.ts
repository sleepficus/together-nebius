import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {readFileSync,statSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import type {LocalApi} from './local-server.ts';

export interface PrivateGatewayOptions {
  api:LocalApi;
  ownerToken:string;
  origin:string;
  assetRoot:string;
  projectId:string;
  /** Login verified by loopback-only Tailscale Serve, never by display name. */
  allowedTailscaleLogin:string;
  /** The same trusted Mac can open its own local seat. Default is false. */
  allowLocalSeat?:boolean;
  imageHandler?:(req:IncomingMessage,res:ServerResponse,expectedOrigin:string,headers:Record<string,string>)=>Promise<boolean>;
}

const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const BASE_HEADERS={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const MIME:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.json':'application/json'};

/** Private crew entrance. Bind ONLY to loopback and expose through Serve,
 * which strips spoofed identity headers before inserting its own. Never
 * expose with Funnel or use arbitrary forwarded headers as human authority.
 * Credentials stay server-side; no invitation/token URL or shutdown timer.
 */
export function privateGateway(opts:PrivateGatewayOptions) {
  const remoteOrigin=new URL(opts.origin);
  if(remoteOrigin.protocol!=='https:'||remoteOrigin.username||remoteOrigin.password||remoteOrigin.pathname!=='/'||!opts.allowedTailscaleLogin)throw new Error('Private gateway requires an HTTPS origin and an approved Tailscale login');
  const redirect=`/projects/${encodeURIComponent('live:'+opts.projectId)}?view=talk`;
  const root=resolve(opts.assetRoot);
  const server=createServer(async(req,res)=>{
    const send=(status:number,body:string,headers:Record<string,string>={})=>{res.writeHead(status,{...BASE_HEADERS,...headers});res.end(body)};
    try {
      if(!LOOPBACK.has(req.socket.remoteAddress??''))return send(403,'Use the private crew entrance.');
      const port=(server.address() as {port:number})?.port;
      const host=req.headers.host??'';
      const local=host===`127.0.0.1:${port}`||host===`localhost:${port}`;
      if(!local&&host!==remoteOrigin.host)return send(403,'Unknown host');
      const expectedOrigin=local?'http://'+host:remoteOrigin.origin;
      const url=new URL(req.url??'/',expectedOrigin),path=url.pathname;
      const loginAllowed=local?opts.allowLocalSeat===true:req.headers['tailscale-user-login']===opts.allowedTailscaleLogin;
      const assertBrowserWrite=()=>req.headers.origin===expectedOrigin&&req.headers['sec-fetch-site']!=='cross-site';
      const sessionRequest=()=>new Request('http://127.0.0.1/api/v1/session',{headers:{cookie:req.headers.cookie??''}});
      if(path==='/api/v1/login-options'&&req.method==='GET')return send(200,JSON.stringify({loginUrl:'/login',method:'private-device',available:loginAllowed}),{'content-type':'application/json'});
      if(path==='/login') {
        if(!['GET','POST'].includes(req.method??''))return send(405,'Use Sign in.');
        if(!loginAllowed)return send(403,'Open this page from Steve’s signed-in Tailscale device.');
        if(req.method==='GET') {
          if((await opts.api.fetch(sessionRequest())).ok)return send(303,'Welcome back.',{location:redirect});
          const nonce=randomBytes(18).toString('base64');
          return send(200,`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Together</title><style>body{font:18px system-ui;background:#f8f6ed;color:#203d30;margin:0;padding:28px}main{max-width:480px;margin:10vh auto}button{background:#24533f;color:#fff;border:0;border-radius:14px;font:inherit;font-weight:700;padding:18px 24px;width:100%;cursor:pointer}p{line-height:1.6}small{color:#57695d}</style><main><h1>Welcome back, Hooman ☕</h1><p>Your crew and conversations are right where you left them.</p><form method="post" action="/login"><button>Sign in as Steve</button></form><p id="login-status" role="status"></p><p><small>Your private device is already verified. Stay signed in for 30 days, or sign out whenever you like. No token to paste.</small></p></main><script nonce="${nonce}">document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button'),status=document.getElementById('login-status');button.disabled=true;status.textContent='Opening your seat…';try{const response=await fetch('/login',{method:'POST',credentials:'same-origin',headers:{accept:'application/json'}});if(!response.ok)throw new Error(await response.text());const result=await response.json();location.assign(result.redirect)}catch(error){status.textContent=error.message;button.disabled=false}});</script></html>`,{'content-type':'text/html; charset=utf-8','content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`});
        }
        if(!assertBrowserWrite())return send(403,'Sign in using the button on this page.');
        const response=await opts.api.fetch(new Request('http://127.0.0.1/api/v1/session',{method:'POST',headers:{authorization:'Bearer '+opts.ownerToken,origin:expectedOrigin}}));
        if(!response.ok)return send(response.status,'Sign-in is unavailable. Your conversations are saved.');
        if(req.headers.accept?.includes('application/json'))return send(200,JSON.stringify({redirect}),{'content-type':'application/json','set-cookie':response.headers.get('set-cookie')!});
        return send(303,'Your seat is ready.',{'set-cookie':response.headers.get('set-cookie')!,location:redirect});
      }
      // Retired invitations go to normal sign-in, never disclose/consume their
      // codes. Old bookmarks still work after the pilot closes.
      if(path.startsWith('/join/')&&req.method==='GET')return send(303,'Use Sign in.',{location:'/login'});
      delete req.headers.authorization;
      if(opts.imageHandler&&await opts.imageHandler(req,res,expectedOrigin,BASE_HEADERS))return;
      if(path.startsWith('/api/')) {
        if(path==='/api/v1/session'&&req.method==='POST')return send(403,'Use Sign in at /login.');
        if(!['GET','HEAD','OPTIONS'].includes(req.method??'')&&!assertBrowserWrite())return send(403,'Use your own crew page.');
        let bytes=0;const chunks:Buffer[]=[];
        for await(const chunk of req){bytes+=chunk.length;if(bytes>256*1024)return send(413,'Request too large');chunks.push(chunk)}
        const forwarded=new Headers();
        for(const key of ['content-type','cookie','origin','sec-fetch-site'])if(typeof req.headers[key]==='string')forwarded.set(key,req.headers[key] as string);
        const response=await opts.api.fetch(new Request('http://127.0.0.1'+path+url.search,{method:req.method,headers:forwarded,...(!['GET','HEAD'].includes(req.method??'GET')?{body:Buffer.concat(chunks)}:{})}));
        res.writeHead(response.status,{...BASE_HEADERS,...Object.fromEntries(response.headers)});res.end(Buffer.from(await response.arrayBuffer()));return;
      }
      if(!['GET','HEAD'].includes(req.method??''))return send(405,'Read-only assets');
      let file=resolve(root,'.'+decodeURIComponent(path));
      if(file!==root&&!file.startsWith(root+sep))return send(403,'Invalid path');
      try{if(!statSync(file).isFile())file=resolve(root,'index.html')}catch{file=resolve(root,'index.html')}
      const data=readFileSync(file);res.writeHead(200,{...BASE_HEADERS,'content-type':MIME[extname(file)]??'application/octet-stream'});res.end(req.method==='HEAD'?undefined:data);
    }catch{send(500,'Together could not serve that request. Your conversations are saved.');}
  });
  return server;
}

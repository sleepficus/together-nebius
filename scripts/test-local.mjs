import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
// Only the two retired hosted-OAuth files need Cloudflare's optional SDK.
// All offline receipt tests run; their one Docker case self-skips unless enabled on Linux.
const excluded=new Set(['oauth-library-next.test.ts','remote-consent-next.test.ts']);
const files=readdirSync('tests').filter(f=>f.endsWith('.test.ts')&&!excluded.has(f)).sort().map(f=>'tests/'+f);
console.log('Local suite; excluded optional hosted-OAuth files:',[...excluded].join(', '));
const r=spawnSync(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit'});process.exitCode=r.status??1;

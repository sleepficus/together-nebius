import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {startDemo} from '../scripts/start-local.mts';

const root=fileURLToPath(new URL('..',import.meta.url));
test('F1 public-tree state is rejected before directory or credentials are created',async()=>{
 const stateDir=resolve(root,'public','forbidden-state-'+randomUUID());
 assert.equal(existsSync(stateDir),false);
 await assert.rejects(()=>startDemo({port:0,apiPort:0,stateDir}),/outside the public asset tree/);
 assert.equal(existsSync(stateDir),false);
});
test('F1 a symlink alias into public assets cannot hide private state placement',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'together-public-alias-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const alias=join(dir,'alias');symlinkSync(resolve(root,'public'),alias,'dir');
 const name='forbidden-alias-'+randomUUID(),stateDir=join(alias,name);
 await assert.rejects(()=>startDemo({port:0,apiPort:0,stateDir}),/outside the public asset tree/);
 assert.equal(existsSync(resolve(root,'public',name)),false);
});

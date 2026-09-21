import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const m=await import('./storage.ts').catch(()=>({}));
test('SQLite file survives transaction rollback, process restart and backup restore',async()=>{
 assert.equal(typeof m.probe,'function','SQLite probe not implemented');
 const dir=mkdtempSync(join(tmpdir(),'canvas-public-'));
 try{const r=await m.probe(dir);assert.equal(r.written,"public '; DROP TABLE proof; --");assert.equal(r.rolledBack,r.written);assert.equal(r.restarted,r.written);assert.equal(r.restored,r.written);assert.notEqual(r.writerPid,r.readerPid);console.log(JSON.stringify(r));}finally{rmSync(dir,{recursive:true,force:true});}
 assert.equal(existsSync(dir),false);
});

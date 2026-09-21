import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import('./model.ts').catch(() => ({}));
test('content capacity rejects configure and shrink without losing accepted text or overrides',()=>{
 const v={width:992,height:768};let d=m.fixture('one',12);
 const before=structuredClone(d);
 let r=m.applyCandidateOperation(d,{type:'configure',id:'w0',text:'W'.repeat(500)},v,12,true);
 assert.equal(r.ok,false);assert.match(r.error,/does not fit/);assert.deepEqual(r.doc,before);
 r=m.applyCandidateOperation(d,{type:'resize',id:'w0',dw:0,dh:3},v,12,true);assert.equal(r.ok,true);d=r.doc;
 r=m.applyCandidateOperation(d,{type:'configure',id:'w0',text:'W'.repeat(60)},v,12,true);assert.equal(r.ok,true);d=r.doc;
 r=m.applyCandidateOperation(d,{type:'resize',id:'w0',dw:0,dh:-3},v,12,true);
 assert.equal(r.ok,false);assert.deepEqual(r.doc,d);
});
test('long fixture grows derived text cells or reports explicit overflow without altering source',()=>{
 for(const set of [12,24])for(const v of [{width:1888,height:1080},{width:1048,height:1920},{width:992,height:768},{width:736,height:1024}]){
  const d=m.fixture('long',set),before=structuredClone(d),r=m.resolve(d,v,set);
  if(v.width<1000)assert.match(r.error,/does not fit/);else {assert.equal(r.error,null);assert.equal(r.items.length,6);for(const cell of r.items.filter(x=>['w0','w2','w4'].includes(x.id)))assert.ok(cell.h>4);}
  assert.deepEqual(d,before);
 }
});
test('operations isolate overrides and reject collision, undersize, oversize and hostile shapes without mutation', () => {
  assert.equal(typeof m.applyCandidateOperation,'function','operation path missing');
  const v={width:1920,height:1080};let d=m.fixture('six',12);const initial=JSON.stringify(d);
  let r=m.applyCandidateOperation(d,{type:'override',target:'portrait'},v,12,true); assert.equal(r.ok,true);d=r.doc;
  r=m.applyCandidateOperation(d,{type:'override',target:'landscape'},v,12,true);assert.equal(r.ok,true);d=r.doc;
  const before=JSON.stringify(d);
  for(const op of [{type:'resize',id:'w0',dw:-20,dh:0},{type:'resize',id:'w0',dw:200,dh:0},{type:'move',id:'w0',dx:3,dy:0},{type:'configure',id:'w0',text:'x'.repeat(501)},{type:'configure',id:'w0',text:42},{type:'move',id:'w0',dx:NaN,dy:0}]) {r=m.applyCandidateOperation(d,op,v,12,true);assert.equal(r.ok,false,JSON.stringify(op));assert.equal(JSON.stringify(r.doc),before);}
  r=m.applyCandidateOperation(d,{type:'move',id:'w0',dx:0,dy:8},v,12,false);assert.equal(r.ok,false);
  r=m.applyCandidateOperation(d,{type:'reset',target:'portrait'},v,12,true);assert.equal(r.ok,true);assert.deepEqual(r.doc.overrides.landscape,d.overrides.landscape);assert.equal(r.doc.overrides.portrait,undefined);
  assert.equal(JSON.stringify(d),before);assert.notEqual(before,initial);
});
test('six stable IDs resolve to bounded minimum-sized non-overlapping cells without writing document', () => {
  assert.equal(typeof m.resolve, 'function', 'resolver not implemented');
  const doc=m.fixture('six',12), before=JSON.stringify(doc);
  for(const v of [{width:1920,height:1080},{width:768,height:1024}]) {
    const r=m.resolve(doc,v,12); assert.equal(r.error,null); assert.equal(r.items.length,6);
    assert.equal(new Set(r.items.map(x=>x.id)).size,6);
    for(const a of r.items) { assert.ok(a.w*r.pitch-16>=240); assert.ok(a.h*48-16>=144); assert.ok(a.x+a.w<=r.cols); assert.ok(a.y+a.h<=r.rows); for(const c of r.items) if(a!==c) assert.ok(!m.overlap(a,c)); }
  }
  assert.equal(JSON.stringify(doc),before);
});

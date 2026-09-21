import {test,expect} from '@playwright/test';
for(const candidate of ['native','gridstack','rgl'])for(const columns of [12,24])test(`${candidate} ${columns} text fit preserves complete content and rejects impossible edits`,async({page},info)=>{
 await page.goto(`/?candidate=${candidate}&columns=${columns}`);
 await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 const snapshot=()=>page.evaluate(()=>window.spike.candidateSnapshot());
 const before=(await snapshot()).doc;
 const result=await page.evaluate(()=>window.spike.applyCandidateOperation({type:'configure',id:'w0',text:'W'.repeat(500)}));
 expect(result.ok).toBe(false);
 expect((await snapshot()).doc).toEqual(before);
 await expect(page.getByRole('status')).toContainText('does not fit');
 expect((await page.evaluate(()=>window.spike.applyCandidateOperation({type:'resize',id:'w0',dw:0,dh:3}))).ok).toBe(true);
 // Moderate text must remain accepted, rendered in full, and genuinely fit (not clipped).
 for(const text of ['W'.repeat(60),'مرحبا • 家 • café 🌿'.repeat(3)]){
  const result=await page.evaluate(text=>window.spike.applyCandidateOperation({type:'configure',id:'w0',text}),text);
  expect(result.ok).toBe(true);
  await expect(page.locator('[data-id="w0"] p')).toHaveText(text);
  const metrics=await page.locator('[data-id="w0"]').evaluate(el=>{const p=el.querySelector('p')!,b=el.getBoundingClientRect(),t=p.getBoundingClientRect();return {overflow:el.scrollHeight>el.clientHeight+1||el.scrollWidth>el.clientWidth+1,bottom:t.bottom<=b.bottom-48,top:t.top>=b.top+48,font:parseFloat(getComputedStyle(p).fontSize)};});
  expect(metrics).toEqual({overflow:false,bottom:true,top:true,font:16});
 }
 // An imported/rotated fixture that cannot fit must show an explicit hard error AND
 // every complete source string in a readable diagnostic, never an empty success.
 const sizes=info.project.name.includes('tablet')?[{width:1024,height:768},{width:768,height:1024}]:[{width:1920,height:1080},{width:1080,height:1920}];
 for(const size of sizes){
  await page.setViewportSize(size);await page.evaluate(()=>window.spike.reset('long'));
  const s=await snapshot();
  if(!info.project.name.includes('tablet')){
   expect(s.resolved.error).toBeNull();
   await expect(page.locator('[data-id] p')).toHaveText(s.doc.widgets.map(w=>w.text));
   expect(await page.locator('[data-id]').evaluateAll(els=>els.every(el=>el.scrollHeight<=el.clientHeight+1&&el.scrollWidth<=el.clientWidth+1))).toBe(true);
   expect(s.resolved.items.filter(a=>['w0','w2','w4'].includes(a.id)).every(a=>a.h>4)).toBe(true);
   await page.screenshot({path:`${process.env.SPIKE_EVIDENCE||'.planning/phases/01-editor-and-responsive-design-proof/evidence/repair'}/${info.project.name}-${candidate}-${columns}-${size.width}-content.png`,fullPage:true});
   continue;
  }
  expect(s.resolved.error).toContain('does not fit');
  expect(s.doc.widgets.filter(w=>w.kind==='text').every(w=>w.text==='W'.repeat(500))).toBe(true);
  await expect(page.getByRole('status')).toContainText('does not fit');
  const fallback=page.locator('#overflow-content');await expect(fallback).toBeVisible();
  await expect(fallback.locator('p')).toHaveText(s.doc.widgets.map(w=>w.text));
  const fit=await fallback.locator('p').evaluateAll(ps=>ps.every(p=>{const range=document.createRange();range.selectNodeContents(p);const b=p.getBoundingClientRect();return [...range.getClientRects()].every(r=>r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1)&&p.scrollHeight<=p.clientHeight+1&&p.scrollWidth<=p.clientWidth+1;}));
  expect(fit).toBe(true);
  const authored=JSON.stringify(s.doc);await page.getByRole('button',{name:'Preview screen',exact:true}).click();
  expect(JSON.stringify((await snapshot()).doc)).toBe(authored);await expect(fallback).toBeVisible();
  await page.getByRole('button',{name:'Return to editor',exact:true}).click();
  await page.screenshot({path:`${process.env.SPIKE_EVIDENCE||'.planning/phases/01-editor-and-responsive-design-proof/evidence/repair'}/${info.project.name}-${candidate}-${columns}-${size.width}-content.png`,fullPage:true});
 }
});

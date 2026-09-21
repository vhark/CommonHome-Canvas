import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdirSync,writeFileSync} from 'node:fs';
const evidence=process.env.SPIKE_COMPARISON||'.planning/phases/01-editor-and-responsive-design-proof/evidence/comparison';
const snapshot=async(page:any)=>{
 // setViewportSize can finish before the browser delivers its resize event.
 // Require the existing synchronous render to observe both dimensions before
 // sampling; leave every document/geometry assertion and tolerance unchanged.
 await expect.poll(()=>page.evaluate(()=>{const canvas=document.querySelector<HTMLElement>('#canvas')!;return canvas.style.width===`${innerWidth-32}px`&&canvas.style.minHeight===`${innerHeight}px`;})).toBe(true);
 return page.evaluate(()=>window.spike.candidateSnapshot());
};
const operation=(page:any,op:any)=>page.evaluate(op=>window.spike.applyCandidateOperation(op),op);
const reset=(page:any,name:string)=>page.evaluate(name=>window.spike.reset(name),name);
async function geometry(page:any){return page.evaluate(()=>{const canvas=document.querySelector('#canvas')!.getBoundingClientRect();return Array.from(document.querySelectorAll<HTMLElement>('#canvas [data-id]')).map(el=>{const b=el.getBoundingClientRect();return {id:el.dataset.id,x:b.x-canvas.x,y:b.y-canvas.y,width:b.width,height:b.height,contentOverflow:el.scrollHeight>el.clientHeight+1||el.scrollWidth>el.clientWidth+1};});});}
function layoutOK(s:any,g:any[]){return s.resolved.error?g.length===0:g.length===s.doc.widgets.length&&g.every(a=>{const r=s.resolved.items.find((b:any)=>a.id===b.id);return r&&Math.abs(a.x-r.x*s.resolved.pitch)<1.1&&Math.abs(a.y-r.y*48)<1.1&&Math.abs(a.width-(r.w*s.resolved.pitch-16))<1.1&&Math.abs(a.height-(r.h*48-16))<1.1&&a.x>=-1&&a.y>=-1&&a.x+a.width<=s.viewport.width+1&&a.y+a.height<=s.viewport.height+1;});}
for(const candidate of ['native','gridstack','rgl'])for(const columns of [12,24])test(`${candidate} matrix ${columns}: raw capability comparison`,async({page,browser},info)=>{
 const id=`${info.project.name}-${candidate}-${columns}`;mkdirSync(evidence,{recursive:true});
 const rows:any[]=[],errors:string[]=[],external:string[]=[];let complete=false;
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:4173/'))external.push(r.url());});
 const record=(scenario:string,pass:boolean,data:any={})=>{rows.push({scenario,status:pass?'PASS':'FAIL',...data});writeFileSync(`${evidence}/${id}.json`,JSON.stringify({id,candidate,columns,project:info.project.name,browser:browser.version(),realTouch:false,complete,rows,errors,external},null,2));};
 try{
 await page.goto(`/?candidate=${candidate}&columns=${columns}`);await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 const tablet=info.project.name.includes('tablet'),sizes=tablet?[{width:1024,height:768},{width:768,height:1024}]:[{width:1920,height:1080},{width:1080,height:1920}];
 for(const size of sizes){await page.setViewportSize(size);await page.waitForTimeout(50);
 for(const name of ['zero','one','six','long','unicode','mixed','stress']){
  await reset(page,name);const before=await snapshot(page),g=await geometry(page);
  record(`${size.width}x${size.height}/${name}/geometry`,layoutOK(before,g),{snapshot:before,geometry:g});
  const fallback=await page.locator('#overflow-content p').evaluateAll(ps=>ps.map(p=>({text:p.textContent,overflow:p.scrollHeight>p.clientHeight+1||p.scrollWidth>p.clientWidth+1})));
  const contentPreserved=before.resolved.error?fallback.length===before.doc.widgets.length&&fallback.every((p,i)=>p.text===before.doc.widgets[i].text&&!p.overflow):g.length===before.doc.widgets.length;
  record(`${size.width}x${size.height}/${name}/content-visible`,g.every(a=>!a.contentOverflow)&&contentPreserved,{overflowIDs:g.filter(a=>a.contentOverflow).map(a=>a.id),disposition:before.resolved.error?'explicit overflow; full source outside composition':'bounded composition',error:before.resolved.error,fallback});
  const samples=await page.evaluate(async()=>{const values:any[]=[];for(let i=0;i<11;i++){const s=window.spike.candidateSnapshot();const start=performance.now();const result=window.spike.applyCandidateOperation({type:s.doc.widgets.length?'configure':'add',id:'w0',text:`Synthetic measurement ${i}`});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(i)values.push({ms:performance.now()-start,accepted:result.ok,error:result.error});}return values;});
  expect(samples).toHaveLength(10);const sorted=samples.map(x=>x.ms).sort((a,b)=>a-b);
  record(`${size.width}x${size.height}/${name}/operation-to-next-paint`,true,{operation:name==='zero'?'add warmup then configure':'configure',samples,p95:sorted[9],budgetApplicable:!before.resolved.error,budgetMs:name==='stress'?200:100,budgetMet:before.resolved.error?null:sorted[9]<=(name==='stress'?200:100)});
  // Restore exact public fixture before screenshot/preview comparisons.
  await reset(page,name);
  if(['six','stress','long'].includes(name))await page.screenshot({path:`${evidence}/${id}-${size.width}-${name}.png`,fullPage:true});
 }
 // Same mouse, keyboard and (where hasTouch) tap paths, both move and resize.
 for(const input of tablet?['mouse','keyboard','tap']:['mouse','keyboard'])for(const action of ['move','resize']){
  await reset(page,'one');const samples:any[]=[];
  for(let i=0;i<11;i++){
   const before=await snapshot(page),delta=i%2===0?1:-1;
   await page.evaluate(()=>{window.__paint=null;window.__start=()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__paint=performance.now()-start));};document.addEventListener('pointerup',window.__start,{capture:true,once:true});document.addEventListener('click',window.__start,{capture:true,once:true});});
   if(input==='mouse'){
    const handle=action==='move'?page.locator('[data-id="w0"] .handle'):page.locator('[data-id="w0"] .resize-handle,[data-id="w0"] .react-resizable-handle,.grid-stack-item .ui-resizable-se').first();
    await handle.scrollIntoViewIfNeeded();const b=(await handle.boundingBox())!;
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2+48*delta,{steps:8});await page.mouse.up();
   }else {const name=action==='move'?(delta>0?'Move down':'Move up'):(delta>0?'Larger height':'Smaller height');const button=page.getByRole('button',{name,exact:true});if(input==='tap')await button.tap();else {await button.focus();await page.keyboard.press('Enter');}}
   await expect.poll(()=>page.evaluate(()=>window.__paint)).not.toBeNull();await page.waitForTimeout(20);
   const after=await snapshot(page),key=action==='move'?'y':'h';
   const pass=after.resolved.items[0][key]===before.resolved.items[0][key]+delta;
   if(i)samples.push({ms:await page.evaluate(()=>window.__paint),pass,before:before.doc,after:after.doc});
   await page.evaluate(()=>{document.removeEventListener('pointerup',window.__start,true);document.removeEventListener('click',window.__start,true);});
  }
  record(`${size.width}x${size.height}/${input}/${action}`,samples.every(x=>x.pass),{samples,p95:samples.map(x=>x.ms).sort((a,b)=>a-b)[9],label:input==='tap'?'emulated tap, not physical touch':input});
 }
 await reset(page,'six');const before=await snapshot(page);
 for(const op of [{type:'move',id:'w0',dx:before.resolved.items[1].x,dy:before.resolved.items[1].y},{type:'resize',id:'w0',dw:-100,dh:0},{type:'resize',id:'w0',dw:100,dh:0},{type:'configure',id:'w0',text:'x'.repeat(501)}]){const result=await operation(page,op);record(`${size.width}/reject-${JSON.stringify(op).slice(0,80)}`,!result.ok&&JSON.stringify((await snapshot(page)).doc)===JSON.stringify(before.doc),{error:result.error});}
 await reset(page,'one');await operation(page,{type:'override',target:'landscape'});await operation(page,{type:'override',target:'portrait'});
 await page.setViewportSize(sizes[1]);await page.waitForTimeout(50);const base=(await snapshot(page)).doc;await operation(page,{type:'move',target:'portrait',id:'w0',dx:0,dy:1});const authored=(await snapshot(page)).doc;
 record(`${size.width}/override-isolation`,JSON.stringify(base.base)===JSON.stringify(authored.base)&&JSON.stringify(base.overrides.landscape)===JSON.stringify(authored.overrides.landscape)&&JSON.stringify(base.overrides.portrait)!==JSON.stringify(authored.overrides.portrait),{before:base,after:authored});
 for(const v of [sizes[0],sizes[1],sizes[0]]){await page.setViewportSize(v);await page.waitForTimeout(40);const s=await snapshot(page),g=await geometry(page);record(`${size.width}/roundtrip/${v.width}`,JSON.stringify(s.doc)===JSON.stringify(authored)&&layoutOK(s,g),{snapshot:s,geometry:g});
 await page.getByRole('button',{name:'Preview screen',exact:true}).click();const preview=await snapshot(page),pg=await geometry(page);record(`${size.width}/preview/${v.width}`,JSON.stringify(s.doc)===JSON.stringify(preview.doc)&&JSON.stringify(pg.map(({contentOverflow,...x})=>x))===JSON.stringify(g.map(({contentOverflow,...x})=>x)),{geometry:pg});await page.getByRole('button',{name:'Return to editor',exact:true}).click();}
 await page.getByRole('button',{name:'Finish editing',exact:true}).click();const view=await snapshot(page);await operation(page,{type:'move',id:'w0',dx:0,dy:1});await page.mouse.wheel(0,200);record(`${size.width}/view-mode`,JSON.stringify((await snapshot(page)).doc)===JSON.stringify(view.doc)&&await page.locator('#canvas .handle').count()===0);
 await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 }
 if(info.project.name.startsWith('chromium')){await reset(page,'six');const before=(await snapshot(page)).doc;for(const width of [931,932,933,900]){await page.setViewportSize({width,height:width===900?900:1080});await page.waitForTimeout(30);const s=await snapshot(page);record(`boundary/${width}`,JSON.stringify(s.doc)===JSON.stringify(before)&&layoutOK(s,await geometry(page)),{snapshot:s});}}
 await reset(page,'one');await operation(page,{type:'configure',id:'w0',text:'<img src=x onerror="window.xss=1"> javascript:alert(1)'});record('text-not-markup',await page.locator('#canvas img,#canvas script,#canvas a').count()===0&&await page.evaluate(()=>window.xss===undefined));
 const axe=await new AxeBuilder({page}).analyze();record('axe',axe.violations.length===0,{violations:axe.violations});record('runtime-errors',errors.length===0,{errors});record('no-external-requests',external.length===0,{external});
 complete=true;record('harness-complete',true,{rowCountBefore:rows.length});expect(rows.length).toBeGreaterThan(60);
 }finally{writeFileSync(`${evidence}/${id}.json`,JSON.stringify({id,candidate,columns,project:info.project.name,browser:browser.version(),realTouch:false,complete,rows,errors,external},null,2));}
});

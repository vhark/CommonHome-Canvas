// Per-mousemove trace of a GridStack edge resize: scrollY, pointer y, handle
// rect and the node height GridStack has committed at that instant.
import {chromium} from 'playwright';
const base=process.env.DIAG_URL||'http://127.0.0.1:4174';
const browser=await chromium.launch();
for(let run=1;run<=6;run++){
 const page=await browser.newPage({viewport:{width:1024,height:768},deviceScaleFactor:2,hasTouch:true});
 await page.goto(`${base}/?candidate=gridstack`);
 await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 const rows=[];
 const snap=async(label,py)=>rows.push(await page.evaluate(([label,py])=>{
  const el=document.querySelector('.grid-stack-item');
  const h=document.querySelector('.ui-resizable-se');
  const se=document.scrollingElement;
  return {label,py,scrollY,docScrollTop:se.scrollTop,scrollHeight:se.scrollHeight,clientHeight:se.clientHeight,
   item:el?el.getBoundingClientRect().toJSON():null,handle:h?h.getBoundingClientRect().toJSON():null,
   node:el&&el.gridstackNode?{x:el.gridstackNode.x,y:el.gridstackNode.y,w:el.gridstackNode.w,h:el.gridstackNode.h}:null,
   modelH:window.spike.candidateSnapshot().resolved.items[0].h};},[label,py]));
 await snap('initial',null);
 let b=await page.locator('[data-id="w0"] .handle').boundingBox();
 await page.mouse.move(b.x+24,b.y+24);await page.mouse.down();
 await page.mouse.move(b.x+24,b.y+120,{steps:12});await page.mouse.up();
 await page.waitForTimeout(100);await snap('moved',null);
 b=(await page.locator('.grid-stack-item .ui-resizable-se').first().boundingBox());
 const sx=b.x+b.width/2, sy=b.y+b.height/2;
 await page.mouse.move(sx,sy);await page.mouse.down();await snap('down',sy);
 for(let i=1;i<=12;i++){const py=sy+96*i/12;await page.mouse.move(sx,py);await snap('move'+i,py);}
 await page.mouse.up();await page.waitForTimeout(150);await snap('up',null);
 console.log(`--- run ${run} finalH=${rows[rows.length-1].modelH}`);
 for(const r of rows)console.log(JSON.stringify({l:r.label,py:r.py&&+r.py.toFixed(1),scrollY:r.scrollY,dh:r.scrollHeight,ch:r.clientHeight,
  itemTop:r.item&&+r.item.top.toFixed(1),itemH:r.item&&+r.item.height.toFixed(1),hTop:r.handle&&+r.handle.top.toFixed(1),nodeH:r.node&&r.node.h,modelH:r.modelH}));
 await page.close();
}
await browser.close();

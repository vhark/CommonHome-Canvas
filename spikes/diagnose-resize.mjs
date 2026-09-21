import {chromium} from 'playwright';
import {writeFileSync} from 'node:fs';
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1024,height:768},deviceScaleFactor:2,hasTouch:true});
await page.goto(`http://127.0.0.1:4173/?candidate=${process.argv[3]||'rgl'}`);
await page.getByRole('button',{name:'Edit layout',exact:true}).click();
const rows=[];
const record=async(label)=>rows.push(await page.evaluate(label=>({label,scrollY,doc:window.spike.candidateSnapshot().doc,rect:[...document.querySelectorAll('[data-id="w0"],.react-resizable-handle')].map(el=>({class:el.className,rect:el.getBoundingClientRect().toJSON(),scrollHeight:el.scrollHeight,clientHeight:el.clientHeight}))}),label));
await record('initial');
let b=await page.locator('[data-id="w0"] .handle').boundingBox();await page.mouse.move(b.x+24,b.y+24);await page.mouse.down();await page.mouse.move(b.x+24,b.y+120,{steps:12});await page.mouse.up();await page.waitForTimeout(100);await record('moved');
b=await page.locator('.react-resizable-handle,.grid-stack-item .ui-resizable-se').first().boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();
for(let i=1;i<=12;i++){await page.mouse.move(b.x+b.width/2,b.y+b.height/2+8*i);await record('resize '+i);}
await page.mouse.up();await page.waitForTimeout(100);await record('stopped');
writeFileSync(process.argv[2]||`.planning/phases/01-editor-and-responsive-design-proof/evidence/repair/resize-diagnostic-${Date.now()}.json`,JSON.stringify(rows,null,2));
console.log(rows.map(r=>({label:r.label,scrollY:r.scrollY,rect:r.rect[0].rect,h:r.doc.base.items[0].h})));
await browser.close();

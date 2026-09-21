/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. It is distributed WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
 * PURPOSE. See the GNU Affero General Public License for details, and the
 * LICENSE file distributed with this program.
 */
import {fixture,resolve,applyCandidateOperation,orientation} from './model.ts';
import './spike.css';
const params=new URLSearchParams(location.search);
const candidate=params.get('candidate')||'native',set=params.get('columns')==='24'?24:12;
let adapter:any;
if(candidate==='gridstack')adapter=await import('./gridstack.ts');else if(candidate==='rgl')adapter=await import('./rgl.ts');else adapter=await import('./native.ts');
let doc=fixture('one',set),edit=false,preview=false,target='base',selected='w0',error='',revision=0;
if(candidate==='native'&&params.get('surface')==='preview'){
 const {previewSurface}=await import('./preview.ts');previewSurface(adapter,set);
}else{
const main=document.querySelector('main')!;
main.innerHTML=`<header><h1>Canvas comparison</h1><p>Local synthetic experiment · no grid selected · real touch not verified</p></header><nav aria-label="Candidate"><a href="?candidate=native">Native CSS Grid</a><a href="?candidate=gridstack">GridStack</a><a href="?candidate=rgl">React Grid Layout</a></nav><section class="tools" aria-label="Experiment controls"><button id="edit">Edit layout</button><button id="preview">Preview screen</button><label>Fixture <select id="fixture"><option>one</option><option>zero</option><option>six</option><option>long</option><option>unicode</option><option>mixed</option><option>stress</option></select></label><label>Authored target <select id="target"><option value="base">Automatic base</option><option value="landscape">Landscape override</option><option value="portrait">Portrait override</option></select></label><button id="create">Create orientation override</button><button id="reset">Reset orientation override</button></section><section class="tools" id="operations" aria-label="Placement controls"></section><p role="status" id="status"></p><p id="metrics"></p><section id="canvas" aria-label="Screen canvas"></section>`;
const canvas=document.querySelector('#canvas') as HTMLElement;
let selector:HTMLSelectElement|undefined;
if(candidate==='native'){
 main.classList.add('native-editor');
 const separate=document.createElement('button');separate.textContent='Open separate preview';
 separate.onclick=()=>{
  adapter.cancelGesture();
  const popup=window.open('about:blank','_blank');
  if(!popup){error='Allow pop-ups for this local editor, then open the preview again.';render();return;}
  try{
   popup.sessionStorage.setItem('canvas-native-preview',JSON.stringify(doc));popup.opener=null;
   popup.location.href=`?candidate=native&columns=${set}&surface=preview`;
  }catch{popup.close();error='Preview could not open its snapshot. Allow session storage and try again.';render();}
 };
 document.querySelector('#preview')!.after(separate);
}

if(candidate==='native'){
 const label=document.createElement('label');label.textContent='Selected widget';
 selector=document.createElement('select');selector.id='selection';selector.setAttribute('aria-label','Selected widget');label.append(selector);
 document.querySelector('#operations')!.prepend(label);
 selector.onchange=()=>{adapter.cancelGesture();select(selector!.value);};
 const help=document.createElement('p');help.id='native-help';help.textContent='Select a widget, then use placement controls. Drag handles to preview; Escape cancels.';
 document.querySelector('#operations')!.before(help);
}
function select(id:string){
 if(!edit||preview)return;
 selected=id;if(selector)selector.value=id;
 for(const card of canvas.querySelectorAll<HTMLElement>('[data-id]'))card.dataset.selected=String(card.dataset.id===id);
}

const button=(name:string,op:any)=>{const b=document.createElement('button');b.textContent=name;b.onclick=()=>operate({...op,id:selected});document.querySelector('#operations')!.append(b);};
button('Add widget',{type:'add'});
for(const [name,dx,dy] of [['left',-1,0],['right',1,0],['up',0,-1],['down',0,1]])button(`Move ${name}`,{type:'move',dx,dy});
for(const [name,dw,dh] of [['Smaller width',-1,0],['Larger width',1,0],['Smaller height',0,-1],['Larger height',0,1]])button(name as string,{type:'resize',dw,dh});
const viewport=()=>({width:innerWidth-32,height:innerHeight});
function render(){adapter.cancelGesture?.();const v=viewport(),r=resolve(doc,v,set);revision++;
 (document.querySelector('#target') as HTMLSelectElement).value=target;
 canvas.style.width=`${v.width}px`;canvas.style.minHeight=`${v.height}px`;
 document.querySelector('#edit')!.textContent=edit?'Finish editing':'Edit layout';
 document.querySelector('#preview')!.textContent=preview?'Return to editor':'Preview screen';
 for(const b of document.querySelectorAll<HTMLButtonElement>('#operations button,#create,#reset'))b.disabled=!edit||preview;
 document.querySelector('#status')!.textContent=error||r.error||(!doc.widgets.length?'Start with a layout. Choose a starting layout, then add a text card or clock.':'');
 document.querySelector('#metrics')!.textContent=`${candidate} · ${v.width} × ${v.height} CSS px canvas · DPR ${devicePixelRatio} · ${r.cols} columns · ${orientation(v)}`;
 if(selector){
  if(!doc.widgets.some(w=>w.id===selected))selected=doc.widgets[0]?.id||'';
  selector.replaceChildren(...doc.widgets.map(w=>{const option=document.createElement('option');option.value=w.id;option.textContent=`${w.id}: ${w.kind}`;return option;}));
  selector.value=selected;selector.disabled=!edit||preview||!doc.widgets.length;
 }
 adapter.render(canvas,doc,r,edit&&!preview,operate,select,op=>applyCandidateOperation(doc,{target,...op},viewport(),set,edit&&!preview));
 if(edit&&!preview)select(selected);
 // A failed bounded composition is not an empty preview. Keep the complete source
 // visible outside it, in ordinary editor flow, and keep authored state untouched.
 document.querySelector('#overflow-content')?.remove();
 if(r.error){const fallback=document.createElement('section');fallback.id='overflow-content';fallback.setAttribute('aria-label','Content that does not fit the screen');
 const heading=document.createElement('h2');heading.textContent='Content does not fit the screen — full source below';fallback.append(heading);
 for(const widget of doc.widgets){const p=document.createElement('p');p.textContent=widget.text;fallback.append(p);}canvas.after(fallback);}

}
function operate(op:any){const result=applyCandidateOperation(doc,{target,...op},viewport(),set,edit&&!preview);if(result.ok)doc=result.doc;error=result.error||'';render();return result;}
(document.querySelector('#edit') as HTMLButtonElement).onclick=()=>{edit=!edit;render();};
(document.querySelector('#preview') as HTMLButtonElement).onclick=()=>{preview=!preview;render();};
(document.querySelector('#fixture') as HTMLSelectElement).onchange=e=>reset((e.target as HTMLSelectElement).value);
(document.querySelector('#target') as HTMLSelectElement).onchange=e=>{target=(e.target as HTMLSelectElement).value;adapter.cancelGesture?.();};
(document.querySelector('#create') as HTMLButtonElement).onclick=()=>operate({type:'override',target:target==='base'?orientation(viewport()):target});
(document.querySelector('#reset') as HTMLButtonElement).onclick=()=>{if(confirm('Reset this orientation override? Automatic reflow will be used for this orientation. The other override stays unchanged.'))operate({type:'reset'});};
function reset(name='one'){doc=fixture(name,set);target='base';error='';render();}
function candidateSnapshot(){return structuredClone({candidate,set,doc,edit,preview,target,error,revision,viewport:viewport(),dpr:devicePixelRatio,resolved:resolve(doc,viewport(),set)});}
window.addEventListener('resize',()=>render());
window.addEventListener('keydown',e=>{if(e.key==='Escape')render();});
if(candidate!=='native')window.addEventListener('pointercancel',()=>render(),true);
(window as any).spike={candidateSnapshot,applyCandidateOperation:operate,reset,setTarget:(x:string)=>target=x};
render();
}

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
import {resolve} from './model.ts';

// ponytail: per-tab synthetic snapshot only; no persistence/publishing contract.
export function previewSurface(adapter:any,set:number){
 window.opener=null;
 const main=document.querySelector('main')!;
 main.innerHTML='<header><h1>Screen preview</h1><p>Read-only snapshot at this browser’s CSS viewport. Not a physical-device fidelity claim.</p><button id="return">Return to editor</button></header><p id="metrics"></p><p id="status" role="status"></p><section id="canvas" aria-label="Screen canvas"></section>';
 document.querySelector<HTMLButtonElement>('#return')!.onclick=()=>window.close();
 const canvas=document.querySelector<HTMLElement>('#canvas')!,status=document.querySelector('#status')!;
 let doc:any;
 try{doc=JSON.parse(sessionStorage.getItem('canvas-native-preview')||'null');if(!doc)throw Error();resolve(doc,{width:innerWidth-32,height:innerHeight},set);}
 catch{status.textContent='Open a new preview from the editor. This tab has no readable snapshot.';return;}
 const viewport=()=>({width:innerWidth-32,height:innerHeight});
 function render(){
  const v=viewport(),r=resolve(doc,v,set);
  canvas.style.width=`${v.width}px`;canvas.style.minHeight=`${v.height}px`;
  document.querySelector('#metrics')!.textContent=`${v.width} × ${v.height} CSS px canvas · DPR ${devicePixelRatio}`;
  status.textContent=r.error||'';adapter.render(canvas,doc,r,false,()=>{});
  document.querySelector('#overflow-content')?.remove();
  if(r.error){const source=document.createElement('section');source.id='overflow-content';source.setAttribute('aria-label','Content that does not fit the screen');
   for(const widget of doc.widgets){const p=document.createElement('p');p.textContent=widget.text;source.append(p);}canvas.after(source);}
 }
 (window as any).spike={candidateSnapshot:()=>structuredClone({doc,set,edit:false,preview:true,viewport:viewport(),resolved:resolve(doc,viewport(),set)})};
 window.addEventListener('resize',render);render();
}

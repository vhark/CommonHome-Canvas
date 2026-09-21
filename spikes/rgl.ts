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
import {createElement as h} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import GridLayout,{noCompactor} from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
let root:any,epoch=0;
export function render(el:HTMLElement,doc:any,r:any,edit:boolean,operate:any){
 el.className='rgl';root ||= createRoot(el);epoch++;const current=epoch;
 const stop=(type:string)=>(_layout:any,old:any,item:any)=>{const original=r.items.find((x:any)=>x.id===item.i);const op=type==='move'?{type,id:item.i,dx:item.x-original.x,dy:item.y-original.y}:{type,id:item.i,dw:item.w-original.w,dh:item.h-original.h};setTimeout(()=>{if(epoch===current)operate(op);},0);};
 flushSync(()=>root.render(h(GridLayout,{key:epoch,style:{minHeight:r.rows*48-16},width:el.clientWidth,onDragStop:stop('move'),onResizeStop:stop('resize'),layout:r.items.map((a:any)=>({...a,i:a.id})),gridConfig:{cols:r.cols,rowHeight:32,margin:[16,16],containerPadding:[0,0],maxRows:r.rows},compactor:noCompactor,dragConfig:{enabled:edit,handle:'.handle',bounded:true},resizeConfig:{enabled:edit,handles:['se']}},r.items.map((a:any)=>h('article',{key:a.id,'data-id':a.id,className:'widget'},h('p',null,doc.widgets.find((x:any)=>x.id===a.id).text),edit?h('button',{className:'handle','aria-label':`Move ${a.id}`},'Move'):null)))));
}

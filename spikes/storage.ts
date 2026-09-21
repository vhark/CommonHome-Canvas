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
import {DatabaseSync,backup} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
export async function probe(dir:string){
 const file=join(dir,'proof.sqlite'),saved=join(dir,'backup.sqlite');
 const db=new DatabaseSync(file);db.exec('CREATE TABLE proof (id INTEGER PRIMARY KEY, content TEXT NOT NULL)');
 db.exec('BEGIN');db.prepare('INSERT INTO proof VALUES (?,?)').run(1,"public '; DROP TABLE proof; --");db.exec('COMMIT');
 const written=(db.prepare('SELECT content FROM proof WHERE id=?').get(1) as any).content;
 db.exec('BEGIN');db.prepare('UPDATE proof SET content=? WHERE id=?').run('not committed',1);db.exec('ROLLBACK');
 const rolledBack=(db.prepare('SELECT content FROM proof WHERE id=?').get(1) as any).content;
 await backup(db,saved);db.close();
 const read=(path:string)=>{const child=spawnSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);console.log(JSON.stringify({content:db.prepare('SELECT content FROM proof WHERE id=1').get().content,pid:process.pid}));db.close();`,path],{encoding:'utf8'});if(child.status!==0)throw new Error(child.stderr);return JSON.parse(child.stdout);};
 const restarted=read(file);
 const source=new DatabaseSync(saved);const restoredFile=join(dir,'restored.sqlite');await backup(source,restoredFile);source.close();
 return {node:process.version,sqliteDriver:'node:sqlite DatabaseSync + backup',written,rolledBack,restarted:restarted.content,restored:read(restoredFile).content,writerPid:process.pid,readerPid:restarted.pid};
}

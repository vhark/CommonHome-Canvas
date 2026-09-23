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
/* Container entrypoint: `node src/server/main.ts`.
 *
 * The single rule here is that a configuration problem is a WARNING, never a
 * fatal error. The whole point of Canvas is that it boots with nothing
 * configured and shows a useful screen; exiting because someone typo'd a
 * calendar entity would turn a cosmetic mistake into a dead display on a wall.
 */

import {loadConfig} from './config.ts';
import {defaultCanvasDocument, DEFAULT_CANVAS_NAME} from './default-canvas.ts';
import {startCanvasServer} from './server.ts';
import {CanvasStore} from './store.ts';

const {config, problems} = loadConfig();

for (const problem of problems) {
  console.warn(`[canvas] config warning: ${problem.key}: ${problem.message}`);
}

/* Canvases now persist here, so an unwritable data directory is a real
 * degradation rather than a cosmetic one - but still not fatal. The ambient
 * display is the thing on the wall and it needs no storage at all; refusing
 * to boot would turn "canvases cannot be saved" into "the kitchen screen is
 * blank", which is strictly worse. Named loudly instead. */
const store = new CanvasStore(config.dataDir);
try {
  await store.init();
} catch (err) {
  console.warn(`[canvas] data directory ${config.dataDir} is not writable: ${(err as Error).message}`);
  console.warn('[canvas] the ambient display will still run; saving canvases will fail');
}

/* SEED ONCE, ON AN EMPTY STORE ONLY.
 *
 * A fresh install should have something on the wall before anyone has authored
 * anything, so the ambient canvas is created on first boot. The guard is
 * "there are no canvases at all", not "no canvas named Ambient": re-seeding a
 * store whose owner DELETED this canvas would be the server arguing with the
 * household, and matching on a name would resurrect it every restart for
 * anyone who renamed it. Nothing here ever overwrites an existing document. */
try {
  const existing = await store.list();
  if (existing.length === 0) {
    const created = await store.create(defaultCanvasDocument());
    if (created.ok) {
      console.log(`[canvas] seeded the default canvas "${DEFAULT_CANVAS_NAME}" (${created.value.metadata.uid})`);
      console.log('[canvas]   pair a screen to it with POST /api/screens to put it on a television');
    } else {
      console.warn(`[canvas] could not seed the default canvas: ${created.error.code}`);
    }
  }
} catch (err) {
  /* Seeding is a convenience. A store that cannot be listed is already
   * reported above, and the display server must still start. */
  console.warn(`[canvas] could not seed the default canvas: ${(err as Error).message}`);
}

await startCanvasServer({config, store});

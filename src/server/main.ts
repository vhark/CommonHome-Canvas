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

import {mkdir} from 'node:fs/promises';

import {loadConfig} from './config.ts';
import {startCanvasServer} from './server.ts';

const {config, problems} = loadConfig();

for (const problem of problems) {
  console.warn(`[canvas] config warning: ${problem.key}: ${problem.message}`);
}

/* Best-effort. A read-only or unwritable data directory is not yet fatal -
 * nothing in the ambient display persists - so say so and carry on rather than
 * refusing to start. */
try {
  await mkdir(config.dataDir, {recursive: true});
} catch (err) {
  console.warn(`[canvas] data directory ${config.dataDir} is not writable: ${(err as Error).message}`);
}

await startCanvasServer({config});

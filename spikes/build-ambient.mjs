// Build the ambient SPIKE so its sources get real compile coverage.
//
// `npm run build` builds only the three grid candidates and never touches
// ambient.html, so without this the ambient sources are verified by nothing
// but a dev server having served them once.
import {build} from 'vite';
import {resolve} from 'node:path';

await build({
  configFile: false,
  build: {
    outDir: 'dist/ambient',
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: false,
    minify: true,
    rollupOptions: {input: resolve(process.cwd(), 'ambient.html')},
  },
});

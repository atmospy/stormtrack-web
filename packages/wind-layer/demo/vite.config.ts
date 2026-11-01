import { defineConfig } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, join, normalize } from 'node:path';

const dataRoot = resolve(__dirname, '../../../public-data');

export default defineConfig({
  root: __dirname,
  server: { port: 5199, host: '127.0.0.1' },
  plugins: [
    {
      // serve the repo's public-data/ at /data (same layout as production's data root)
      name: 'public-data',
      configureServer(server) {
        server.middlewares.use('/data', (req, res, next) => {
          const p = normalize(join(dataRoot, decodeURIComponent((req.url ?? '/').split('?')[0]!)));
          if (!p.startsWith(dataRoot) || !existsSync(p) || !statSync(p).isFile()) return next();
          res.setHeader('Content-Type', p.endsWith('.json') ? 'application/json' : p.endsWith('.png') ? 'image/png' : 'application/octet-stream');
          createReadStream(p).pipe(res);
        });
      },
    },
  ],
});

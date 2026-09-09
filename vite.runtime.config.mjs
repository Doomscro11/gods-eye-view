import { defineConfig } from 'vite';
import baseConfig from './vite.config.js';
import { runtimeMemorySnapshot } from './src/runtime/memoryTelemetry.js';

const startedAt = Date.now();

function runtimeHealthPlugin() {
  const install = (middlewares) => {
    middlewares.use('/healthz', (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      const payload = {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        startedAt: new Date(startedAt).toISOString(),
        memory: runtimeMemorySnapshot(),
      };

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(JSON.stringify(payload));
    });
  };

  return {
    name: 'gev-runtime-health',
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export default defineConfig(async (env) => {
  const resolved = typeof baseConfig === 'function' ? await baseConfig(env) : await baseConfig;
  const port = Number.parseInt(process.env.PORT || '', 10) || 4173;

  return {
    ...resolved,
    plugins: [...(resolved.plugins || []), runtimeHealthPlugin()],
    preview: {
      ...(resolved.preview || {}),
      host: process.env.HOST || '0.0.0.0',
      port,
      strictPort: true,
      allowedHosts: true,
      headers: {
        ...(resolved.server?.headers || {}),
        ...(resolved.preview?.headers || {}),
      },
    },
  };
});

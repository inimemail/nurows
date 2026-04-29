import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const appPort = env.PORT || '38471';
  const devPort = Number(env.VITE_DEV_SERVER_PORT || 5173);
  const apiTarget = env.VITE_API_PROXY_TARGET || `http://localhost:${appPort}`;
  const wsTarget = env.VITE_WS_PROXY_TARGET || `ws://localhost:${appPort}`;

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: devPort,
      proxy: {
        '/api': apiTarget,
        '/ws': {
          target: wsTarget,
          ws: true
        }
      }
    }
  };
});

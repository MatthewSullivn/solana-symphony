import { defineConfig, type ProxyOptions } from 'vite';

// api.mainnet-beta.solana.com keeps full transaction history but rejects requests
// that carry a browser Origin header. Proxy it through the dev server and strip
// Origin/Referer so the wallet player can read a wallet's complete history.
const archiveProxy: Record<string, ProxyOptions> = {
  '/rpc': {
    target: 'https://api.mainnet-beta.solana.com',
    changeOrigin: true,
    rewrite: () => '/',
    configure: (proxy) => {
      proxy.on('proxyReq', (req) => { req.removeHeader('origin'); req.removeHeader('referer'); });
    },
  },
};

export default defineConfig({
  server: { proxy: archiveProxy },
  preview: { proxy: archiveProxy },
});

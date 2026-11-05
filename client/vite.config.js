import { defineConfig } from 'vite'

const target = process.env.TRAVELMORE_SERVER_URL || 'http://127.0.0.1:0'
const proxy = {
    '/api': { target, changeOrigin: true },
    '/media': { target, changeOrigin: true },
    '/rpc': { target, changeOrigin: true, ws: true },
}

// `host: true` binds every interface so a phone or another computer on the same LAN can open the app.
// The API itself stays on loopback and is reached through this proxy, so it is never exposed directly.
export default defineConfig({
    server: { host: true, port: 0, strictPort: false, allowedHosts: true, proxy },
    preview: { host: true, port: 0, strictPort: false, allowedHosts: true, proxy },
})

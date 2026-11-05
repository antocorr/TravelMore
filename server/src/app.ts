import express from 'express';
import cors from 'cors';
import { TravelService } from './services/travel.js';
import { MediaStore } from './services/media.js';
import { assertSafeOrigin, isAllowedOrigin } from './security.js';

export function createApp(travel: TravelService, media: MediaStore) {
  const app = express();
  app.disable('x-powered-by'); app.use(cors({ origin(origin, callback) { callback(null, !origin || isAllowedOrigin(origin)); } })); app.use(express.json({ limit: '1mb' }));
  app.get('/', (_req, res) => res.json({ name: 'travelmore-server', health: '/api/health', rpc: '/rpc' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, revision: travel.store.snapshot().revision }));
  app.put('/media', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '15mb' }), async (req, res, next) => { let uploaded: { id: string; mime: string; extension: string } | undefined; try { assertSafeOrigin(req); const nodeId = typeof req.query.nodeId === 'string' ? req.query.nodeId : ''; travel.getNodeDetail({ id: nodeId }); uploaded = await media.put(req.body); const image = await travel.saveImage({ nodeId, url: `/media/${uploaded.id}`, provenance: 'Local upload', sourceUrl: null }); res.status(201).json({ ...uploaded, image: image.image, revision: image.revision }); } catch (error) { if (uploaded) await media.remove(uploaded.id).catch(() => {}); next(error); } });
  app.get('/media/:id', async (req, res) => { try { const mediaFile = await media.get(req.params.id); res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').type(mediaFile.mime).send(mediaFile.bytes); } catch { res.status(404).json({ error: 'Media not found.' }); } });
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: error?.message || 'Bad request.' }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  return app;
}

/** Private, controlled origin. Reachable only through a Cloudflare service binding. */
export interface CatalogPayload {
  service: 'demo-catalog';
  revision: string;
  generatedAt: number;
  products: { sku: string; available: number }[];
}
export function isCatalogPayload(value: unknown): value is CatalogPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as CatalogPayload;
  return (
    p.service === 'demo-catalog' &&
    typeof p.revision === 'string' &&
    Number.isFinite(p.generatedAt) &&
    Array.isArray(p.products) &&
    p.products.length === 2 &&
    p.products.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.sku === 'string' &&
        Number.isInteger(item.available),
    )
  );
}
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/catalog')
      return Response.json({ error: 'Not found' }, { status: 404 });
    let settings: { delay?: number; fails?: boolean };
    try {
      settings = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (
      !settings ||
      typeof settings !== 'object' ||
      typeof settings.fails !== 'boolean' ||
      !Number.isInteger(settings.delay) ||
      settings.delay! < 20 ||
      settings.delay! > 3000
    )
      return Response.json({ error: 'Invalid fault settings' }, { status: 400 });
    await new Promise((resolve) => setTimeout(resolve, settings.delay));
    if (settings.fails)
      return Response.json({ error: 'Controlled origin failure' }, { status: 503 });
    const payload: CatalogPayload = {
      service: 'demo-catalog',
      revision: crypto.randomUUID(),
      generatedAt: Date.now(),
      products: [
        { sku: 'edge-notebook', available: 42 },
        { sku: 'internet-pin', available: 18 },
      ],
    };
    return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  },
} satisfies ExportedHandler;

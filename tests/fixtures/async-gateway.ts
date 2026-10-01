import app from '../../worker/index';
export { ReliabilityLab, MonitorStore } from '../../worker/index';

type GatewayEnv = Parameters<typeof app.fetch>[1];

/** Local protocol fault only; this wrapper is never deployed. */
export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === 'POST' &&
      url.pathname === '/api/request' &&
      url.searchParams.get('fixture-admission') === '1'
    )
      return Response.json(
        {
          error: 'Controlled admission refusal',
          code: 'lab-admission-limited',
          retryAfterSeconds: 60,
        },
        { status: 429 },
      );
    if (
      request.method === 'GET' &&
      url.pathname === '/api/state' &&
      url.searchParams.get('fixture-fail') === '1'
    )
      return Response.json({ error: 'Controlled confirmation unavailable' }, { status: 503 });
    return app.fetch(request, env);
  },
} satisfies ExportedHandler<GatewayEnv>;

import gateway from '../../worker/index';
export { MonitorStore, ReliabilityLab } from '../../worker/index';

let calls = 0;
type GatewayEnv = Parameters<typeof gateway.fetch>[1];

/** Isolated runtime fixture: the namespace simulates a failing storage connection. */
export default {
  async fetch(request: Request, env: GatewayEnv) {
    if (new URL(request.url).pathname === '/__fixture/state')
      return Response.json({ fixture: 'LOCAL STORAGE FAILURE TEST', calls });
    const namespace = {
      idFromName: () => 'fixture-only',
      get: () => ({
        async fetch() {
          calls++;
          throw new Error('Exceeded allowed rows read in Durable Objects free tier.');
        },
      }),
    } as unknown as GatewayEnv['MONITORS'];
    return gateway.fetch(request, { ...env, MONITORS: namespace });
  },
};

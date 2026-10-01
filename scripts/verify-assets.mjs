import { verifyBuiltAssets } from './asset-verification.mjs';

if (process.argv.length !== 2) throw new Error('Asset check accepts no arguments');
const assets = await verifyBuiltAssets('http://localhost:8787/');
console.log(`PASS ${assets.length} complete local production assets: bytes, MIME and revalidation`);

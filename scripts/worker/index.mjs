// A Cloudflare Worker that runs the smoke checks against the built library, with no Node compatibility flag:
// if the library touched a Node-only API it would fail here.
import * as lib from '../../dist/index.js';
import { smoke } from '../smoke-core.mjs';

export default {
  async fetch() {
    try { return Response.json(await smoke(lib)); }
    catch (e) { return new Response(String(e && e.stack ? e.stack : e), { status: 500 }); }
  },
};

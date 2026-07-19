'use strict';

/**
 * Vercel catch-all serverless function for /api/*. Delegates to the shared
 * router (api/_app/router.js) — same behavior as the local dev-server.
 */

const { route } = require('./_app/router');

module.exports = (req, res) => route(req, res);

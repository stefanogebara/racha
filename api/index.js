'use strict';

/**
 * A função serverless única de /api/* — todo request chega aqui via o rewrite
 * "/api/(.*)" do vercel.json (padrão Express-on-Vercel; o req.url preserva o
 * caminho ORIGINAL, então o router enxerga /api/house/config etc.).
 *
 * Por que não api/[...path].js: o catch-all com colchetes só casava caminhos
 * de UM segmento no deploy real — /api/check funcionava, /api/webhooks/psp e
 * todo /api/house/* devolviam o 404 de plataforma da Vercel (achado do e2e
 * de produção, 2026-07-19). Rewrite explícito não depende de glob de
 * colchetes em lugar nenhum.
 */

const { route } = require('./_app/router');

module.exports = (req, res) => route(req, res);

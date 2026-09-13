// GERADO por scripts/gen-claim-patterns.js — NÃO EDITE À MÃO.
//
// A fonte é docs/compliance/claims.json. O censo de build e este guarda de
// runtime têm que aplicar a MESMA regra; escrever os padrões duas vezes já os
// fez divergir em quatro tokens, e a divergência não é simétrica — o que o
// build pega e o runtime não, chega ao cliente.
//
// Pra mudar a regra: edite o JSON e rode `node scripts/gen-claim-patterns.js`.
// O `api/__tests__/claims.test.js` falha se este arquivo sair de sincronia.

import Foundation

enum ClaimPatterns {
    static let substantivoGorjeta = "gorjeta|gorjetas|caixinha|gratifica[çc][ãa]o|servi(ç|c|ci)o|servi(ç|c|ci)os|service charge|service fee|\\btips?\\b|gratuity|propina|os 10\\s*%|os dez por cento"
    static let substantivoDestinatario = "equipe|equipo|\\bstaff\\b|\\bteam\\b|\\btime\\b|gar[çc]o[nm]s?|gar[çc]onete|atendente|pessoal\\b|el personal|sal[ãa]o|funcion[áa]ri|colaborador|mozo|moza|barman|bartender|cozinha|copa|camarer[oa]s?|meser[oa]s?|ma[îi]tre|sommelier|cumim|waiters?|servers?|\\bmo[çc]o|\\bmo[çc]a|quem (te )?(serve|serviu|atende|atendeu)|pra gente|pro pessoal|para n[óo]s|\\bto us\\b|para nosotros|\\bdeles\\b|\\bdelas\\b|com voc[êe]|\\beles\\b|\\bellos\\b"
    static let distribuidorComSujeito = "(restaurante|restaurant|\\bcasa\\b|house|venue|estabelecimento)[^.;]{0,50}(distribu|reparte|repassa|liquida)|(distribu|reparte|repassa|liquida)[^.;]{0,60}(restaurante|restaurant|\\bcasa\\b|house|venue|estabelecimento|CNPJ)|CNPJ (do|da) (restaurante|casa|estabelecimento|pr[óo]prio)|(passa|sai|entra|vai|é pag[oa]|s[ãa]o pag[oa]s)[^.;]{0,25}(pela |por |na |em )?(folha|payroll|n[óo]mina)"
    static let revogaDispensa = "\\b(sem|n[ãa]o|nunca|nem|without|sin)\\b|\\bno\\s+(payroll|folha|n[óo]mina)"
    /// Alta precisão, baixa cobertura: só ele autoriza SUPRIMIR uma oração.
    static let direcionalParaSuprimir = "(vai|v[ãa]o|segue|seguem|fica|ficam|cai|caem|entra|entram)\\s+(direto\\s+|integralmente\\s+|direta\\s+|na hora\\s+)?(pra|para|pro|pros|pras|com|ao?s?|[àá]s?)\\s+(a\\s+|o\\s+|os\\s+|as\\s+)?(equipe|equipo|gar[çc]o[nm]s?|gente|n[óo]s|time|pessoal|sal[ãa]o|mo[çc][oa]|maitre|cozinha)|goes?\\s+(straight\\s+|directly\\s+)?to\\s+(the\\s+|your\\s+|our\\s+)?(staff|team|waiters?|servers?|us)\\b|(keeps?|kept by)\\s+(the\\s+|your\\s+)?(staff|team|waiters?|servers?)|va[n]?\\s+(directa?\\s+)?(al|a\\s+l[oa]s?|para\\s+(el\\s+|los\\s+)?)\\s*(equipo|camarer[oa]s?|nosotros)|se\\s+queda\\s+con\\s+(el\\s+|la\\s+)?(equipo|camarer[oa])|(é|s[ãa]o)\\s+(d[oae]s?\\s+)?(gar[çc]o[nm]s?|equipe|pessoal|deles|delas)|100\\s*%\\s*(d[oae]s?\\s+)?(gorjeta|servi[çc]o)"
    /// A frase que o produto diz. Não é uma variação.
    static let sancionada = "o restaurante distribui à equipe, como manda a lei"
}

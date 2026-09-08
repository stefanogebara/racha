import Foundation

/// As frases da conversa, fora da View — porque concordância é regra, não
/// enfeite, e regra se testa.
///
/// Dois erros de português estavam na tela, os dois por texto montado à mão
/// dentro do corpo de uma View, onde nenhum teste alcançava:
///
///   "Faltam 1 itens sem dono."   → verbo e substantivo no plural pra contagem 1
///   "a pudim foi minha"          → artigo e adjetivo femininos num nome masculino
///
/// O segundo não tem conserto por concordância: não há como saber o gênero de um
/// nome de prato arbitrário ("pudim", "picanha", "chopp", "caipirinha"). A saída
/// é uma construção que não peça gênero nenhum — em português, pedido de comida
/// aceita substantivo nu: "eu pedi pudim", "eu pedi picanha". Serve pra
/// qualquer nome, e é como as pessoas falam.
enum ThreadCopy {

    /// A linha de cima da conversa.
    static func headline(itemCount: Int, unassignedCount: Int) -> String {
        if itemCount == 0 { return "Manda a foto da nota, ou só fala o que rolou." }
        if unassignedCount == 1 { return "Falta 1 item sem dono." }
        if unassignedCount > 1 { return "Faltam \(unassignedCount) itens sem dono." }
        return "Tudo dividido. Quer acertar?"
    }

    /// A sugestão de reivindicar um item, sem pedir gênero ao idioma.
    static func claimSuggestion(itemName: String) -> String {
        "eu pedi \(itemName.lowercased())"
    }
}

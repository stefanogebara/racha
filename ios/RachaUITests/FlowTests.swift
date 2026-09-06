import XCTest

/// The flows a person actually walks, driven by a finger the machine owns.
///
/// The unit suites prove the money is right. Nothing proved the *app* is right:
/// that the button you can see is the button that works, that a sheet opens and
/// closes, that first run leads somewhere. A simulator screenshot cannot say
/// that either — it is one frame with no finger in it.
///
/// Every test starts from a device that has never run Racha (`-racha.resetState`),
/// so the order the tests happen to run in cannot change the answer.
///
/// Screenshots are attached with `.keepAlways`, so a failing run leaves the
/// picture of the screen it failed on inside the result bundle.
final class FlowTests: XCTestCase {

    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: Helpers

    /// A freshly wiped app. `route` seeds the four demo tables and lands on a
    /// screen; without it the app opens on first run, like a new install.
    @discardableResult
    private func launch(route: String? = nil, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-racha.resetState", "YES"] + extra
        if let route { app.launchArguments += ["-racha.debugRoute", route] }
        app.launch()
        return app
    }

    private func shoot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Money as the app really renders it: `BRL.format` puts a NON-BREAKING
    /// space after the symbol, which is correct Brazilian typography and which
    /// no test written by eye will ever type. A literal "R$ 90,10" with an
    /// ordinary space matches nothing, and the failure reads as "the amount is
    /// missing" rather than "your string is wrong".
    private func brl(_ amount: String) -> String { "R$\u{00A0}" + amount }

    /// XCUIElement.waitForExistence, but it says what it was waiting for.
    private func require(_ element: XCUIElement, _ what: String,
                         timeout: TimeInterval = 8,
                         file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout),
                      "não apareceu: \(what)", file: file, line: line)
    }

    // MARK: First run

    /// The cover, the name, the three doors. The one flow every single person
    /// walks exactly once, and the only one nobody can retry.
    func testOnboardingReachesTheGallery() {
        let app = launch()

        let start = app.buttons["Começar"]
        require(start, "o botão Começar da capa")
        shoot(app, "01-onboarding-capa")
        start.tap()

        let name = app.textFields["seu nome"]
        require(name, "o campo de nome")
        name.tap()
        name.typeText("Stefano")
        shoot(app, "02-onboarding-nome")

        app.buttons["Continuar"].tap()

        let example = app.buttons["door.example"]
        require(example, "a porta do exemplo")
        shoot(app, "03-onboarding-portas")
        example.tap()

        // The example door seeds the four tables and lands on the gallery.
        require(app.staticTexts["Mesas anteriores"], "a galeria com mesas")
        shoot(app, "04-galeria-depois-do-onboarding")
    }

    /// Onboarding must not come back. It is stored, not derived from "are there
    /// any tables?" — deleting every table must not re-teach someone the app.
    func testOnboardingDoesNotReturnOnRelaunch() {
        let app = launch()
        app.buttons["Começar"].tap()
        let name = app.textFields["seu nome"]
        require(name, "o campo de nome")
        name.tap()
        name.typeText("Stefano")
        app.buttons["Continuar"].tap()
        app.buttons["door.example"].tap()
        require(app.staticTexts["Mesas anteriores"], "a galeria")

        // Relaunch WITHOUT the reset flag: the same install, opened again.
        app.terminate()
        let again = XCUIApplication()
        again.launchArguments = []
        again.launch()
        XCTAssertFalse(again.buttons["Começar"].waitForExistence(timeout: 3),
                       "o onboarding voltou depois de já ter sido feito")
    }

    // MARK: The table

    /// The first screen of the product: your part, what the table still owes,
    /// and one action.
    func testGalleryShowsTheOpenTable() {
        let app = launch(route: "gallery")
        require(app.staticTexts["Bar do Zé · Mesa 12 · agora"], "o cabeçalho da mesa aberta")
        // The hero figure counts up (AnimatedMoney), so its label is in motion
        // for about a second after the screen lands. Wait for the number, do
        // not assert on the first frame.
        require(app.staticTexts[brl("90,10")], "a figura da sua parte")
        require(app.buttons["Pagar " + brl("90,10")], "a ação de pagar")
        shoot(app, "05-galeria")
    }

    /// Pagar → the sheet with the BR Code, and the 10% that the law says must be
    /// removable. This is the CDC non-negotiable, checked by a finger.
    func testPaySheetOpensAndServiceIsRemovable() {
        let app = launch(route: "gallery")
        let pay = app.buttons["Pagar " + brl("90,10")]
        require(pay, "o botão Pagar")
        pay.tap()

        require(app.staticTexts["Pagar"], "o título da sheet Pagar")
        XCTAssertTrue(app.buttons["Copiar Pix"].exists, "o botão de copiar o BR Code")
        shoot(app, "06-pagar")

        // The serviço is pre-selected and removable, never locked.
        let remove = app.buttons["pay.service.remove"]
        require(remove, "o botão de tirar o serviço")
        remove.tap()

        // Removing R$ 7,10 of serviço from R$ 90,10 leaves R$ 83,00.
        require(app.staticTexts[brl("83,00")], "a sua parte sem o serviço")
        shoot(app, "07-pagar-sem-servico")

        // And it comes back.
        app.buttons["pay.service.restore"].tap()
        require(app.staticTexts[brl("90,10")], "a sua parte com o serviço de volta")
    }

    /// The sheet must close. A sheet you cannot dismiss is a dead end, and the
    /// pay sheet is the screen someone opens while a waiter waits.
    func testPaySheetCloses() {
        let app = launch(route: "pay")
        require(app.staticTexts["Pagar"], "a sheet Pagar")
        app.buttons["Fechar"].tap()
        XCTAssertTrue(app.staticTexts["Pagar"].waitForNonExistence(timeout: 5),
                      "a sheet Pagar não fechou")
    }

    // MARK: The bill

    /// Every line of the check, who claimed it, and the one with no owner —
    /// which is the thing that keeps a table from closing.
    func testLedgerListsTheCheck() {
        let app = launch(route: "ledger")
        require(app.staticTexts["A conta"], "o título da conta")
        XCTAssertTrue(app.staticTexts["Picanha na chapa"].exists, "a picanha")
        XCTAssertTrue(app.staticTexts["Pudim"].exists, "o pudim")
        XCTAssertTrue(app.staticTexts["sem dono"].exists, "a marca do item sem dono")
        XCTAssertTrue(app.staticTexts.matching(identifier: brl("372,50")).firstMatch.exists,
                      "o total da mesa")
        shoot(app, "08-conta")
        app.buttons["Pronto"].tap()
        XCTAssertTrue(app.staticTexts["A conta"].waitForNonExistence(timeout: 5),
                      "a conta não fechou")
    }

    // MARK: The thread

    /// The conversation is the product's second half; it must open and accept
    /// typing with no key configured (MockTransport).
    func testThreadAcceptsAMessage() {
        let app = launch(route: "thread")
        require(app.staticTexts["Bar do Zé"], "o cabeçalho da conversa")
        shoot(app, "09-conversa")

        let composer = app.textViews["fala aí…"].exists
            ? app.textViews["fala aí…"] : app.textFields["fala aí…"]
        require(composer, "o campo da conversa")
        composer.tap()
        composer.typeText("a pudim foi minha")
        shoot(app, "10-conversa-digitada")
    }

    // MARK: Settings

    /// The name typed at first run has to be the name the app uses. It is the
    /// only thing onboarding asks for, and a preference that silently fails to
    /// stick is worse than one the app never asked about.
    func testTheNameFromOnboardingReachesSettings() {
        let app = launch()
        app.buttons["Começar"].tap()
        let name = app.textFields["seu nome"]
        require(name, "o campo de nome")
        name.tap()
        name.typeText("Stefano")
        app.buttons["Continuar"].tap()
        app.buttons["door.example"].tap()
        require(app.staticTexts["Mesas anteriores"], "a galeria")

        app.buttons["Ajustes"].tap()
        let field = app.textFields["Nome"]
        require(field, "o campo Nome em Ajustes")
        XCTAssertEqual(field.value as? String, "Stefano",
                       "o nome do primeiro uso não chegou nos Ajustes")
        shoot(app, "12-ajustes-nome")
    }

    /// The API key is a secret. It must never be a plain text field, on a screen
    /// people open in public with a stranger's eyes over their shoulder.
    func testTheAgentKeyIsASecureField() {
        let app = launch(route: "gallery")
        // Wait for the seed to land before touching anything. Tapping while the
        // gallery is still growing rows loses the tap: two runs in three failed
        // without this, and a flaky test is worse than no test.
        require(app.staticTexts["Bar do Zé · Mesa 12 · agora"], "a mesa aberta")
        app.buttons["Ajustes"].tap()
        require(app.staticTexts["Agente"], "a seção do agente")
        XCTAssertTrue(app.secureTextFields["Chave Anthropic"].exists,
                      "a chave da Anthropic não está num campo protegido")
        XCTAssertFalse(app.textFields["Chave Anthropic"].exists,
                       "a chave da Anthropic está num campo de texto comum")
    }

    /// Demo mode is a product mode, not a stub (decision #12): with no key at
    /// all the app must still answer, and the answer must be about this table.
    func testTheAgentAnswersWithNoKeyConfigured() {
        let app = launch(route: "thread")
        require(app.staticTexts["Bar do Zé"], "a conversa")
        let suggestion = app.buttons["divide o resto por igual"]
        require(suggestion, "uma sugestão do compositor")
        suggestion.tap()
        // MockTransport streams; give it room, then assert the thread grew.
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "R$")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 12),
                      "o agente não respondeu nada com dinheiro dentro")
        shoot(app, "13-agente-demo")
    }

    /// Settings is where the API keys live. It must open and close, and it must
    /// not show a key in the clear.
    func testSettingsOpensAndCloses() {
        let app = launch(route: "gallery")
        require(app.staticTexts["Bar do Zé · Mesa 12 · agora"], "a mesa aberta")
        let settings = app.buttons["Ajustes"]
        require(settings, "o botão de Ajustes")
        settings.tap()
        shoot(app, "11-ajustes")
        // Whatever it is titled, it has to be dismissible.
        let done = app.buttons["Pronto"].exists ? app.buttons["Pronto"] : app.buttons["Fechar"]
        require(done, "o botão de fechar os Ajustes")
        done.tap()
        require(app.staticTexts["Mesas anteriores"], "a galeria de volta")
    }
}

private extension XCUIElement {
    /// The inverse of `waitForExistence`, which XCTest does not provide.
    func waitForNonExistence(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !exists { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return !exists
    }
}

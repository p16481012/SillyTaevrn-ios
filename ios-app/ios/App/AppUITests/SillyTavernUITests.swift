import XCTest

/// Uses the shipped WebView and embedded server in owned Simulator containers.
/// Tests complete real onboarding and never inject app readiness or chat replies.
@MainActor
final class SillyTavernUITests: XCTestCase {
    private var app: XCUIApplication!
    private var personaName = ""
    private var uiProfile = ""
    private var uiLanguage = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "com.sillytavern.ios")
        XCUIDevice.shared.orientation = .portrait
        let environment = ProcessInfo.processInfo.environment
        uiProfile = try XCTUnwrap(environment["ST_UI_PROFILE"] ?? environment["TEST_RUNNER_ST_UI_PROFILE"],
                                  "The runner must inject an explicit UI profile")
        uiLanguage = try XCTUnwrap(environment["ST_UI_LANGUAGE"] ?? environment["TEST_RUNNER_ST_UI_LANGUAGE"],
                                   "The runner must inject an explicit UI language")
        XCTAssertTrue(["iphone-pro-en", "iphone-small-en", "ipad-en", "iphone-ko"].contains(uiProfile))
        XCTAssertTrue(["en", "ko-kr"].contains(uiLanguage))
        XCTAssertEqual(uiLanguage, uiProfile == "iphone-ko" ? "ko-kr" : "en",
                       "The runner must inject the requested language for its profile")
        // Keep the OS keyboard and QuickPath prompt deterministic. The Korean
        // profile must change the app's own selector, not infer its language
        // from AppleLocale or navigator.language.
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    }

    override func tearDownWithError() throws {
        attachEvidence("final-state")
        app.terminate()
        XCUIDevice.shared.orientation = .portrait
    }

    private var webView: XCUIElement { app.webViews["st-webview"] }

    private func localized(_ label: String) -> String {
        guard uiLanguage == "ko-kr" else { return label }
        // These strings are shipped in the locale assets or the native
        // diagnostics UI. Other labels retain the genuine English fallback.
        return [
            "AI Response Configuration": "AI 응답 구성",
            "Response (tokens)": "응답 길이 (토큰)",
            "Persona Management": "페르소나 관리",
            // Onboarding uses popup-button-save, rather than the general Save key.
            "Save": "저장하기",
            "UI Language": "UI 언어",
            "User Settings": "사용자 설정",
            "Export diagnostics": "진단 로그 내보내기",
            "Character Management": "캐릭터 관리",
            "API Connections": "API 연결",
            "Connect": "연결",
            "Send a message": "메시지 보내기",
            "Abort request": "요청 중단",
        ][label] ?? label
    }

    private func webControl(_ identifier: String, label: String,
                            type: XCUIElement.ElementType) -> XCUIElement {
        // Some shipping WebKit versions omit HTML ids from XCTest snapshots.
        // Prefer an id when available; match the actual control type otherwise,
        // so a slider's preceding caption cannot satisfy the same label query.
        let controls = webView.descendants(matching: type)
        let identified = controls.matching(identifier: identifier).firstMatch
        return identified.exists ? identified : controls.matching(NSPredicate(format: "label == %@ OR label == %@", label, localized(label))).firstMatch
    }

    private func checkProfileGeometry() {
        let frame = webView.frame
        XCTAssertLessThan(frame.width, frame.height, "Each profile starts in portrait")
        if uiProfile == "iphone-small-en" {
            // SE / 13 mini / 16e are ordered runtime fallbacks in CI. Record
            // the actual frame rather than calling a Pro device a small phone.
            XCTAssertLessThanOrEqual(frame.width, 390)
            XCTAssertLessThanOrEqual(frame.height, 844)
        } else if uiProfile == "ipad-en" {
            XCTAssertGreaterThanOrEqual(frame.width, 768)
        } else {
            XCTAssertLessThan(frame.width, 768)
        }
        let details = XCTAttachment(string: "Profile: \(uiProfile)\nRequested app UI language: \(uiLanguage)\nOS test language: en_US\nActual portrait WebView frame: \(frame)")
        details.name = "00-validation-profile"
        details.lifetime = .keepAlways
        add(details)
    }

    private func waitForVisibleBounds(_ elements: [XCUIElement], timeout: TimeInterval = 15,
                                      file: StaticString = #filePath, line: UInt = #line) {
        var lastObservation = "The visibility predicate was not evaluated"
        let predicate = NSPredicate { [weak self] _, _ in
            guard let self = self else { return false }
            let webExists = self.webView.exists
            let webFrame = webExists ? self.webView.frame : .null
            let visible = webFrame.insetBy(dx: -1, dy: -1)
            let portrait = webFrame.height > webFrame.width
            let keyboard = self.app.keyboards.firstMatch
            let keyboardExists = keyboard.exists
            let keyboardFrame = keyboardExists ? keyboard.frame : .null
            let keyboardInsideScreen = !keyboardExists
                || (keyboardFrame.width > 0 && keyboardFrame.height > 0
                    && webFrame.insetBy(dx: -2, dy: -2).contains(keyboardFrame))
            var controlObservations: [String] = []
            var allVisible = webExists && webFrame.width > 0 && webFrame.height > 0
                && keyboardInsideScreen
            for (index, element) in elements.enumerated() {
                let exists = element.exists
                let liveFrame = exists ? element.frame : .null
                var frame = liveFrame
                var frameSource = "live"
                if portrait && exists && (liveFrame.width <= 0 || liveFrame.height <= 0) {
                    // WebKit occasionally reports a zero live frame for the
                    // visible onboarding Save button. Only in portrait,
                    // use one snapshot as a fallback for that invalid frame;
                    // rotated keyboard snapshots can retain portrait axes.
                    do {
                        frame = try element.snapshot().frame
                        frameSource = "portraitSnapshotFallback"
                    } catch {
                        frameSource = "portraitSnapshotFailed(\(error))"
                    }
                }
                let positiveFrame = frame.width > 0 && frame.height > 0
                let hittable = positiveFrame && element.isHittable
                let inVisibleBounds = positiveFrame && visible.contains(frame)
                var clearOfKeyboard = true
                // Compare real screen coordinates, including the accessory
                // area. The floating iPad keyboard matters only if its frame
                // overlaps this control horizontally.
                if keyboardExists && keyboardFrame.height > 0
                    && frame.minX < keyboardFrame.maxX && frame.maxX > keyboardFrame.minX {
                    if keyboardFrame.width >= webFrame.width * 0.9 {
                        clearOfKeyboard = frame.maxY <= keyboardFrame.minY + 1
                    } else {
                        clearOfKeyboard = !frame.intersects(keyboardFrame)
                    }
                }
                controlObservations.append("\(index): exists=\(exists), liveFrame=\(liveFrame), "
                    + "frameSource=\(frameSource), hittable=\(hittable), frame=\(frame), "
                    + "insideWebView=\(inVisibleBounds), clearOfKeyboard=\(clearOfKeyboard)")
                allVisible = allVisible && exists && hittable && inVisibleBounds && clearOfKeyboard
            }
            lastObservation = "webViewExists=\(webExists), webView=\(webFrame), "
                + "keyboardExists=\(keyboardExists), keyboard=\(keyboardFrame), "
                + "keyboardInsideScreen=\(keyboardInsideScreen); "
                + controlObservations.joined(separator: "; ")
            return allVisible
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout),
                       .completed, "Controls must fit inside the WebView and above the real keyboard. \(lastObservation)",
                       file: file, line: line)
    }

    private func selectKoreanOnboardingLanguage() {
        dismissKeyboardIntroductionIfPresent()
        let language = webControl("onboarding_ui_language_select", label: "UI Language", type: .other)
        XCTAssertTrue(language.waitForExistence(timeout: 15))
        waitForHittable(language)
        let wheel = app.pickerWheels.firstMatch
        let menu = app.collectionViews.firstMatch
        var tapLog = "keyboardBefore=\(app.keyboards.firstMatch.exists); actionCount=0"
        defer {
            let attachment = XCTAttachment(string: tapLog)
            attachment.name = "01-language-select-actions"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        func tapRealLanguageSelect(at horizontalOffset: CGFloat) -> Bool {
            // Both touches land inside the actual HTML select. Query fresh
            // geometry because the native keyboard can change its AX frame.
            let selectFrame = (try? language.snapshot())?.frame ?? language.frame
            let webFrame = (try? webView.snapshot())?.frame ?? webView.frame
            let point = CGPoint(x: selectFrame.minX + selectFrame.width * horizontalOffset,
                                y: selectFrame.midY)
            guard selectFrame.width > 4, selectFrame.height > 4,
                  webFrame.width > 0, webFrame.height > 0,
                  webFrame.insetBy(dx: 1, dy: 1).contains(selectFrame),
                  selectFrame.insetBy(dx: 2, dy: 2).contains(point),
                  language.isHittable else {
                tapLog += "; refusedTapOffset=\(horizontalOffset), select=\(selectFrame), web=\(webFrame), hittable=\(language.isHittable)"
                XCTFail("The real language select needs a safe, hittable point inside the WebView. \(tapLog)")
                return false
            }
            language.coordinate(withNormalizedOffset: CGVector(dx: horizontalOffset, dy: 0.5)).tap()
            tapLog += "; actionCount=\(horizontalOffset == 0.5 ? 1 : 2), select=\(selectFrame), point=\(point), keyboard=\(app.keyboards.firstMatch.exists), wheel=\(wheel.exists), menu=\(menu.exists)"
            return true
        }
        guard tapRealLanguageSelect(at: 0.5) else { return }
        let nativeSelectAppeared = NSPredicate { _, _ in wheel.exists || menu.exists }
        let firstMenuWait = XCTWaiter.wait(
            for: [XCTNSPredicateExpectation(predicate: nativeSelectAppeared, object: nil)], timeout: 3)
        tapLog += "; firstMenuWait=\(firstMenuWait), keyboard=\(app.keyboards.firstMatch.exists), wheel=\(wheel.exists), menu=\(menu.exists), value=\(String(describing: language.value))"
        if firstMenuWait != .completed && !wheel.exists && !menu.exists
            && language.exists && language.value as? String == "English" {
            guard tapRealLanguageSelect(at: 0.88) else { return }
        }
        attachEvidence("01-language-selector")
        if wheel.waitForExistence(timeout: 2) {
            wheel.adjust(toPickerWheelValue: "한국어 (Korean)")
            // WebKit versions may apply the choice immediately or use a Done
            // accessory. Both operate the real native HTML select UI.
            let done = app.toolbars.buttons["Done"].firstMatch
            if done.exists && done.isHittable { done.tap() }
        } else {
            // iOS 26 presents a native context-menu collection. Its AX frame
            // includes all rows, even those below the smaller visible popup.
            // A whole-app swipe starts outside that popup and dismisses it.
            XCTAssertTrue(menu.waitForExistence(timeout: 5), "The real HTML language select must expose its native menu")
            XCTAssertTrue(menu.buttons["English"].exists)
            let menuFrame = menu.frame
            let clippingFrames = app.otherElements.containing(.button, identifier: "English")
                .allElementsBoundByIndex.map { $0.frame.intersection(menuFrame).intersection(webView.frame) }
                .filter { !$0.isNull && !$0.isEmpty && $0.width > 80 && $0.height > 80 }
            guard let clip = clippingFrames.min(by: { $0.width * $0.height < $1.width * $1.height }) else {
                XCTFail("Cannot locate the native language menu's visible clipping container")
                return
            }
            let option = menu.buttons
                .matching(NSPredicate(format: "label == %@", "한국어 (Korean)")).firstMatch
            let visibleOption = {
                guard option.exists else { return false }
                let bounds = option.frame
                return !bounds.isEmpty && clip.insetBy(dx: -1, dy: -1).contains(bounds)
                    && clip.insetBy(dx: 8, dy: 8).contains(CGPoint(x: bounds.midX, y: bounds.midY))
                    && option.isHittable
            }
            for _ in 0..<4 {
                if visibleOption() { break }
                XCTAssertTrue(menu.exists, "Scrolling must keep the native language menu open")
                let moveDown = option.exists && option.frame.maxY < clip.minY
                let startY = clip.minY + clip.height * (moveDown ? 0.2 : 0.8)
                let endY = clip.minY + clip.height * (moveDown ? 0.8 : 0.2)
                let origin = menu.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
                let currentFrame = menu.frame
                let start = origin.withOffset(CGVector(dx: clip.midX - currentFrame.minX, dy: startY - currentFrame.minY))
                let end = origin.withOffset(CGVector(dx: clip.midX - currentFrame.minX, dy: endY - currentFrame.minY))
                start.press(forDuration: 0.05, thenDragTo: end)
                _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in visibleOption() }, object: nil)], timeout: 3)
            }
            XCTAssertTrue(visibleOption(), "Korean must be fully inside the real menu clip before tapping it")
            attachEvidence("01b-language-option-visible")
            option.tap()
        }
        // The real change handler persists language and reloads the page. A
        // native waiting-interaction value alone cannot prove that reload.
        let welcome = webView.staticTexts
            .matching(NSPredicate(format: "label == %@", "SillyTavern에 오신 것을 환영합니다!")).firstMatch
        XCTAssertTrue(welcome.waitForExistence(timeout: 120), "Selecting Korean must render the shipped Korean welcome text")
        waitForState("waiting-interaction")
        let save = webControl("onboarding-confirm", label: "Save", type: .button)
        XCTAssertTrue(save.waitForExistence(timeout: 15))
        XCTAssertEqual(save.label, "저장하기")
        let selectedLanguage = webControl("onboarding_ui_language_select", label: "UI Language", type: .other)
        XCTAssertEqual(selectedLanguage.value as? String, "한국어 (Korean)")
        // Closing a native select and reloading can relinquish keyboard focus.
        // Restore it with a real touch before continuing the name-input test.
        if !app.keyboards.firstMatch.exists {
            let nameInput = webControl("onboarding-persona-name", label: "Persona name", type: .textView)
            waitForHittable(nameInput)
            nameInput.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            dismissKeyboardIntroductionIfPresent()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        }
        attachEvidence("01a-korean-onboarding")
    }

    private func waitForHittable(_ element: XCUIElement, timeout: TimeInterval = 15,
                                 file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate { _, _ in element.exists && element.isHittable }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout),
                       .completed, "Control is not reachable: \(element.identifier)", file: file, line: line)
    }

    private func waitForState(_ expected: String, timeout: TimeInterval = 120,
                              file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate { [weak self] _, _ in
            guard let self = self else { return false }
            return self.app.staticTexts["st-startup-error"].exists
                || (self.webView.exists && [expected, "failed"].contains(self.webView.value as? String ?? ""))
        }
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout)
        XCTAssertEqual(result, .completed, "Expected native startup state \(expected); WebView value: \(String(describing: webView.value))", file: file, line: line)
        XCTAssertEqual(webView.value as? String, expected, file: file, line: line)
        XCTAssertFalse(app.staticTexts["st-startup-error"].exists, file: file, line: line)
    }

    private func attachEvidence(_ name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-accessibility"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private func dismissKeyboardIntroductionIfPresent() {
        // A fresh Simulator may show iOS's QuickPath introduction over the
        // first user-activated keyboard. Complete that real OS prompt rather
        // than treating its preview keyboard as an editable app keyboard.
        let introduction = app.otherElements["UIContinuousPathIntroductionView"]
        guard introduction.waitForExistence(timeout: 2) else { return }
        let proceed = introduction.buttons["Continue"]
        waitForHittable(proceed)
        proceed.tap()
        let dismissed = NSPredicate { _, _ in !introduction.exists }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: dismissed, object: nil)], timeout: 5), .completed)
    }

    private func openResponseSettings() -> (slider: XCUIElement, counter: XCUIElement) {
        let toggle = webControl("leftNavDrawerIcon", label: "AI Response Configuration", type: .button)
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        waitForHittable(toggle)
        XCTAssertEqual(toggle.label, localized("AI Response Configuration"))
        toggle.tap()
        let slider = webControl("amount_gen", label: "Response (tokens)", type: .slider)
        // HTML number inputs can expose a SpinButton/adjustable trait rather
        // than TextField. This unique name belongs only to the numeric control.
        let counter = webControl("amount_gen_counter", label: "Response token count", type: .any)
        XCTAssertTrue(slider.waitForExistence(timeout: 15))
        XCTAssertTrue(counter.waitForExistence(timeout: 15))
        waitForHittable(slider)
        XCTAssertEqual(slider.label, localized("Response (tokens)"))
        waitForVisibleBounds([slider, counter])
        return (slider, counter)
    }

    private func dismissDiagnosticsShareSheet(evidence: String) {
        // UIKit can replace the activity controller's custom root identifier.
        // These are the actual native content/caption/activity elements exported
        // by the CI accessibility snapshots, including compact phone popovers.
        let sheet = app.otherElements["shareSheet.activity.contentView"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 20), "Export must present the actual native share sheet")
        let filename = app.otherElements.matching(NSPredicate(format:
            "(identifier == 'LP.CaptionBar.TopCaption' OR identifier == 'LP.CaptionBar.BottomCaption') AND label BEGINSWITH 'SillyTavern-diagnostics-'"
        )).firstMatch
        XCTAssertTrue(filename.waitForExistence(timeout: 15), "The share sheet must contain the generated diagnostic file")
        let save = app.cells.matching(NSPredicate(format: "label == 'Save to Files'")).firstMatch
        waitForHittable(save, timeout: 20)
        attachEvidence(evidence)
        // OS language is en_US for all profiles. The observed popover presents
        // a native dismissal region instead of a Close/Cancel button.
        var dismissalAction = "No native dismissal action was performed"
        var dismissalActionAttached = false
        func attachDismissalAction() {
            guard !dismissalActionAttached else { return }
            let attachment = XCTAttachment(string: dismissalAction)
            attachment.name = "\(evidence)-native-dismissal-action"
            attachment.lifetime = .keepAlways
            add(attachment)
            dismissalActionAttached = true
        }
        defer { attachDismissalAction() }
        let dismissed = NSPredicate { _, _ in !sheet.exists }
        let close = app.buttons
            .matching(NSPredicate(format: "label == 'Close' OR label == 'Cancel' OR label == 'Dismiss'"))
            .allElementsBoundByIndex.first { $0.exists && $0.isHittable }
        if let close = close {
            close.tap()
            dismissalAction = "Close/Cancel/Dismiss button tapped; outsideTapCount=0"
        } else {
            let region = app.otherElements["PopoverDismissRegion"]
            func tapOutsidePopover() -> String? {
                // Read current screen-coordinate frames for each native tap.
                // UIKit snapshots may fail even while both elements are
                // visible in the final accessibility hierarchy.
                let regionExists = region.exists
                let sheetExists = sheet.exists
                let outside = regionExists ? region.frame : .null
                let content = sheetExists ? sheet.frame : .null
                let geometry = "regionExists=\(regionExists), region=\(outside), "
                    + "sheetExists=\(sheetExists), content=\(content)"
                guard regionExists, sheetExists,
                      outside.width > 0, outside.height > 0,
                      content.width > 0, content.height > 0,
                      outside.contains(content),
                      content.minY - outside.minY > 90 else {
                    dismissalAction += "; rejectedGeometry=\(geometry)"
                    attachDismissalAction()
                    XCTFail("No safe native popover dismissal point was found. \(geometry)")
                    return nil
                }
                // The observed dismissal region covers the screen. Tap in
                // that native region above the visible share content.
                let point = CGPoint(x: outside.midX, y: outside.minY + (content.minY - outside.minY) / 2)
                guard outside.contains(point), !content.contains(point) else {
                    dismissalAction += "; rejectedPoint=\(point); \(geometry)"
                    attachDismissalAction()
                    XCTFail("The native dismissal point must be inside the region and outside share content. \(geometry), point=\(point)")
                    return nil
                }
                region.coordinate(withNormalizedOffset: CGVector(
                    dx: (point.x - outside.minX) / outside.width,
                    dy: (point.y - outside.minY) / outside.height
                )).tap()
                return "\(geometry), point=\(point)"
            }
            guard let firstTap = tapOutsidePopover() else { return }
            dismissalAction = "outsideTapCount=1; first=\(firstTap)"
            let earlyResult = XCTWaiter.wait(
                for: [XCTNSPredicateExpectation(predicate: dismissed, object: nil)], timeout: 3
            )
            dismissalAction += "; earlyDismissalResult=\(earlyResult)"
            if earlyResult != .completed && sheet.exists {
                guard let secondTap = tapOutsidePopover() else { return }
                dismissalAction += "; outsideTapCount=2; second=\(secondTap)"
            }
        }
        let dismissalResult = XCTWaiter.wait(
            for: [XCTNSPredicateExpectation(predicate: dismissed, object: nil)], timeout: 15
        )
        dismissalAction += "; finalDismissalResult=\(dismissalResult)"
        attachDismissalAction()
        XCTAssertEqual(dismissalResult, .completed)
        waitForState("ready", timeout: 20)
    }

    private struct ChatFixture: Decodable {
        let schemaVersion: Int
        let fixtureId: String
        let characterName: String
        let avatar: String
        let firstPrompt: String
        let firstPrefix: String
        let firstResponse: String
        let cancelPrompt: String
        let cancelPrefix: String
        let forbiddenSuffix: String
    }

    private enum ChatValidationError: Error {
        case missingOrInvalidFixture
        case unexpectedBackendResponse
        case conversationWasNotSaved
        case rendererDidNotExposeMessage
    }

    private enum ChatReadStage: String {
        case csrf = "csrf-token"
        case character = "character-get"
        case chat = "chat-get"
        case settings = "settings-get"
        case confirmation = "save-confirmation"
        case route = "unsupported-read-path"
    }

    private struct ChatReadFailure: Error {
        let stage: ChatReadStage
        let reason: String
        var httpStatus: Int? = nil
        var errorDomain: String? = nil
        var errorCode: Int? = nil

        static func network(_ error: Error, stage: ChatReadStage) -> ChatReadFailure {
            let error = error as NSError
            let domain = ["NSURLErrorDomain", "NSCocoaErrorDomain", "NSPOSIXErrorDomain"].contains(error.domain)
                ? error.domain : "other"
            return ChatReadFailure(stage: stage, reason: "request-or-decoding-error",
                                   errorDomain: domain, errorCode: error.code)
        }
    }

    private func attachChatReadFailure(_ failure: ChatReadFailure, attempts: Int) {
        var fields: [String: Any] = ["schemaVersion": 1, "requestStage": failure.stage.rawValue,
                                     "reason": failure.reason, "attempts": min(100, max(0, attempts))]
        if let status = failure.httpStatus { fields["httpStatus"] = status }
        if let domain = failure.errorDomain { fields["errorDomain"] = domain }
        if let code = failure.errorCode { fields["errorCode"] = code }
        guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.prettyPrinted, .sortedKeys]),
              data.count <= 4096 else { return }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "chat-save-failure.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func chatFixture() throws -> ChatFixture {
        let environment = ProcessInfo.processInfo.environment
        guard let serialized = environment["ST_CHAT_FIXTURE_JSON"] ?? environment["TEST_RUNNER_ST_CHAT_FIXTURE_JSON"],
              let data = serialized.data(using: .utf8), data.count <= 8192,
              let fixture = try? JSONDecoder().decode(ChatFixture.self, from: data),
              fixture.schemaVersion == 1, UUID(uuidString: fixture.fixtureId) != nil,
              fixture.avatar.hasSuffix(".png"), !fixture.avatar.contains("/"), !fixture.avatar.contains("\\"),
              [fixture.characterName, fixture.avatar, fixture.firstPrompt, fixture.firstPrefix,
               fixture.firstResponse, fixture.cancelPrompt, fixture.cancelPrefix, fixture.forbiddenSuffix]
                .allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 && !$0.contains("\0") }),
              fixture.firstResponse.hasPrefix(fixture.firstPrefix), fixture.firstResponse != fixture.firstPrefix,
              fixture.firstPrompt != fixture.cancelPrompt, !fixture.cancelPrefix.contains(fixture.forbiddenSuffix) else {
            throw ChatValidationError.missingOrInvalidFixture
        }
        return fixture
    }

    private func exactChatText(_ text: String) -> XCUIElement {
        webView.staticTexts.matching(NSPredicate(format: "label == %@", text)).firstMatch
    }

    private func renderedChatText(_ text: String, timeout: TimeInterval = 30) throws -> String {
        let message = exactChatText(text)
        guard message.waitForExistence(timeout: timeout) else {
            XCTFail("The real WebView did not render the expected generated fixture message")
            throw ChatValidationError.rendererDidNotExposeMessage
        }
        let observed = message.label
        XCTAssertEqual(observed, text)
        return observed
    }

    private func reachConnectButton(_ connect: XCUIElement) {
        XCTAssertTrue(connect.waitForExistence(timeout: 20))
        // The shipped API drawer scrolls independently of the chat. Use its
        // actual native bounds when WebKit exposes the HTML id; otherwise use
        // a containing AX group clipped to the WebView, with the same left
        // edge as this drawer. No JavaScript scroll or click is injected.
        for _ in 0..<8 {
            if connect.isHittable { return }
            let visible = webView.frame
            let identified = webView.otherElements["rm_api_block"].firstMatch
            let candidates = webView.otherElements.containing(.button, identifier: localized("Connect"))
                .allElementsBoundByIndex.map { $0.frame.intersection(visible) }
                .filter { !$0.isNull && !$0.isEmpty && $0.width > 100 && $0.height > 150 }
            var clip = identified.exists ? identified.frame.intersection(visible) :
                candidates.min(by: { $0.width * $0.height < $1.width * $1.height }) ?? visible
            let bottom = min(clip.maxY, visible.maxY)
            clip.origin.y = max(clip.minY, webControl("API-status-top", label: "API Connections", type: .button).frame.maxY + 5)
            clip.size.height = max(0, bottom - clip.minY)
            guard clip.width > 20, clip.height > 120 else {
                XCTFail("The actual API drawer has no reachable scrolling area")
                return
            }
            // Drag in the drawer's empty left padding, away from address/key
            // inputs, to scroll its real overflow container.
            let origin = webView.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            let x = clip.minX + 8 - visible.minX
            let start = origin.withOffset(CGVector(dx: x, dy: clip.minY + clip.height * 0.80 - visible.minY))
            let finish = origin.withOffset(CGVector(dx: x, dy: clip.minY + clip.height * 0.25 - visible.minY))
            start.press(forDuration: 0.05, thenDragTo: finish)
        }
        waitForHittable(connect, timeout: 10)
    }

    private func sendChatPrompt(_ prompt: String) throws -> String {
        let input = webControl("send_textarea", label: "Message", type: .textView)
        waitForHittable(input, timeout: 30)
        input.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        dismissKeyboardIntroductionIfPresent()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        input.typeText(prompt)
        let completePrompt = NSPredicate { _, _ in (input.value as? String) == prompt }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: completePrompt, object: nil)], timeout: 15), .completed,
                       "The software keyboard must enter the complete chat prompt")
        XCTAssertEqual(input.value as? String, prompt)
        let send = webControl("send_but", label: "Send a message", type: .button)
        waitForHittable(send, timeout: 30)
        waitForVisibleBounds([input, send])
        XCTAssertEqual(send.label, localized("Send a message"))
        XCTAssertTrue(send.isEnabled)
        send.tap()
        let cleared = NSPredicate { _, _ in input.exists && (input.value as? String) != prompt }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: cleared, object: nil)], timeout: 15), .completed,
                       "Send must consume the actual typed input")
        return try renderedChatText(prompt)
    }

    private func fixtureBackendJSON(_ path: String, body: [String: String]? = nil,
                                    session: URLSession, csrf: String? = nil) async throws -> Any {
        // This helper only reads the owned synthetic fixture from the embedded
        // loopback backend. It never calls Generate, chat save, or app scripts.
        let stages: [String: ChatReadStage] = ["/csrf-token": .csrf, "/api/characters/get": .character,
                                             "/api/chats/get": .chat, "/api/settings/get": .settings]
        guard let stage = stages[path],
              let url = URL(string: "http://localhost:8000\(path)") else {
            throw ChatReadFailure(stage: .route, reason: "invalid-read-route")
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(csrf, forHTTPHeaderField: "x-csrf-token")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch {
            throw ChatReadFailure.network(error, stage: stage)
        }
        let (data, response) = result
        guard let response = response as? HTTPURLResponse else {
            throw ChatReadFailure(stage: stage, reason: "invalid-http-response")
        }
        guard response.statusCode == 200 else {
            throw ChatReadFailure(stage: stage, reason: "http-status", httpStatus: response.statusCode)
        }
        guard data.count <= 4 * 1024 * 1024 else {
            throw ChatReadFailure(stage: stage, reason: "response-size-limit")
        }
        do {
            return try JSONSerialization.jsonObject(with: data)
        } catch {
            throw ChatReadFailure.network(error, stage: stage)
        }
    }

    private func waitForSavedConversation(_ fixture: ChatFixture, greeting: String, firstPrompt: String,
                                          firstResponse: String, cancelPrompt: String, cancelResponse: String) async throws -> String {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 8
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let tokenResponse: [String: Any]?
        do {
            tokenResponse = try await fixtureBackendJSON("/csrf-token", session: session) as? [String: Any]
        } catch {
            attachChatReadFailure((error as? ChatReadFailure) ?? .network(error, stage: .csrf), attempts: 1)
            throw ChatValidationError.unexpectedBackendResponse
        }
        guard let csrf = tokenResponse?["token"] as? String, !csrf.isEmpty else {
            attachChatReadFailure(ChatReadFailure(stage: .csrf, reason: "invalid-response-shape"), attempts: 1)
            throw ChatValidationError.unexpectedBackendResponse
        }
        let deadline = Date().addingTimeInterval(45)
        var attempts = 0
        var stage = ChatReadStage.confirmation
        var lastFailure = ChatReadFailure(stage: .confirmation, reason: "conversation-not-yet-saved")
        repeat {
            attempts += 1
            do {
                stage = .character
                let card = try await fixtureBackendJSON("/api/characters/get", body: ["avatar_url": fixture.avatar], session: session, csrf: csrf) as? [String: Any]
                guard card?["name"] as? String == fixture.characterName,
                      let chatName = card?["chat"] as? String, !chatName.isEmpty,
                      !chatName.contains("/"), !chatName.contains("\\") else {
                    throw ChatReadFailure(stage: .character, reason: "invalid-response-shape")
                }
                stage = .chat
                let rows = try await fixtureBackendJSON("/api/chats/get", body: ["avatar_url": fixture.avatar, "file_name": chatName], session: session, csrf: csrf) as? [[String: Any]]
                let messages = (rows ?? []).filter { $0["mes"] is String }
                let userMessages = messages.filter { $0["is_user"] as? Bool == true }.compactMap { $0["mes"] as? String }
                let assistantMessages = messages.filter { $0["is_user"] as? Bool == false }.compactMap { $0["mes"] as? String }
                stage = .settings
                let settingsResponse = try await fixtureBackendJSON("/api/settings/get", body: [:], session: session, csrf: csrf) as? [String: Any]
                let settingsData = (settingsResponse?["settings"] as? String)?.data(using: .utf8)
                let settings: [String: Any]?
                if let settingsData = settingsData {
                    settings = try JSONSerialization.jsonObject(with: settingsData) as? [String: Any]
                } else {
                    settings = nil
                }
                let powerUser = settings?["power_user"] as? [String: Any]
                stage = .confirmation
                if rows?.count == 6, messages.count == 5,
                   userMessages == [firstPrompt, cancelPrompt],
                   assistantMessages == [greeting, firstResponse, cancelResponse],
                   !messages.contains(where: { ($0["mes"] as? String ?? "").contains(fixture.forbiddenSuffix) }),
                   settings?["active_character"] as? String == fixture.avatar,
                   powerUser?["auto_load_chat"] as? Bool == true {
                    return chatName
                }
                lastFailure = ChatReadFailure(stage: .confirmation, reason: "conversation-not-yet-saved")
            } catch {
                // No raw config, response body, cookie, or localized network
                // error enters XCTest attachments. A bounded retry handles a
                // genuine in-flight save before terminating the app.
                lastFailure = (error as? ChatReadFailure) ?? .network(error, stage: stage)
            }
            try await Task.sleep(nanoseconds: 500_000_000)
        } while Date() < deadline && attempts < 100
        attachChatReadFailure(lastFailure, attempts: attempts)
        XCTFail("The embedded backend did not persist all five fixture messages and the active character before cold relaunch")
        throw ChatValidationError.conversationWasNotSaved
    }

    func testChatGenerationSaveAndColdRelaunch() async throws {
        let fixture = try chatFixture()
        app.launch()
        XCTAssertTrue(webView.waitForExistence(timeout: 360))
        waitForState("waiting-interaction", timeout: 360)
        checkProfileGeometry()
        if uiLanguage == "ko-kr" { selectKoreanOnboardingLanguage() }
        let name = webControl("onboarding-persona-name", label: "Persona name", type: .textView)
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        dismissKeyboardIntroductionIfPresent()
        waitForHittable(name)
        let originalName = name.value as? String ?? ""
        name.typeText("Native Chat Test")
        let completeName = NSPredicate { _, _ in
            guard let value = name.value as? String else { return false }
            return value != originalName && value.contains("Native Chat Test")
        }
        let completeNameResult = await XCTWaiter.fulfillment(
            of: [XCTNSPredicateExpectation(predicate: completeName, object: nil)], timeout: 15, enforceOrder: false)
        XCTAssertEqual(completeNameResult, .completed,
                       "The software keyboard must enter the complete chat persona name")
        let confirm = webControl("onboarding-confirm", label: "Save", type: .button)
        waitForHittable(confirm)
        confirm.tap()
        waitForState("ready", timeout: 120)
        XCTAssertFalse(name.exists)
        attachEvidence("chat-01-onboarding-ready")

        let characters = webControl("rightNavDrawerIcon", label: "Character Management", type: .button)
        waitForHittable(characters)
        XCTAssertEqual(characters.label, localized("Character Management"))
        characters.tap()
        let card = webView.images.matching(NSPredicate(format: "label == %@", fixture.characterName)).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        waitForHittable(card)
        let observedCharacter = card.label
        card.tap()
        let greeting = try renderedChatText("Synthetic chat fixture ready.")
        if !exactChatText(greeting).isHittable {
            waitForHittable(characters)
            characters.tap()
        }
        attachEvidence("chat-02-character-selected")

        let connections = webControl("API-status-top", label: "API Connections", type: .button)
        waitForHittable(connections)
        XCTAssertEqual(connections.label, localized("API Connections"))
        connections.tap()
        let connect = webControl("api_button_openai", label: "Connect", type: .button)
        reachConnectButton(connect)
        XCTAssertEqual(connect.label, localized("Connect"))
        connect.tap()
        attachEvidence("chat-03-api-connected")
        waitForHittable(connections)
        connections.tap()

        let observedFirstPrompt = try sendChatPrompt(fixture.firstPrompt)
        let stop = webControl("mes_stop", label: "Abort request", type: .button)
        let prefix = fixture.firstPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
        let expectedStopLabel = localized("Abort request")
        let firstStream = webView.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
        var observedStreamText = ""
        var observedStopLabel = ""
        let partial = NSPredicate { _, _ in
            guard let streamSnapshot = try? firstStream.snapshot(),
                  let stopSnapshot = try? stop.snapshot() else { return false }
            let text = streamSnapshot.label
            let label = stopSnapshot.label
            guard text.hasPrefix(prefix), text != fixture.firstResponse,
                  label == expectedStopLabel, stop.isHittable else { return false }
            observedStreamText = text
            observedStopLabel = label
            return true
        }
        let partialResult = await XCTWaiter.fulfillment(of: [XCTNSPredicateExpectation(predicate: partial, object: nil)], timeout: 25, enforceOrder: false)
        XCTAssertEqual(partialResult, .completed,
                       "The real renderer must show a partial streamed reply while the correctly labeled native Stop is reachable")
        let streamObserved = partialResult == .completed && observedStreamText.hasPrefix(prefix)
            && observedStreamText != fixture.firstResponse && observedStopLabel == expectedStopLabel
        XCTAssertTrue(streamObserved)
        XCTAssertEqual(observedStopLabel, expectedStopLabel)
        attachEvidence("chat-04-streaming-partial")
        let observedFirstResponse = try renderedChatText(fixture.firstResponse, timeout: 60)
        let finished = NSPredicate { _, _ in !stop.exists || !stop.isHittable }
        let completionResult = await XCTWaiter.fulfillment(of: [XCTNSPredicateExpectation(predicate: finished, object: nil)], timeout: 20, enforceOrder: false)
        XCTAssertEqual(completionResult, .completed)
        attachEvidence("chat-05-stream-completed")

        let observedCancelPrompt = try sendChatPrompt(fixture.cancelPrompt)
        let cancelling = exactChatText(fixture.cancelPrefix)
        XCTAssertTrue(cancelling.waitForExistence(timeout: 25))
        waitForHittable(stop, timeout: 15)
        XCTAssertEqual(stop.label, localized("Abort request"))
        let observedCancelPrefix = cancelling.label
        XCTAssertEqual(observedCancelPrefix, fixture.cancelPrefix)
        let stopWasReachable = stop.exists && stop.isHittable
        attachEvidence("chat-06-before-stop")
        let stopTappedAt = Date().timeIntervalSince1970 * 1000
        stop.tap()
        let cancellationResult = await XCTWaiter.fulfillment(of: [XCTNSPredicateExpectation(predicate: finished, object: nil)], timeout: 20, enforceOrder: false)
        XCTAssertEqual(cancellationResult, .completed,
                       "A real Stop tap must end generation")
        let send = webControl("send_but", label: "Send a message", type: .button)
        waitForHittable(send, timeout: 20)
        let stopTapped = stopWasReachable && cancellationResult == .completed && send.isHittable
        XCTAssertTrue(stopTapped)
        let observedCancelResponse = try renderedChatText(observedCancelPrefix)
        XCTAssertFalse(webView.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", fixture.forbiddenSuffix)).firstMatch.exists)
        attachEvidence("chat-07-stopped-reply")

        let savedChatName = try await waitForSavedConversation(fixture, greeting: greeting,
            firstPrompt: observedFirstPrompt, firstResponse: observedFirstResponse,
            cancelPrompt: observedCancelPrompt, cancelResponse: observedCancelResponse)
        // This is a complete process termination after an actual backend read
        // confirmed the JSONL messages and debounced active-character setting.
        // No page reload, localStorage injection, or chat save call is used.
        let beforeColdRelaunchAt = Date().timeIntervalSince1970 * 1000
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 15))
        XCTAssertLessThan(stopTappedAt, beforeColdRelaunchAt)
        app.launch()
        waitForState("ready", timeout: 360)
        XCTAssertFalse(webControl("onboarding-persona-name", label: "Persona name", type: .textView).exists)
        let restoredGreeting = try renderedChatText(greeting)
        let restoredFirstPrompt = try renderedChatText(observedFirstPrompt)
        let restoredFirstResponse = try renderedChatText(observedFirstResponse)
        let restoredCancelPrompt = try renderedChatText(observedCancelPrompt)
        let restoredCancelResponse = try renderedChatText(observedCancelResponse)
        let coldRelaunchRestored = restoredGreeting == greeting && restoredFirstPrompt == observedFirstPrompt
            && restoredFirstResponse == observedFirstResponse && restoredCancelPrompt == observedCancelPrompt
            && restoredCancelResponse == observedCancelResponse
        XCTAssertTrue(coldRelaunchRestored)
        XCTAssertFalse(webView.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", fixture.forbiddenSuffix)).firstMatch.exists)
        // Accessible text can exist while the startup fade or another overlay
        // still covers the restored chat. Wait for the final reply and the real
        // message input to be reachable before capturing the rendered evidence.
        let restoredLastReply = exactChatText(observedCancelResponse)
        let restoredInput = webControl("send_textarea", label: "Message", type: .textView)
        let restoredControlsReady = NSPredicate { _, _ in
            restoredLastReply.exists && restoredLastReply.isHittable
                && restoredInput.exists && restoredInput.isHittable
        }
        let restoredVisibility = await XCTWaiter.fulfillment(of: [XCTNSPredicateExpectation(predicate: restoredControlsReady, object: nil)], timeout: 20, enforceOrder: false)
        XCTAssertEqual(restoredVisibility, .completed,
                       "Cold relaunch must expose the restored last reply and message input")
        attachEvidence("chat-08-cold-relaunch-restored")
        let restoredChatName = try await waitForSavedConversation(fixture, greeting: restoredGreeting,
            firstPrompt: restoredFirstPrompt, firstResponse: restoredFirstResponse,
            cancelPrompt: restoredCancelPrompt, cancelResponse: restoredCancelResponse)
        XCTAssertEqual(restoredChatName, savedChatName, "Cold relaunch must restore the same saved chat file")
        let observations: [String: Any] = [
            "schemaVersion": 1, "fixtureId": fixture.fixtureId, "characterName": observedCharacter,
            "firstPrompt": observedFirstPrompt, "firstResponse": observedFirstResponse,
            "firstStreamText": observedStreamText, "cancelPrompt": observedCancelPrompt,
            "cancelResponse": observedCancelResponse, "savedChatName": savedChatName,
            "streamObserved": streamObserved, "stopTapped": stopTapped,
            "stopTappedAt": stopTappedAt, "beforeColdRelaunchAt": beforeColdRelaunchAt,
            "coldRelaunchRestored": coldRelaunchRestored,
        ]
        let report = try JSONSerialization.data(withJSONObject: observations, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: report, uniformTypeIdentifier: "public.json")
        attachment.name = "chat-observations.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testOnboardingSliderKeyboardLifecycleAndPersistence() throws {
        app.launch()

        XCTContext.runActivity(named: "Complete first-run onboarding through the real WebView") { _ in
            XCTAssertTrue(webView.waitForExistence(timeout: 360))
            XCTAssertNotNil(webView.value as? String, "The native startup state must be observable without hiding WebView controls")
            waitForState("waiting-interaction", timeout: 360)
            XCTAssertFalse(app.otherElements["st-startup-overlay"].exists)
            checkProfileGeometry()
            if uiLanguage == "ko-kr" { selectKoreanOnboardingLanguage() }
            let nameInput = webControl("onboarding-persona-name", label: "Persona name", type: .textView)
            XCTAssertTrue(nameInput.waitForExistence(timeout: 15))
            dismissKeyboardIntroductionIfPresent()
            waitForHittable(nameInput)
            let confirm = webControl("onboarding-confirm", label: "Save", type: .button)
            waitForVisibleBounds([nameInput, confirm])
            attachEvidence("01-first-run-onboarding")
            let originalName = nameInput.value as? String ?? ""
            // Onboarding already focuses this field. Type through the real
            // software keyboard without assuming where WebKit placed its
            // selection/caret in the default name, then verify that exact new
            // name survives Save and a later cold launch.
            nameInput.typeText("Simulator Test")
            let enteredName = NSPredicate { _, _ in
                guard let value = nameInput.value as? String else { return false }
                return value != originalName && value.contains("Simulator Test")
            }
            let enteredNameResult = XCTWaiter.wait(
                for: [XCTNSPredicateExpectation(predicate: enteredName, object: nil)], timeout: 15)
            personaName = nameInput.value as? String ?? ""
            XCTAssertEqual(enteredNameResult, .completed,
                           "Persona input did not settle after typing; observed: \(personaName)")
            XCTAssertNotEqual(personaName, originalName)
            XCTAssertTrue(personaName.contains("Simulator Test"))
            waitForHittable(confirm)
            confirm.tap()
            waitForState("ready")
            XCTAssertFalse(app.otherElements["st-startup-overlay"].exists)
            XCTAssertFalse(nameInput.exists)
            attachEvidence("02-interface-ready")
        }

        var persistedResponse = 0.0
        XCTContext.runActivity(named: "Change a response slider by touch and verify its numeric value") { _ in
            let controls = openResponseSettings()
            let oldValue = controls.counter.value as? String
            let initial = Double(oldValue ?? "") ?? 80
            let thumbPosition = 0.04 + 0.92 * min(1, max(0, (initial - 16) / (2048 - 16)))
            controls.slider.coordinate(withNormalizedOffset: CGVector(dx: thumbPosition, dy: 0.5))
                // The upstream touch handler intentionally locks for 300 ms.
                .press(forDuration: 0.35, thenDragTo: controls.slider.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
            let changed = NSPredicate { _, _ in
                let value = controls.counter.value as? String
                guard let counter = Double(value ?? ""),
                      let slider = Double(controls.slider.value as? String ?? "") else { return false }
                return value != oldValue && (16...2048).contains(counter) && counter == slider
            }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: changed, object: nil)], timeout: 10), .completed)
            persistedResponse = Double(controls.counter.value as? String ?? "") ?? -1
            XCTAssertEqual(persistedResponse, floor(persistedResponse), "The touch must update an integer response length")
            attachEvidence("03-slider-touch")
            webControl("leftNavDrawerIcon", label: "AI Response Configuration", type: .button).tap()
            let closed = NSPredicate { _, _ in !controls.slider.exists || !controls.slider.isHittable }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: closed, object: nil)], timeout: 10), .completed)
        }

        let messageInput = webControl("send_textarea", label: "Message", type: .textView)
        let draft = uiLanguage == "ko-kr" ? "한국어 초안은 백그라운드 복귀 후에도 유지됩니다" : "Simulator draft preserved after background"
        XCTContext.runActivity(named: "Type with the software keyboard and preserve the draft on resume") { _ in
            XCTAssertTrue(messageInput.waitForExistence(timeout: 15))
            waitForHittable(messageInput)
            // Tap inside the actual field, then await the native keyboard.
            // A WebKit snapshot's generic Focused flag is not keyboard focus.
            messageInput.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            dismissKeyboardIntroductionIfPresent()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "Tapping the message field must open the software keyboard")
            waitForHittable(messageInput)
            waitForVisibleBounds([messageInput])
            messageInput.typeText(draft)
            // XCTest can return before WebKit has applied the last synthetic
            // keystrokes, even though the remaining text arrives moments later.
            let completeDraft = NSPredicate { _, _ in (messageInput.value as? String) == draft }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: completeDraft, object: nil)], timeout: 15), .completed,
                           "The software keyboard must enter the complete unsent draft")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            XCTAssertTrue(messageInput.isHittable)
            waitForVisibleBounds([messageInput])
            attachEvidence("04-keyboard-draft")
            XCUIDevice.shared.press(.home)
            let background = NSPredicate { [weak self] _, _ in
                guard let state = self?.app.state else { return false }
                return state == .runningBackground || state == .runningBackgroundSuspended
            }
            let backgroundResult = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: background, object: nil)], timeout: 10)
            var homeFailureDetails = ""
            if backgroundResult != .completed {
                // Preserve the actual OS/app state and screen when Home does not
                // produce the expected background transition. In particular,
                // .notRunning would indicate a terminated app, not a slow test.
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                homeFailureDetails = "app.state=\(app.state), SpringBoard.state=\(springboard.state)"
                let state = XCTAttachment(string: "After Home: \(homeFailureDetails)")
                state.name = "home-background-state"
                state.lifetime = .keepAlways
                add(state)
                let screen = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                screen.name = "home-background-screen"
                screen.lifetime = .keepAlways
                add(screen)
            }
            XCTAssertEqual(backgroundResult, .completed,
                           "Home must leave the still-running app in the background before resuming its unsent draft. \(homeFailureDetails)")
            app.activate()
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
            waitForState("ready", timeout: 30)
            XCTAssertEqual(messageInput.value as? String, draft, "Foregrounding must keep the existing page and unsent draft")
            waitForVisibleBounds([messageInput])
            attachEvidence("05-background-resume")
        }

        XCTContext.runActivity(named: "Keep the input reachable after landscape rotation") { _ in
            XCUIDevice.shared.orientation = .landscapeLeft
            let rotated = NSPredicate { [weak self] _, _ in
                guard let self = self else { return false }
                let frame = self.webView.frame
                return frame.width > frame.height && messageInput.isHittable
            }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: rotated, object: nil)], timeout: 15), .completed)
            XCTAssertEqual(messageInput.value as? String, draft)
            waitForVisibleBounds([messageInput])
            attachEvidence("06-landscape-keyboard")
            XCUIDevice.shared.orientation = .portrait
            let portrait = NSPredicate { [weak self] _, _ in
                guard let self = self else { return false }
                let frame = self.webView.frame
                return frame.width < frame.height && messageInput.isHittable
            }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: portrait, object: nil)], timeout: 15), .completed)
            waitForVisibleBounds([messageInput])
        }

        XCTContext.runActivity(named: "Export diagnostics twice through the native share sheet without losing the draft") { _ in
            let settings = webControl("st-ios-user-settings-toggle", label: "User Settings", type: .button)
            XCTAssertTrue(settings.waitForExistence(timeout: 15))
            waitForHittable(settings)
            settings.tap()
            let export = webControl("st-ios-export-diagnostics", label: "Export diagnostics", type: .button)
            XCTAssertTrue(export.waitForExistence(timeout: 15))
            XCTAssertEqual(export.label, localized("Export diagnostics"))
            waitForHittable(export)
            waitForVisibleBounds([export])
            XCTAssertGreaterThan(export.frame.width, export.frame.height,
                                 "English and Korean labels must fit a horizontal button")
            XCTAssertTrue(export.isEnabled)
            attachEvidence("09-diagnostics-settings")
            export.tap()
            dismissDiagnosticsShareSheet(evidence: "10-diagnostics-share-sheet")
            let enabled = NSPredicate { _, _ in export.exists && export.isEnabled && export.isHittable }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: enabled, object: nil)], timeout: 20),
                           .completed, "Native cancellation must release the web export button")
            export.tap()
            dismissDiagnosticsShareSheet(evidence: "11-diagnostics-share-repeat")
            waitForHittable(settings)
            settings.tap()
            waitForHittable(messageInput)
            XCTAssertEqual(messageInput.value as? String, draft, "Export and cancellation must preserve the unsent draft")
            attachEvidence("12-diagnostics-return")
        }

        XCTContext.runActivity(named: "Relaunch the app and retain saved settings and persona") { _ in
            // UI settings are debounced. Confirm disk persistence through a full
            // app relaunch, rather than inferring it from an in-memory value.
            let saved = expectation(description: "Allow debounced settings save to finish")
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { saved.fulfill() }
            wait(for: [saved], timeout: 5)
            app.terminate()
            app.launch()
            waitForState("ready", timeout: 360)
            XCTAssertFalse(webControl("onboarding-persona-name", label: "Persona name", type: .textView).exists, "Onboarding must not repeat after a completed first run")
            let controls = openResponseSettings()
            XCTAssertEqual(Double(controls.counter.value as? String ?? ""), persistedResponse)
            attachEvidence("07-relaunch-settings")
            webControl("leftNavDrawerIcon", label: "AI Response Configuration", type: .button).tap()
            let personaToggle = webControl("personaManagementDrawerIcon", label: "Persona Management", type: .button)
            XCTAssertTrue(personaToggle.waitForExistence(timeout: 15))
            XCTAssertEqual(personaToggle.label, localized("Persona Management"), "The selected app language must survive a cold relaunch")
            personaToggle.tap()
            let personaHeading = webView.staticTexts
                .matching(NSPredicate(format: "label == %@", localized("Persona Management"))).firstMatch
            XCTAssertTrue(personaHeading.waitForExistence(timeout: 15))
            waitForHittable(personaHeading)
            waitForVisibleBounds([personaHeading])
            XCTAssertGreaterThanOrEqual(personaHeading.frame.minY, personaToggle.frame.maxY,
                                        "The drawer heading must be below the safe-area toolbar, not under the status bar")
            // The current persona is an h5 heading. Match its heading value as
            // well as its name to distinguish it from a persona-list caption.
            let persona = webView.descendants(matching: .other)
                .matching(NSPredicate(format: "label == %@ AND (value == '5' OR value == 5)", personaName)).firstMatch
            XCTAssertTrue(persona.waitForExistence(timeout: 15))
            XCTAssertEqual(persona.label, personaName)
            attachEvidence("08-relaunch-persona")
        }
    }
}

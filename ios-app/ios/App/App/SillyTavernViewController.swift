import UIKit
import Capacitor
import WebKit

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(_ delegate: WKScriptMessageHandler) { self.delegate = delegate }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

// Keep Capacitor's navigation policies, plugin callbacks, and bridge resets.
private final class StartupNavigationDelegate: NSObject, WKNavigationDelegate {
    weak var owner: SillyTavernViewController?
    weak var capacitorDelegate: WKNavigationDelegate?

    init(owner: SillyTavernViewController, forwardingTo delegate: WKNavigationDelegate?) {
        self.owner = owner
        capacitorDelegate = delegate
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || capacitorDelegate?.responds(to: selector) == true
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        if capacitorDelegate?.responds(to: selector) == true { return capacitorDelegate }
        return super.forwardingTarget(for: selector)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        capacitorDelegate?.webView?(webView, didStartProvisionalNavigation: navigation)
        owner?.frontendNavigationStarted()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        capacitorDelegate?.webView?(webView, didFinish: navigation)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        capacitorDelegate?.webView?(webView, didFail: navigation, withError: error)
        owner?.frontendNavigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        capacitorDelegate?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        owner?.frontendNavigationFailed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Capacitor normally reloads immediately. Check the local server first;
        // the forwarded didStart callback resets the bridge when we reload.
        owner?.frontendProcessTerminated()
    }
}

class SillyTavernViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private enum StartupState: String {
        case waitingServer = "waiting-server"
        case waitingFrontend = "waiting-frontend"
        case waitingInteraction = "waiting-interaction"
        case ready, failed
    }
    private struct HealthResponse: Decodable {
        let ready: Bool
        let version: String?
        let deploymentId: String?
        let error: String?
    }

    private var state: StartupState = .waitingServer {
        didSet { webView?.accessibilityValue = state.rawValue }
    }
    private var expectedManifest: RuntimeManifest?
    private var navigationProxy: StartupNavigationDelegate?
    private var loadingOverlay: UIView?
    private var statusLabel: UILabel?
    private var errorLabel: UILabel?
    private var spinnerView: UIActivityIndicatorView?
    private var retryButton: UIButton?
    private var diagnosticsButton: UIButton?
    private var diagnosticsUsesKorean = Locale.preferredLanguages.first?.hasPrefix("ko") == true
    private var diagnosticsExportInProgress = false
    private var diagnosticsArtifact: DiagnosticsExport.Artifact?
    private let diagnosticsQueue = DispatchQueue(label: "com.sillytavern.ios.diagnostics", qos: .utility)
    private var timer: Timer?
    private var healthTask: URLSessionDataTask?
    private var requestGeneration = 0
    private var activeElapsed: TimeInterval = 0
    private var lastTick: TimeInterval?
    private var isForeground = true
    private var reuseExistingPage = false
    private var lastServerIssue = "The local server has not responded."
    private let serverTimeout: TimeInterval = 360
    private let frontendTimeout: TimeInterval = 120
    private let serverURL = URL(string: "http://localhost:8000/")!
    private let healthURL = URL(string: "http://localhost:8000/api/ios/health")!
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 3
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    override func instanceDescriptor() -> InstanceDescriptor {
        (UIApplication.shared.delegate as? AppDelegate)?.prepareRuntimeIfNeeded()
        return super.instanceDescriptor()
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        expectedManifest = (UIApplication.shared.delegate as? AppDelegate)?.runtimeManifest
        guard let webView = webView, let manifest = expectedManifest else { return }
        // Expose the real startup state without grouping away the web controls.
        // Onboarding and APP_READY remain distinct accessibility values.
        webView.accessibilityIdentifier = "st-webview"
        webView.accessibilityValue = state.rawValue
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false

        let contentController = webView.configuration.userContentController
        let handler = WeakScriptMessageHandler(self)
        contentController.add(handler, name: "stReady")
        contentController.add(handler, name: "stError")
        contentController.add(handler, name: "stInteraction")
        contentController.add(handler, name: "stDiagnostics")
        let marker: [String: String] = ["deploymentId": manifest.deploymentId, "version": manifest.applicationVersion]
        guard let markerData = try? JSONSerialization.data(withJSONObject: marker),
              let markerJSON = String(data: markerData, encoding: .utf8) else { return }
        let script = """
            (() => {
                if (location.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(location.hostname) || location.port !== '8000') return;
                Object.defineProperty(window, '__ST_IOS_APP__', { value: Object.freeze(\(markerJSON)) });
                window.__ST_IOS_READY__ = false;
                window.__ST_IOS_INTERACTION__ = false;
                const report = (message) => {
                    if (!window.__ST_IOS_READY__) window.webkit.messageHandlers.stError.postMessage({ message: String(message).slice(0, 400) });
                };
                window.addEventListener('error', (event) => {
                    if (event.message) report(event.message);
                    else if (event.target instanceof HTMLScriptElement) {
                        const path = new URL(event.target.src, location.href).pathname;
                        report('Could not load script: ' + path);
                    }
                }, true);
                window.addEventListener('unhandledrejection', (event) => {
                    report(event.reason instanceof Error ? event.reason.message : 'An initialization promise failed.');
                });
            })();
            """
        contentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let diagnosticsScript = """
            (() => {
                if (location.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(location.hostname) || location.port !== '8000') return;
                const marker = window.__ST_IOS_APP__;
                if (!marker || typeof marker.deploymentId !== 'string' || typeof marker.version !== 'string') return;
                const row = document.querySelector('#user-settings-block [name="UserSettingsRowTwo"]');
                const icon = document.querySelector('#user-settings-button .drawer-icon');
                if (!row || document.getElementById('st-ios-export-diagnostics')) return;
                const holder = document.createElement('div');
                holder.className = 'flex-container';
                holder.style.width = '100%';
                const button = document.createElement('button');
                button.type = 'button';
                button.id = 'st-ios-export-diagnostics';
                button.className = 'menu_button';
                button.style.minHeight = '44px';
                button.style.font = 'inherit';
                // The upstream menu class uses min-content, which reduces a
                // Korean label to a single-character vertical column.
                button.style.width = 'max-content';
                button.style.maxWidth = '100%';
                button.style.flexShrink = '0';
                holder.appendChild(button);
                row.parentNode.insertBefore(holder, row.nextSibling);
                const language = () => String(document.documentElement.lang || 'en').toLowerCase().startsWith('ko') ? 'ko' : 'en';
                const send = (action) => window.webkit.messageHandlers.stDiagnostics.postMessage({ action, language: language(), deploymentId: marker.deploymentId, version: marker.version });
                const updateLabels = () => {
                    const label = language() === 'ko' ? '진단 로그 내보내기' : 'Export diagnostics';
                    button.textContent = label;
                    button.setAttribute('aria-label', label);
                    send('language');
                };
                button.addEventListener('click', (event) => {
                    if (!event.isTrusted || button.disabled) return;
                    button.disabled = true;
                    send('export');
                });
                window.__ST_IOS_DIAGNOSTICS_FINISHED__ = () => { button.disabled = false; };
                new MutationObserver(updateLabels).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
                if (icon) {
                    icon.id = 'st-ios-user-settings-toggle';
                    icon.setAttribute('role', 'button');
                    const updateIcon = () => icon.setAttribute('aria-label', icon.getAttribute('title') || (language() === 'ko' ? '사용자 설정' : 'User Settings'));
                    new MutationObserver(updateIcon).observe(icon, { attributes: true, attributeFilter: ['title'] });
                    updateIcon();
                }
                updateLabels();
            })();
            """
        contentController.addUserScript(WKUserScript(source: diagnosticsScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let proxy = StartupNavigationDelegate(owner: self, forwardingTo: webView.navigationDelegate)
        navigationProxy = proxy
        webView.navigationDelegate = proxy
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Capacitor starts its configured URL here; readiness controls our load.
        webView?.stopLoading()
        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        isForeground = UIApplication.shared.applicationState != .background
        DiagnosticsExport.removeAbandoned()
        showLoadingOverlay()
        if let error = (UIApplication.shared.delegate as? AppDelegate)?.runtimePreparationError {
            fail("The app runtime could not be installed.\n\(error)", canRetry: false)
        } else if expectedManifest == nil {
            fail("The runtime manifest is unavailable. Rebuild or reinstall the app.", canRetry: false)
        } else {
            beginStartup(reusePage: false)
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        timer?.invalidate()
        healthTask?.cancel()
        session.invalidateAndCancel()
        if let artifact = diagnosticsArtifact { try? DiagnosticsExport.remove(artifact) }
    }

    private func isLocalURL(_ url: URL?) -> Bool {
        guard let url = url else { return false }
        return url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "") && url.port == 8000
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, isLocalURL(message.frameInfo.request.url),
              let body = message.body as? [String: Any] else { return }
        guard let manifest = expectedManifest else { return }
        let currentDeployment = body["deploymentId"] as? String == manifest.deploymentId
            && body["version"] as? String == manifest.applicationVersion
        if message.name == "stDiagnostics", currentDeployment {
            diagnosticsUsesKorean = body["language"] as? String == "ko"
            updateDiagnosticsButtonLabel()
            if body["action"] as? String == "export", state == .ready {
                exportDiagnostics(source: nil)
            } else if body["action"] as? String == "export" {
                finishDiagnosticsExport()
            }
        } else if message.name == "stReady", currentDeployment,
           state == .waitingFrontend || state == .waitingInteraction {
            finishStartup()
        } else if message.name == "stInteraction", currentDeployment,
                  let active = body["active"] as? Bool {
            setInteractionActive(active)
        } else if message.name == "stError", state == .waitingFrontend || state == .waitingInteraction {
            let detail = String((body["message"] as? String ?? "Unknown initialization error.").prefix(400))
            fail("The interface failed to initialize.\n\(detail)")
        }
    }

    private func beginStartup(reusePage: Bool) {
        cancelHealthRequest()
        state = .waitingServer
        activeElapsed = 0
        lastTick = nil
        reuseExistingPage = reusePage
        showLoadingOverlay()
        if isForeground {
            startTimer()
            pollHealth()
        }
    }

    private func startTimer() {
        timer?.invalidate()
        lastTick = ProcessInfo.processInfo.systemUptime
        let nextTimer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        timer = nextTimer
        RunLoop.main.add(nextTimer, forMode: .common)
    }

    private func tick() {
        guard isForeground, state == .waitingServer || state == .waitingFrontend else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let last = lastTick { activeElapsed += now - last }
        lastTick = now
        let elapsed = Int(activeElapsed)
        if state == .waitingServer {
            statusLabel?.text = "Starting local server… (\(elapsed)s)\nFirst launch can take several minutes."
            if activeElapsed >= serverTimeout {
                fail("The local server did not become ready within \(Int(serverTimeout)) seconds in the foreground.\n\(lastServerIssue)")
            } else {
                pollHealth()
            }
        } else {
            statusLabel?.text = "Loading interface… (\(elapsed)s)"
            if activeElapsed >= frontendTimeout {
                fail("The server is ready, but the interface did not finish initializing within \(Int(frontendTimeout)) seconds in the foreground.")
            }
        }
    }

    private func cancelHealthRequest() {
        requestGeneration += 1
        healthTask?.cancel()
        healthTask = nil
    }

    private func pollHealth() {
        guard isForeground, healthTask == nil,
              state == .waitingServer || state == .waitingInteraction || state == .ready else { return }
        let generation = requestGeneration
        let request = URLRequest(url: healthURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        let task = session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.requestGeneration == generation, self.isForeground else { return }
                self.healthTask = nil
                guard let http = response as? HTTPURLResponse else {
                    self.serverNotReady(error?.localizedDescription ?? "No HTTP response from the local server.")
                    return
                }
                guard self.isLocalURL(http.url), http.url?.path == self.healthURL.path else {
                    self.fail("The local health request was redirected to an unexpected address.")
                    return
                }
                if let data = data, let failure = try? JSONDecoder().decode(HealthResponse.self, from: data),
                   !failure.ready, let detail = failure.error, !detail.isEmpty {
                    self.fail("The local server reported a startup failure.\n\(String(detail.prefix(300)))")
                    return
                }
                guard http.statusCode == 200 else {
                    if http.statusCode >= 500 {
                        self.serverNotReady("Health check returned HTTP \(http.statusCode).")
                    } else {
                        self.fail("Local health check returned HTTP \(http.statusCode). The installed backend may be incompatible.")
                    }
                    return
                }
                guard let data = data, let health = try? JSONDecoder().decode(HealthResponse.self, from: data),
                      let manifest = self.expectedManifest else {
                    self.fail("The local health endpoint returned an invalid response.")
                    return
                }
                guard health.version == manifest.applicationVersion, health.deploymentId == manifest.deploymentId else {
                    self.fail("The running backend does not match the installed app runtime. Fully close and reopen the app.")
                    return
                }
                guard health.ready else {
                    self.serverNotReady("The backend is still initializing.")
                    return
                }
                if self.state == .ready {
                    self.resumeReadyPage()
                } else if self.state == .waitingInteraction {
                    self.resumeInteractionPage()
                } else if self.state == .waitingServer {
                    self.serverBecameReady()
                }
            }
        }
        healthTask = task
        task.resume()
    }

    private func serverNotReady(_ detail: String) {
        lastServerIssue = String(detail.prefix(300))
        if state == .ready || state == .waitingInteraction {
            // Keep an existing chat and draft if the page is still usable.
            beginStartup(reusePage: true)
        }
    }

    private var pageReadinessExpression: String {
        let deploymentId = expectedManifest?.deploymentId ?? ""
        return "window.__ST_IOS_READY__ === true && window.__ST_IOS_APP__?.deploymentId === '\(deploymentId)'"
    }

    private var pageStatusExpression: String {
        let deploymentId = expectedManifest?.deploymentId ?? ""
        return """
            (() => {
                const current = window.__ST_IOS_APP__?.deploymentId === '\(deploymentId)';
                return {
                    ready: current && window.__ST_IOS_READY__ === true,
                    interaction: current && window.__ST_IOS_INTERACTION__ === true,
                    loaded: current && typeof window.__ST_IOS_RESUME__ === 'function'
                };
            })()
            """
    }

    private func setInteractionActive(_ active: Bool) {
        if active, state == .waitingFrontend {
            if let last = lastTick { activeElapsed += ProcessInfo.processInfo.systemUptime - last }
            lastTick = nil
            timer?.invalidate()
            timer = nil
            state = .waitingInteraction
            loadingOverlay?.removeFromSuperview()
            loadingOverlay = nil
        } else if !active, state == .waitingInteraction {
            state = .waitingFrontend
            showLoadingOverlay()
            statusLabel?.text = "Finishing interface initialization…"
            if isForeground { startTimer() }
        }
    }

    private func resumeInteractionPage() {
        guard let webView = webView else { return }
        let generation = requestGeneration
        webView.evaluateJavaScript(pageStatusExpression) { [weak self, weak webView] result, _ in
            guard let self = self, let webView = webView, self.isForeground,
                  self.requestGeneration == generation, self.state == .waitingInteraction else { return }
            guard self.isLocalURL(webView.url), let status = result as? [String: Any] else {
                self.beginStartup(reusePage: false)
                return
            }
            if status["ready"] as? Bool == true {
                self.finishStartup()
            } else if status["interaction"] as? Bool == true {
                webView.evaluateJavaScript("window.__ST_IOS_RESUME__?.();", completionHandler: nil)
            } else if status["loaded"] as? Bool == true {
                // The user may have just closed onboarding while its final
                // native message is still queued. Keep the existing page.
                self.setInteractionActive(false)
            } else {
                self.beginStartup(reusePage: false)
            }
        }
    }

    private func resumeReadyPage() {
        guard let webView = webView else { return }
        let generation = requestGeneration
        webView.evaluateJavaScript(pageReadinessExpression) { [weak self, weak webView] result, _ in
            guard let self = self, let webView = webView, self.isForeground,
                  self.requestGeneration == generation, self.state == .ready else { return }
            if result as? Bool == true, self.isLocalURL(webView.url) {
                webView.evaluateJavaScript("window.__ST_IOS_RESUME__?.();", completionHandler: nil)
            } else {
                self.beginStartup(reusePage: false)
            }
        }
    }

    private func serverBecameReady() {
        state = .waitingFrontend
        activeElapsed = 0
        lastTick = ProcessInfo.processInfo.systemUptime
        statusLabel?.text = "Loading interface…"
        if reuseExistingPage, let webView = webView {
            let generation = requestGeneration
            webView.evaluateJavaScript(pageStatusExpression) { [weak self, weak webView] result, _ in
                guard let self = self, let webView = webView,
                      self.requestGeneration == generation, self.state == .waitingFrontend else { return }
                guard self.isLocalURL(webView.url), let status = result as? [String: Any] else {
                    self.loadFrontend()
                    return
                }
                if status["ready"] as? Bool == true {
                    webView.evaluateJavaScript("window.__ST_IOS_RESUME__?.();", completionHandler: nil)
                    self.finishStartup()
                } else if status["interaction"] as? Bool == true {
                    self.setInteractionActive(true)
                } else if status["loaded"] as? Bool == true {
                    webView.evaluateJavaScript("window.__ST_IOS_RESUME__?.();", completionHandler: nil)
                } else {
                    self.loadFrontend()
                }
            }
        } else {
            loadFrontend()
        }
    }

    private func loadFrontend() {
        guard let webView = webView else {
            fail("The app WebView is unavailable.", canRetry: false)
            return
        }
        webView.load(URLRequest(url: serverURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }

    fileprivate func frontendNavigationStarted() {
        if state == .ready || state == .waitingInteraction {
            state = .waitingFrontend
            activeElapsed = 0
            showLoadingOverlay()
            if isForeground { startTimer() }
        }
    }

    fileprivate func frontendNavigationFailed(_ error: Error) {
        let nsError = error as NSError
        guard nsError.code != NSURLErrorCancelled,
              state == .waitingFrontend || state == .waitingInteraction || state == .ready else { return }
        fail("The interface could not be loaded.\n\(error.localizedDescription)")
    }

    fileprivate func frontendProcessTerminated() {
        NSLog("[ST-Swift] Web content process terminated; checking backend before reload")
        beginStartup(reusePage: false)
    }

    @objc private func didEnterBackground() {
        isForeground = false
        if let last = lastTick, state == .waitingServer || state == .waitingFrontend {
            activeElapsed += ProcessInfo.processInfo.systemUptime - last
        }
        lastTick = nil
        timer?.invalidate()
        timer = nil
        // A pending page-readiness evaluation can complete while suspended.
        // Only invalidate request callbacks when there is a request to cancel.
        if healthTask != nil { cancelHealthRequest() }
    }

    @objc private func didBecomeActive() {
        isForeground = true
        if state == .waitingServer || state == .waitingFrontend {
            startTimer()
            if state == .waitingServer { pollHealth() }
        } else if state == .ready || state == .waitingInteraction {
            pollHealth()
        }
    }

    @objc private func retryStartup() {
        webView?.stopLoading()
        beginStartup(reusePage: false)
    }

    private func updateDiagnosticsButtonLabel() {
        diagnosticsButton?.setTitle(diagnosticsUsesKorean ? "진단 로그 내보내기" : "Export diagnostics", for: .normal)
    }

    @objc private func exportStartupDiagnostics(_ sender: UIButton) {
        exportDiagnostics(source: sender)
    }

    private func exportDiagnostics(source: UIView?) {
        guard !diagnosticsExportInProgress, presentedViewController == nil, isForeground else {
            if !diagnosticsExportInProgress { finishDiagnosticsExport() }
            return
        }
        diagnosticsExportInProgress = true
        diagnosticsButton?.isEnabled = false
        let context = DiagnosticsExport.Context(
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
            runtimeVersion: expectedManifest?.applicationVersion,
            deploymentId: expectedManifest?.deploymentId,
            startupState: state.rawValue,
            osVersion: UIDevice.current.systemVersion,
            deviceFamily: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone",
            webViewAvailable: webView != nil,
            foreground: isForeground
        )
        // Read only the bootstrap log allowlist, never Documents/config/chats.
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let logs = support.appendingPathComponent("logs", isDirectory: true)
        diagnosticsQueue.async { [weak self, weak source] in
            let result = Result { try DiagnosticsExport.create(context: context, logsDirectory: logs) }
            DispatchQueue.main.async {
                guard let self = self else {
                    if case .success(let artifact) = result { try? DiagnosticsExport.remove(artifact) }
                    return
                }
                switch result {
                case .success(let artifact):
                    guard self.isForeground, self.presentedViewController == nil, self.view.window != nil else {
                        try? DiagnosticsExport.remove(artifact)
                        self.finishDiagnosticsExport()
                        return
                    }
                    self.diagnosticsArtifact = artifact
                    let share = UIActivityViewController(activityItems: [artifact.fileURL], applicationActivities: nil)
                    share.view.accessibilityIdentifier = "st-diagnostics-share-sheet"
                    if let popover = share.popoverPresentationController {
                        let anchor = source?.window != nil ? source! : self.view!
                        popover.sourceView = anchor
                        popover.sourceRect = source?.window != nil ? anchor.bounds : CGRect(x: anchor.bounds.midX, y: anchor.bounds.midY, width: 1, height: 1)
                        popover.permittedArrowDirections = source?.window != nil ? [.up, .down] : []
                    }
                    share.completionWithItemsHandler = { [weak self] _, _, _, _ in
                        // Completion runs after either sharing or cancelling.
                        try? DiagnosticsExport.remove(artifact)
                        DispatchQueue.main.async {
                            self?.diagnosticsArtifact = nil
                            self?.finishDiagnosticsExport()
                        }
                    }
                    self.present(share, animated: true)
                case .failure:
                    self.finishDiagnosticsExport()
                    let alert = UIAlertController(title: self.diagnosticsUsesKorean ? "진단 파일을 만들 수 없습니다" : "Could not create diagnostic file", message: self.diagnosticsUsesKorean ? "잠시 후 다시 시도해 주세요." : "Please try again in a moment.", preferredStyle: .alert)
                    alert.addAction(UIAlertAction(title: self.diagnosticsUsesKorean ? "확인" : "OK", style: .default))
                    if self.isForeground, self.presentedViewController == nil { self.present(alert, animated: true) }
                }
            }
        }
    }

    private func finishDiagnosticsExport() {
        diagnosticsExportInProgress = false
        diagnosticsButton?.isEnabled = true
        if isLocalURL(webView?.url) {
            webView?.evaluateJavaScript("window.__ST_IOS_DIAGNOSTICS_FINISHED__?.();", completionHandler: nil)
        }
    }

    private func finishStartup() {
        state = .ready
        timer?.invalidate()
        timer = nil
        lastTick = nil
        cancelHealthRequest()
        loadingOverlay?.removeFromSuperview()
        loadingOverlay = nil
        NSLog("[ST-Swift] Backend and APP_READY match the installed deployment")
    }

    private func fail(_ message: String, canRetry: Bool = true) {
        state = .failed
        timer?.invalidate()
        timer = nil
        lastTick = nil
        cancelHealthRequest()
        showLoadingOverlay()
        spinnerView?.stopAnimating()
        statusLabel?.text = "SillyTavern could not start"
        errorLabel?.text = message + (canRetry ? "\n\nRetry checks the current server and reloads the interface. If the local engine has exited, fully close and reopen the app." : "")
        errorLabel?.isHidden = false
        retryButton?.isHidden = !canRetry
        diagnosticsButton?.isHidden = false
        NSLog("[ST-Swift] Startup failed; the error is displayed on screen")
    }

    private func showLoadingOverlay() {
        if loadingOverlay == nil {
            let overlay = UIView(frame: view.bounds)
            overlay.accessibilityIdentifier = "st-startup-overlay"
            overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            overlay.backgroundColor = UIColor(red: 0.1, green: 0.1, blue: 0.12, alpha: 1)
            let scroll = UIScrollView()
            scroll.translatesAutoresizingMaskIntoConstraints = false
            overlay.addSubview(scroll)
            let content = UIView()
            content.translatesAutoresizingMaskIntoConstraints = false
            scroll.addSubview(content)
            let stack = UIStackView()
            stack.axis = .vertical
            stack.alignment = .center
            stack.spacing = 16
            stack.translatesAutoresizingMaskIntoConstraints = false
            let title = UILabel()
            title.text = "SillyTavern"
            title.font = .systemFont(ofSize: 28, weight: .bold)
            title.textColor = .white
            let spinner = UIActivityIndicatorView(style: .large)
            spinner.color = UIColor(red: 0.6, green: 0.4, blue: 0.9, alpha: 1)
            let status = UILabel()
            status.accessibilityIdentifier = "st-startup-status"
            status.font = .systemFont(ofSize: 15)
            status.textColor = .lightGray
            status.textAlignment = .center
            status.numberOfLines = 0
            let error = UILabel()
            error.accessibilityIdentifier = "st-startup-error"
            error.font = .systemFont(ofSize: 13)
            error.textColor = UIColor(red: 1, green: 0.5, blue: 0.5, alpha: 1)
            error.textAlignment = .center
            error.numberOfLines = 0
            let retry = UIButton(type: .system)
            retry.accessibilityIdentifier = "st-startup-retry"
            retry.setTitle("Retry", for: .normal)
            retry.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
            retry.addTarget(self, action: #selector(retryStartup), for: .touchUpInside)
            let diagnostics = UIButton(type: .system)
            diagnostics.accessibilityIdentifier = "st-startup-export-diagnostics"
            diagnostics.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
            diagnostics.addTarget(self, action: #selector(exportStartupDiagnostics(_:)), for: .touchUpInside)
            let elements: [UIView] = [title, spinner, status, error, retry, diagnostics]
            for element in elements { stack.addArrangedSubview(element) }
            content.addSubview(stack)
            let preferredHeight = content.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor)
            preferredHeight.priority = .defaultLow
            NSLayoutConstraint.activate([
                scroll.topAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.topAnchor),
                scroll.bottomAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.bottomAnchor),
                scroll.leadingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.leadingAnchor),
                scroll.trailingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.trailingAnchor),
                content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
                content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
                content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
                content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
                content.heightAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.heightAnchor),
                preferredHeight,
                stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
                stack.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 28),
                stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -28),
                stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
                stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28)
            ])
            view.addSubview(overlay)
            loadingOverlay = overlay
            statusLabel = status
            errorLabel = error
            spinnerView = spinner
            retryButton = retry
            diagnosticsButton = diagnostics
            updateDiagnosticsButtonLabel()
        }
        statusLabel?.text = "Starting local server…"
        errorLabel?.isHidden = true
        retryButton?.isHidden = true
        diagnosticsButton?.isHidden = true
        spinnerView?.startAnimating()
    }
}

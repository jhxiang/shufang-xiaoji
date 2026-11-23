//
//  WebAppView.swift
//  WKWebView 容器 + JS Bridge
//
//  暴露给 Web 端的原生能力（window.webkit.messageHandlers.shufangBridge）：
//   - fetchUrl       : 用 URLSession 代理网络请求，绕开 WebView 跨域限制
//   - shareFile      : 把 base64 文件写入临时目录并唤起系统分享面板（可存 iCloud Drive / 相册）
//   - recognizeOcr   : Apple Vision 识别读书笔记照片中的文字
//   - startDictation : SFSpeechRecognizer 中文语音听写
//   - stopDictation  : 停止听写
//   - setTheme       : 同步日间/夜间外观到原生状态栏
//   - pickPhoto      : 原生调用相机/相册
//
//  回调统一挂在 window.ShufangNative.*
//

import SwiftUI
import UIKit
import WebKit
import PhotosUI
import VisionKit

struct WebAppView: UIViewControllerRepresentable {
    @EnvironmentObject private var themeStore: ThemeStore

    func makeUIViewController(context: Context) -> WebAppViewController {
        let controller = WebAppViewController()
        controller.themeStore = themeStore
        return controller
    }

    func updateUIViewController(_ uiViewController: WebAppViewController, context: Context) {
        uiViewController.themeStore = themeStore
    }
}

final class WebAppViewController: UIViewController {

    weak var themeStore: ThemeStore?

    private var webView: WKWebView!
    private var dictation: DictationService?

    private static let appEntry = "shufang://app/index.html"

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.969, green: 0.957, blue: 0.933, alpha: 1)
        configureWebView()
        loadApp()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(persistBeforeBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(persistBeforeBackground),
            name: UIApplication.willTerminateNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// App 进入后台/终止前，申请后台任务时间并主动让 Web 端把内存数据落盘到原生快照。
    @objc private func persistBeforeBackground() {
        var bgTask: UIBackgroundTaskIdentifier = .invalid
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "ShufangFlushSnapshot") {
            if bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask)
                bgTask = .invalid
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.webView != nil else {
                if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask) }
                return
            }
            self.webView.evaluateJavaScript("window.__shufangFlush && window.__shufangFlush();") { _, _ in
                if bgTask != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTask)
                    bgTask = .invalid
                }
            }
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        let dark = themeStore?.isDark ?? (traitCollection.userInterfaceStyle == .dark)
        return dark ? .lightContent : .darkContent
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        syncSafeAreaToWeb()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        syncSafeAreaToWeb()
    }

    /// 把原生真实安全区高度同步给 CSS 变量（双保险适配灵动岛/刘海屏与底部 Home Indicator）
    private func syncSafeAreaToWeb() {
        guard webView != nil else { return }
        let top = Int(ceil(view.safeAreaInsets.top))
        let bottom = Int(ceil(view.safeAreaInsets.bottom))
        let js = """
        document.documentElement.style.setProperty('--safe-top', '\(top)px');
        document.documentElement.style.setProperty('--safe-bottom', '\(bottom)px');
        """
        runJS(js)
    }

    // MARK: - WebView Setup

    private func configureWebView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.setURLSchemeHandler(LocalSchemeHandler(), forURLScheme: LocalSchemeHandler.scheme)
        config.userContentController.addUserScript(makeViewportScript())
        config.userContentController.add(WeakScriptMessageHandler(delegate: self), name: "shufangBridge")

        // 允许 IndexedDB / localStorage 在自定义 scheme 下持久化
        config.websiteDataStore = .default()

        if #available(iOS 16.4, *) {
            config.preferences.isElementFullscreenEnabled = true
        }

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.bounces = true
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        self.webView = webView
    }

    /// 让页面适配安全区：把 iOS 安全区高度与磁盘快照注入到页面启动环境。
    private func makeViewportScript() -> WKUserScript {
        // 使用 Base64 注入磁盘快照，100% 避免简介/笔记中的特殊字符或 \u2028 导致 JS 语法错误
        var snapshotScript = "window.__shufangSnapshotB64 = null; window.__shufangSnapshot = null;"
        if let b64 = PersistentStore.shared.loadSnapshotBase64(), !b64.isEmpty {
            snapshotScript = "window.__shufangSnapshotB64 = \"\(b64)\"; window.__shufangSnapshot = null;"
        }

        let js = """
        \(snapshotScript)
        (function(){
          window.__shufangNative = true;
          document.documentElement.classList.add('native-shell');
        })();
        """
        return WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    private func loadApp() {
        guard let url = URL(string: Self.appEntry) else { return }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    // MARK: - JS Evaluation helpers

    private func runJS(_ script: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(script) { _, error in
                if let error = error {
                    NSLog("[小象阅痕] JS 执行失败: %@", error.localizedDescription)
                }
            }
        }
    }

    /// 把任意字符串安全地内联为 JS 字符串字面量（含中文、换行、引号）。
    private func jsLiteral(_ value: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
           let json = String(data: data, encoding: .utf8) {
            // json 形如 ["..."]，去掉外层方括号即得字符串字面量
            return String(json.dropFirst().dropLast())
        }
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        return "\"\(escaped)\""
    }
}

// MARK: - Message Handler

extension WebAppViewController: WKScriptMessageHandler {

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        switch type {
        case "fetchUrl":
            handleFetch(body)
        case "shareFile":
            handleShareFile(body)
        case "recognizeOcr":
            handleOcr(body)
        case "startDictation":
            handleStartDictation(body)
        case "stopDictation":
            handleStopDictation()
        case "setTheme":
            handleSetTheme(body)
        case "pickPhoto":
            presentPhotoPicker(camera: body["camera"] as? Bool ?? false, completion: nil)
        case "scanDocument":
            presentDocumentScanner()
        case "saveSnapshot":
            if let data = body["data"] as? String, !data.isEmpty {
                PersistentStore.shared.saveSnapshot(data)
            }
        case "clearSnapshot":
            PersistentStore.shared.clearSnapshot()
        default:
            NSLog("[小象阅痕] 未知的桥接消息: %@", type)
        }
    }

    // MARK: fetchUrl

    private func handleFetch(_ body: [String: Any]) {
        guard let requestId = body["requestId"] as? String,
              let urlString = body["url"] as? String,
              let url = URL(string: urlString) else { return }

        let method = (body["method"] as? String) ?? "GET"
        let headers = (body["headers"] as? [String: String]) ?? [:]
        let bodyString = (body["body"] as? String) ?? ""

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 45
        request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
        if !bodyString.isEmpty, let data = bodyString.data(using: .utf8) {
            request.httpBody = data
        }

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 60
        let session = URLSession(configuration: config)

        session.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            let http = response as? HTTPURLResponse
            let ok = (error == nil) && http != nil && (200..<400).contains(http?.statusCode ?? 0)
            let text: String
            if let data = data, !data.isEmpty {
                text = String(data: data, encoding: .utf8)
                    ?? String(data: data, encoding: .isoLatin1)
                    ?? ""
            } else {
                text = (error?.localizedDescription) ?? "网络请求失败"
            }
            let js = "window.ShufangNative && ShufangNative.onFetchResult(\(self.jsLiteral(requestId)), \(ok ? "true" : "false"), \(self.jsLiteral(text)))"
            self.runJS(js)
        }.resume()
    }

    // MARK: shareFile

    private func handleShareFile(_ body: [String: Any]) {
        guard let filename = body["filename"] as? String,
              let base64 = body["base64"] as? String,
              let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return }

        let mime = (body["mime"] as? String) ?? "application/octet-stream"
        let safeName = filename.replacingOccurrences(of: "/", with: "-")
        let tmpURL = FileManager.default.temporaryDirectory.appendingPathComponent(safeName)
        do {
            if FileManager.default.fileExists(atPath: tmpURL.path) {
                try FileManager.default.removeItem(at: tmpURL)
            }
            try data.write(to: tmpURL, options: .atomic)
        } catch {
            runJS("ShufangNative && ShufangNative.onShareResult(false)")
            return
        }

        let activity = UIActivityViewController(activityItems: [tmpURL], applicationActivities: nil)
        activity.completionWithItemsHandler = { [weak self] _, completed, _, _ in
            self?.runJS("ShufangNative && ShufangNative.onShareResult(\(completed ? "true" : "false"))")
            _ = mime
        }
        presentActivity(activity)
    }

    private func presentActivity(_ activity: UIActivityViewController) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let popover = activity.popoverPresentationController {
                popover.sourceView = self.view
                popover.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
            self.present(activity, animated: true)
        }
    }

    // MARK: OCR

    private func handleOcr(_ body: [String: Any]) {
        guard let base64 = body["imageBase64"] as? String, !base64.isEmpty else {
            runJS("ShufangNative && ShufangNative.onOcrResult('', false)")
            return
        }
        let languages = (body["languages"] as? [String]) ?? ["zh-Hans", "en-US"]
        VisionOCR.recognizeLayout(imageBase64: base64, languages: languages) { [weak self] res in
            guard let self = self else { return }
            if let res = res, !res.blocks.isEmpty,
               let jsonData = try? JSONSerialization.data(withJSONObject: [["aspectRatio": res.aspectRatio, "blocks": res.blocks]], options: []),
               let layoutJson = String(data: jsonData, encoding: .utf8) {
                let js = "ShufangNative && ShufangNative.onDocumentLayoutScanned && ShufangNative.onDocumentLayoutScanned(\(self.jsLiteral(base64)), \(self.jsLiteral(layoutJson)), 1)"
                self.runJS(js)
            } else {
                self.runJS("ShufangNative && ShufangNative.onOcrResult('', false)")
            }
        }
    }

    // MARK: Dictation

    private func handleStartDictation(_ body: [String: Any]) {
        let locale = (body["locale"] as? String) ?? "zh-CN"
        dictation?.stop(notify: false)
        let service = DictationService(onText: { [weak self] text in
            guard let self = self else { return }
            if text == "__PERMISSION_DENIED__" {
                self.runJS("ShufangNative && ShufangNative.onDictationEnd()")
                self.runJS("window.__shufangPermissionDenied && window.__shufangPermissionDenied('speech')")
                return
            }
            if text == "__MICROPHONE_DENIED__" {
                self.runJS("ShufangNative && ShufangNative.onDictationEnd()")
                self.runJS("window.__shufangPermissionDenied && window.__shufangPermissionDenied('microphone')")
                return
            }
            self.runJS("ShufangNative && ShufangNative.onDictation(\(self.jsLiteral(text)))")
        }, onEnd: { [weak self] in
            guard let self = self else { return }
            self.runJS("ShufangNative && ShufangNative.onDictationEnd()")
        })
        dictation = service
        service.start(locale: locale)
    }

    private func handleStopDictation() {
        dictation?.stop(notify: false)
        dictation = nil
        runJS("ShufangNative && ShufangNative.onDictationEnd()")
    }

    // MARK: Theme

    private func handleSetTheme(_ body: [String: Any]) {
        let dark = (body["dark"] as? Bool) ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.themeStore?.isDark = dark
            self.setNeedsStatusBarAppearanceUpdate()
            let style: UIUserInterfaceStyle = dark ? .dark : .light
            self.overrideUserInterfaceStyle = style
            self.webView.overrideUserInterfaceStyle = style
        }
    }
}

// MARK: - Navigation / UI Delegate

extension WebAppViewController: WKNavigationDelegate, WKUIDelegate {

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow); return
        }
        if url.scheme == LocalSchemeHandler.scheme {
            decisionHandler(.allow)
            return
        }
        // 外部链接交给系统浏览器
        if navigationAction.navigationType == .linkActivated {
            if let scheme = url.scheme, ["http", "https", "mailto", "tel"].contains(scheme) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 注入原生标记，让 Web 端隐藏 Safari 安装指引并同步真实安全区
        runJS("window.__shufangNativeApp = true; document.documentElement.classList.add('native-shell');")
        syncSafeAreaToWeb()
        // 兜底：若页面未能从 documentStart 脚本水合（且磁盘确有快照），再次注入恢复
        if let b64 = PersistentStore.shared.loadSnapshotBase64(), !b64.isEmpty {
            runJS("if (window.ShufangNative && !window.__shufangHydrated && typeof ShufangNative.hydrateBase64 === 'function') { ShufangNative.hydrateBase64(\"\(b64)\"); }")
        }
    }

    // 允许 JS alert / confirm（调试期友好）
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "小象阅痕", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "小象阅痕", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    // MARK: Photo picker

    private func presentPhotoPicker(camera: Bool, completion: (() -> Void)?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if camera, UIImagePickerController.isSourceTypeAvailable(.camera) {
                let picker = UIImagePickerController()
                picker.sourceType = .camera
                picker.delegate = self
                self.present(picker, animated: true, completion: completion)
                return
            }

            var config = PHPickerConfiguration(photoLibrary: .shared())
            config.filter = .images
            config.selectionLimit = 1
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            self.present(picker, animated: true, completion: completion)
        }
    }
}

// MARK: - Pickers

extension WebAppViewController: PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate {

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider,
              provider.canLoadObject(ofClass: UIImage.self) else {
            return
        }
        provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
            guard let self = self,
                  let image = object as? UIImage,
                  let data = image.jpegData(compressionQuality: 0.85) else {
                return
            }
            let base64 = data.base64EncodedString()
            DispatchQueue.main.async {
                self.runJS("ShufangNative && ShufangNative.onPhotoPicked(\(self.jsLiteral(base64)))")
            }
        }
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage,
              let data = image.jpegData(compressionQuality: 0.85) else {
            return
        }
        let base64 = data.base64EncodedString()
        runJS("ShufangNative && ShufangNative.onPhotoPicked(\(jsLiteral(base64)))")
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
    }

    // MARK: Document Scanner (扫描全能王级：自动边缘检测 + 透视拉直 + 去阴影 + 多页连续扫描)

    func presentDocumentScanner() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if VNDocumentCameraViewController.isSupported {
                let scanner = VNDocumentCameraViewController()
                scanner.delegate = self
                self.present(scanner, animated: true)
            } else {
                // 设备不支持文档扫描仪时自动降级到普通相机/相册
                self.presentPhotoPicker(camera: UIImagePickerController.isSourceTypeAvailable(.camera), completion: nil)
            }
        }
    }
}

extension WebAppViewController: VNDocumentCameraViewControllerDelegate {

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: true)
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        controller.dismiss(animated: true)
        NSLog("[小象阅痕] 文档扫描失败: %@", error.localizedDescription)
        runJS("ShufangNative && ShufangNative.onOcrResult('', false)")
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        controller.dismiss(animated: true)
        let pageCount = scan.pageCount
        guard pageCount > 0 else { return }

        // 先取首页做压缩预览图
        var pagesBase64: [String] = []
        for idx in 0..<pageCount {
            let img = scan.imageOfPage(at: idx)
            if let data = img.jpegData(compressionQuality: 0.78) {
                pagesBase64.append(data.base64EncodedString())
            }
        }
        guard let firstBase64 = pagesBase64.first else { return }

        // 逐页使用 Apple Vision 离线识别精确版面框 (x, y, w, h + text)，用于渲染无背景噪声的净版原图
        let group = DispatchGroup()
        var pageLayouts: [[String: Any]?] = Array(repeating: nil, count: pagesBase64.count)
        let lock = NSLock()

        for (idx, b64) in pagesBase64.enumerated() {
            group.enter()
            VisionOCR.recognizeLayout(imageBase64: b64, languages: ["zh-Hans", "en-US"]) { res in
                if let res = res, !res.blocks.isEmpty {
                    lock.lock()
                    pageLayouts[idx] = [
                        "aspectRatio": res.aspectRatio,
                        "blocks": res.blocks,
                    ]
                    lock.unlock()
                }
                group.leave()
            }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            let validPages = pageLayouts.compactMap { $0 }
            let layoutJson: String
            if let data = try? JSONSerialization.data(withJSONObject: validPages, options: []),
               let str = String(data: data, encoding: .utf8) {
                layoutJson = str
            } else {
                layoutJson = "[]"
            }
            let js = "ShufangNative && ShufangNative.onDocumentLayoutScanned && ShufangNative.onDocumentLayoutScanned(\(self.jsLiteral(firstBase64)), \(self.jsLiteral(layoutJson)), \(pageCount))"
            self.runJS(js)
        }
    }
}

// MARK: - Weak Script Message Handler（避免循环引用）

final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var delegate: WKScriptMessageHandler?

    init(delegate: WKScriptMessageHandler) {
        self.delegate = delegate
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

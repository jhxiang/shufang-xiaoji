//
//  LocalSchemeHandler.swift
//  把 App Bundle 内的 WebApp 目录通过 shufang://app/ 自定义协议提供给 WKWebView。
//
//  使用自定义 scheme 而不是 file:// 的原因：
//  1. file:// 下 WKWebView 对 localStorage / IndexedDB 的限制较多，而自定义 scheme 具备稳定 origin；
//  2. 自定义 scheme 天然可拦截，便于统一做安全边界，不影响外部网络请求；
//  3. 便于 Service Worker / 缓存策略可控。
//

import Foundation
import WebKit
import UniformTypeIdentifiers

final class LocalSchemeHandler: NSObject, WKURLSchemeHandler {

    static let scheme = "shufang"
    static let host = "app"

    private let resourceRoot: URL?
    private let queue = DispatchQueue(label: "com.shufang.xiaoji.scheme", qos: .userInitiated)
    private var stoppedTasks = Set<ObjectIdentifier>()

    override init() {
        if let root = Bundle.main.url(forResource: "WebApp", withExtension: nil) {
            self.resourceRoot = root
        } else {
            self.resourceRoot = Bundle.main.bundleURL
        }
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(SchemeError.badURL)
            return
        }

        var relativePath = requestURL.path
        if relativePath.isEmpty || relativePath == "/" {
            relativePath = "/index.html"
        }
        relativePath = relativePath.removingPercentEncoding ?? relativePath
        relativePath = relativePath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        // 防止路径穿越
        guard !relativePath.contains("..") else {
            urlSchemeTask.didFailWithError(SchemeError.forbidden)
            return
        }

        guard let root = resourceRoot else {
            urlSchemeTask.didFailWithError(SchemeError.missingResource)
            return
        }

        let fileURL = root.appendingPathComponent(relativePath)
        let taskId = ObjectIdentifier(urlSchemeTask)
        queue.async { [weak self] in
            guard let self = self else { return }
            if self.stoppedTasks.remove(taskId) != nil { return }

            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                // 单页应用：未知路径回落到 index.html
                let fallback = root.appendingPathComponent("index.html")
                guard let data = try? Data(contentsOf: fallback) else {
                    if self.stoppedTasks.remove(taskId) == nil {
                        urlSchemeTask.didFailWithError(SchemeError.notFound)
                    }
                    return
                }
                self.respond(urlSchemeTask, taskId: taskId, data: data, mime: "text/html", url: fileURL)
                return
            }

            guard let data = try? Data(contentsOf: fileURL) else {
                if self.stoppedTasks.remove(taskId) == nil {
                    urlSchemeTask.didFailWithError(SchemeError.notFound)
                }
                return
            }
            let mime = LocalSchemeHandler.mimeType(for: fileURL.pathExtension)
            self.respond(urlSchemeTask, taskId: taskId, data: data, mime: mime, url: fileURL)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let taskId = ObjectIdentifier(urlSchemeTask)
        queue.async { [weak self] in
            self?.stoppedTasks.insert(taskId)
        }
    }

    private func respond(_ task: WKURLSchemeTask, taskId: ObjectIdentifier, data: Data, mime: String, url: URL) {
        if stoppedTasks.remove(taskId) != nil { return }
        guard let response = HTTPURLResponse(
            url: task.request.url ?? url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "\(mime); charset=utf-8",
                "Content-Length": String(data.count),
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*",
            ]
        ) else {
            task.didFailWithError(SchemeError.notFound)
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html"
        case "css": return "text/css"
        case "js", "mjs": return "text/javascript"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "webmanifest": return "application/manifest+json"
        case "mp3": return "audio/mpeg"
        case "mp4": return "video/mp4"
        default:
            if let type = UTType(filenameExtension: ext), let mime = type.preferredMIMEType {
                return mime
            }
            return "application/octet-stream"
        }
    }

    enum SchemeError: LocalizedError {
        case badURL, forbidden, missingResource, notFound

        var errorDescription: String? {
            switch self {
            case .badURL: return "无效的本地资源地址"
            case .forbidden: return "非法路径访问"
            case .missingResource: return "找不到内置资源目录"
            case .notFound: return "资源不存在"
            }
        }
    }
}

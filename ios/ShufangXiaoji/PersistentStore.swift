//
//  PersistentStore.swift
//  原生磁盘快照存储。
//
//  为什么需要它：在 WKWebView 的自定义 URL scheme（shufang://）下，
//  WKWebsiteDataStore 对 IndexedDB / localStorage 的持久化并不可靠，
//  因此把 Web 端数据以 JSON 快照形式写入 App 沙盒 Application Support 目录，
//  启动时再注入回页面，保证数据永不丢失。
//

import Foundation

final class PersistentStore {

    static let shared = PersistentStore()

    private let fileURL: URL
    private let queue = DispatchQueue(label: "com.shufang.xiaoji.store", qos: .utility)

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("ShufangXiaoji", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent("snapshot.json")
    }

    /// 读取磁盘快照（无数据返回 nil）
    func loadSnapshot() -> String? {
        guard let data = try? Data(contentsOf: fileURL), !data.isEmpty else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// 异步写入快照（防抖由 Web 端负责）
    func saveSnapshot(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }
        queue.async { [fileURL] in
            do {
                try data.write(to: fileURL, options: .atomic)
            } catch {
                NSLog("[书房小记] 快照写入失败: %@", error.localizedDescription)
            }
        }
    }

    func clearSnapshot() {
        queue.async { [fileURL] in
            try? FileManager.default.removeItem(at: fileURL)
        }
    }
}

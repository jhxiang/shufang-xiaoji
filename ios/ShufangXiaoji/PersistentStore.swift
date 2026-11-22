//
//  PersistentStore.swift
//  原生磁盘快照存储。
//
//  为什么需要它：在 WKWebView 的自定义 URL scheme（shufang://）下，
//  WKWebsiteDataStore 对 IndexedDB / localStorage 的持久化并不可靠，
//  因此把 Web 端数据以 JSON 快照形式同步原子写入 App 沙盒 Documents 目录，
//  启动时以 Base64 注入回页面，保证数据在强杀/重启/覆盖安装后永不丢失。
//

import Foundation

final class PersistentStore {

    static let shared = PersistentStore()

    private let primaryURL: URL
    private let legacyURL: URL
    private let queue = DispatchQueue(label: "com.shufang.xiaoji.store", qos: .userInitiated)

    private init() {
        let fm = FileManager.default
        let docsBase = fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let primaryDir = docsBase.appendingPathComponent("ShufangXiaoji", isDirectory: true)
        try? fm.createDirectory(at: primaryDir, withIntermediateDirectories: true)
        self.primaryURL = primaryDir.appendingPathComponent("snapshot.json")

        let appSupBase = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let legacyDir = appSupBase.appendingPathComponent("ShufangXiaoji", isDirectory: true)
        try? fm.createDirectory(at: legacyDir, withIntermediateDirectories: true)
        self.legacyURL = legacyDir.appendingPathComponent("snapshot.json")
    }

    /// 读取磁盘快照原始字节（优先 Documents，兼容旧版 Application Support）
    private func loadSnapshotDataLocked() -> Data? {
        if let data = try? Data(contentsOf: primaryURL), !data.isEmpty {
            return data
        }
        if let data = try? Data(contentsOf: legacyURL), !data.isEmpty {
            // 自动迁移到 Documents
            try? data.write(to: primaryURL, options: .atomic)
            return data
        }
        return nil
    }

    /// 读取磁盘快照 UTF-8 字符串（无数据返回 nil）
    func loadSnapshot() -> String? {
        queue.sync {
            guard let data = loadSnapshotDataLocked() else { return nil }
            return String(data: data, encoding: .utf8)
        }
    }

    /// 以 Base64 形式读取快照，避免任何特殊字符/换行符导致 WKUserScript 解析失败
    func loadSnapshotBase64() -> String? {
        queue.sync {
            guard let data = loadSnapshotDataLocked() else { return nil }
            return data.base64EncodedString()
        }
    }

    /// 同步原子写入快照（保证强杀/重启 App 前数据已安全落盘）
    func saveSnapshot(_ json: String) {
        guard let data = json.data(using: .utf8), !data.isEmpty else { return }
        queue.sync {
            do {
                try data.write(to: primaryURL, options: .atomic)
                // 同步保留一份到 Application Support 作为双保险
                try? data.write(to: legacyURL, options: .atomic)
            } catch {
                NSLog("[小象阅痕] 快照写入失败: %@", error.localizedDescription)
            }
        }
    }

    func clearSnapshot() {
        queue.sync {
            try? FileManager.default.removeItem(at: primaryURL)
            try? FileManager.default.removeItem(at: legacyURL)
        }
    }
}

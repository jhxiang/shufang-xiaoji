//
//  ShufangXiaojiApp.swift
//  小象阅痕 · 阅读记录与洞察
//
//  SwiftUI 原生外壳：WKWebView 承载本地 Web 应用，
//  并通过 JS Bridge 提供 Vision OCR、语音听写、图片分享等原生能力。
//

import SwiftUI
import UIKit

@main
struct ShufangXiaojiApp: App {
    @StateObject private var themeStore = ThemeStore()

    var body: some Scene {
        WindowGroup {
            WebAppView()
                .environmentObject(themeStore)
                .ignoresSafeArea()
                .preferredColorScheme(themeStore.isDark ? .dark : .light)
        }
    }
}

/// 记录原生状态下希望呈现的外观，用于状态栏 & 键盘配色
final class ThemeStore: ObservableObject {
    @Published var isDark: Bool = UITraitCollection.current.userInterfaceStyle == .dark
}

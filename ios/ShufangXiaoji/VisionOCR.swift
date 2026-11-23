//
//  VisionOCR.swift
//  Apple Vision 框架文字识别与版面框定位：
//  既支持纯文本提取，也支持返回每一行文字的精确归一化版面坐标 (x, y, w, h)，
//  用于生成去除纸张背景噪声、按原书版面框精准重排的「净版电子书页图」。
//

import Foundation
import Vision
import UIKit

enum VisionOCR {

    struct LayoutResult {
        let text: String
        let width: Int
        let height: Int
        let aspectRatio: Double
        let blocks: [[String: Any]]
    }

    /// 识别图片中的文字及其精确版面坐标（左上角原点归一化 0..1，严格对齐原图真实宽高）
    static func recognizeLayout(imageBase64: String, languages: [String], completion: @escaping (LayoutResult?) -> Void) {
        guard let data = Data(base64Encoded: imageBase64, options: .ignoreUnknownCharacters),
              let rawImage = UIImage(data: data) else {
            completion(nil)
            return
        }

        // 先规范化为 .up 方向，确保原图尺寸、像素和 Vision 坐标三者 100% 严格一致
        let image = normalizedUpImage(rawImage)
        guard let cgImage = image.cgImage else {
            completion(nil)
            return
        }

        let imgW = cgImage.width
        let imgH = cgImage.height
        let aspectRatio = (imgW > 0 && imgH > 0) ? (Double(imgW) / Double(imgH)) : 0.72

        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            if #available(iOS 16.0, *) {
                request.revision = VNRecognizeTextRequestRevision3
            }
            let supported = (try? request.supportedRecognitionLanguages()) ?? []
            let wanted = languages.filter { supported.contains($0) }
            request.recognitionLanguages = wanted.isEmpty ? ["zh-Hans", "en-US"] : wanted

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
            do {
                try handler.perform([request])
                let observations = request.results ?? []

                let sorted = observations.sorted { a, b in
                    let ay = 1 - a.boundingBox.maxY
                    let by = 1 - b.boundingBox.maxY
                    if abs(ay - by) > 0.012 { return ay < by }
                    return a.boundingBox.minX < b.boundingBox.minX
                }

                var lines: [String] = []
                var blocks: [[String: Any]] = []
                var lastY: CGFloat = -1

                for obs in sorted {
                    guard let candidate = obs.topCandidates(1).first else { continue }
                    let str = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                    if str.isEmpty { continue }

                    let box = obs.boundingBox
                    // Vision 坐标左下角为原点，转换为左上角为原点的归一化坐标
                    let nx = max(0.0, min(1.0, Double(box.origin.x)))
                    let ny = max(0.0, min(1.0, Double(1.0 - box.origin.y - box.size.height)))
                    let nw = max(0.01, min(1.0 - nx, Double(box.size.width)))
                    let nh = max(0.008, min(1.0 - ny, Double(box.size.height)))

                    blocks.append([
                        "text": str,
                        "x": (nx * 10000).rounded() / 10000,
                        "y": (ny * 10000).rounded() / 10000,
                        "w": (nw * 10000).rounded() / 10000,
                        "h": (nh * 10000).rounded() / 10000,
                    ])

                    let y = 1 - box.maxY
                    if lastY >= 0 && (y - lastY) > 0.028 {
                        lines.append("")
                    }
                    lines.append(str)
                    lastY = y
                }

                let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                let res = LayoutResult(text: text, width: imgW, height: imgH, aspectRatio: aspectRatio, blocks: blocks)
                DispatchQueue.main.async {
                    completion(blocks.isEmpty ? nil : res)
                }
            } catch {
                DispatchQueue.main.async { completion(nil) }
            }
        }
    }

    /// 将任意 EXIF 方向的 UIImage 规范化为 .up，保证像素坐标与视觉坐标 1:1 严格对齐
    private static func normalizedUpImage(_ image: UIImage) -> UIImage {
        if image.imageOrientation == .up { return image }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = image.scale
        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }

    /// 兼容旧接口：只返回拼接文本
    static func recognize(imageBase64: String, languages: [String], completion: @escaping (String?) -> Void) {
        recognizeLayout(imageBase64: imageBase64, languages: languages) { res in
            guard let res = res, !res.text.isEmpty else {
                completion(nil)
                return
            }
            completion(res.text)
        }
    }

    private static func cgImageOrientation(from uiOrientation: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch uiOrientation {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}

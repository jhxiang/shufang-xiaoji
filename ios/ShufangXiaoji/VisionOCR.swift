//
//  VisionOCR.swift
//  Apple Vision 框架文字识别与版面框定位 + WPS 扫描级 4 模式文档滤镜：
//   - magic    : Apple 原生 CIDocumentEnhancer（彩色增亮：去阴影提亮白底，100% 保留身份证头像/彩色插图/批注原色）
//   - bw       : 黑白文档（CIDivideBlendMode 光照归一化 + CIToneCurve，纯白底浓黑字，适合手写笔记/黑白书页）
//   - gray     : 柔和灰度（CIPhotoEffectMono + 温和提亮）
//   - original : 扫描仪拉直裁边后的原始照片（零修改）
//

import Foundation
import Vision
import UIKit
import CoreImage

enum VisionOCR {

    struct LayoutResult {
        let text: String
        let width: Int
        let height: Int
        let aspectRatio: Double
        let rawBase64: String?
        let enhancedBase64: String?
        let filterMode: String
        let blocks: [[String: Any]]
    }

    private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    /// 应用 WPS 同款 4 档扫描滤镜
    static func applyDocumentFilter(_ rawImage: UIImage, mode: String) -> UIImage {
        let image = normalizedUpImage(rawImage)
        if mode == "original" { return image }
        guard let cgImage = image.cgImage else { return image }

        let input = CIImage(cgImage: cgImage)
        let extent = input.extent
        var current = input

        switch mode {
        case "bw":
            // 黑白文档模式（适合白纸黑字手写笔记、数学公式、纯文字书页）
            let blurRadius = max(24.0, min(90.0, Double(min(extent.width, extent.height)) * 0.04))
            let blurred = input.clampedToExtent()
                .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: blurRadius])
                .cropped(to: extent)
            // CoreImage CIDivideBlendMode = background / input
            current = blurred.applyingFilter("CIDivideBlendMode", parameters: [
                kCIInputBackgroundImageKey: input
            ]).cropped(to: extent)
            current = current.applyingFilter("CIColorControls", parameters: [
                kCIInputSaturationKey: 0.0,
                kCIInputContrastKey: 1.0,
                kCIInputBrightnessKey: 0.0,
            ]).cropped(to: extent)
            current = current.applyingFilter("CIToneCurve", parameters: [
                "inputPoint0": CIVector(x: 0.0, y: 0.0),
                "inputPoint1": CIVector(x: 0.46, y: 0.01),
                "inputPoint2": CIVector(x: 0.72, y: 0.42),
                "inputPoint3": CIVector(x: 0.91, y: 0.99),
                "inputPoint4": CIVector(x: 1.0, y: 1.0),
            ]).cropped(to: extent)
            current = current.applyingFilter("CISharpenLuminance", parameters: [
                kCIInputSharpnessKey: 0.45
            ]).cropped(to: extent)

        case "gray":
            // 柔和灰度模式：保留照片与纸张层次，不丢细节
            if let mono = CIFilter(name: "CIPhotoEffectMono") {
                mono.setValue(current, forKey: kCIInputImageKey)
                if let out = mono.outputImage?.cropped(to: extent) { current = out }
            }
            current = current.applyingFilter("CIColorControls", parameters: [
                kCIInputContrastKey: 1.15,
                kCIInputBrightnessKey: 0.04,
            ]).cropped(to: extent)

        default:
            // magic（默认：Apple 原生 CIDocumentEnhancer 彩色增亮，拍身份证/彩色书页/插图绝不糊脸、保留原色）
            if let docFilter = CIFilter(name: "CIDocumentEnhancer") {
                docFilter.setValue(current, forKey: kCIInputImageKey)
                docFilter.setValue(1.0, forKey: "inputAmount")
                if let out = docFilter.outputImage?.cropped(to: extent) {
                    current = out
                }
            } else {
                current = current.applyingFilter("CIColorControls", parameters: [
                    kCIInputContrastKey: 1.18,
                    kCIInputBrightnessKey: 0.05,
                    kCIInputSaturationKey: 1.05,
                ]).cropped(to: extent)
            }
            current = current.applyingFilter("CISharpenLuminance", parameters: [
                kCIInputSharpnessKey: 0.25
            ]).cropped(to: extent)
        }

        guard let outCG = ciContext.createCGImage(current, from: extent) else { return image }
        return UIImage(cgImage: outCG, scale: image.scale, orientation: .up)
    }

    /// 对已有扫描原图异步切换滤镜（供前端毫秒级切换 4 档滤镜）
    static func applyFilterToBase64(_ base64: String, mode: String, completion: @escaping (String?) -> Void) {
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              let rawImage = UIImage(data: data) else {
            completion(nil)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let processed = applyDocumentFilter(rawImage, mode: mode)
            let outB64 = processed.jpegData(compressionQuality: 0.86)?.base64EncodedString()
            DispatchQueue.main.async { completion(outB64) }
        }
    }

    /// 应用默认彩色增亮滤镜，并识别图片中的文字及其 1:1 精确版面坐标（左上角原点归一化 0..1）
    static func recognizeLayout(imageBase64: String, languages: [String], filterMode: String = "magic", completion: @escaping (LayoutResult?) -> Void) {
        guard let data = Data(base64Encoded: imageBase64, options: .ignoreUnknownCharacters),
              let rawImage = UIImage(data: data) else {
            completion(nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let normalizedRaw = normalizedUpImage(rawImage)
            let rawB64 = normalizedRaw.jpegData(compressionQuality: 0.82)?.base64EncodedString()
            let processed = applyDocumentFilter(normalizedRaw, mode: filterMode)
            guard let cgImage = processed.cgImage else {
                DispatchQueue.main.async { completion(nil) }
                return
            }

            let imgW = cgImage.width
            let imgH = cgImage.height
            let aspectRatio = (imgW > 0 && imgH > 0) ? (Double(imgW) / Double(imgH)) : 0.72
            let enhancedB64 = processed.jpegData(compressionQuality: 0.86)?.base64EncodedString()

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
                let res = LayoutResult(
                    text: text,
                    width: imgW,
                    height: imgH,
                    aspectRatio: aspectRatio,
                    rawBase64: rawB64,
                    enhancedBase64: enhancedB64,
                    filterMode: filterMode,
                    blocks: blocks
                )
                DispatchQueue.main.async {
                    completion(res)
                }
            } catch {
                let res = LayoutResult(
                    text: "",
                    width: imgW,
                    height: imgH,
                    aspectRatio: aspectRatio,
                    rawBase64: rawB64,
                    enhancedBase64: enhancedB64,
                    filterMode: filterMode,
                    blocks: []
                )
                DispatchQueue.main.async { completion(res) }
            }
        }
    }

    /// 兼容旧接口：只返回拼接文本
    static func recognize(imageBase64: String, languages: [String], completion: @escaping (String?) -> Void) {
        recognizeLayout(imageBase64: imageBase64, languages: languages, filterMode: "original") { res in
            guard let res = res, !res.text.isEmpty else {
                completion(nil)
                return
            }
            completion(res.text)
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
}

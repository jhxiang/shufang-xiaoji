//
//  VisionOCR.swift
//  Apple Vision 框架文字识别与版面框定位 + CoreImage「WPS 扫描级」纸质变电子文档增强引擎：
//  1. 先对扫描书页做 GPU 加速的「自适应光照去阴影 + 纸张漂白 + 文字锐化」（保留真实印刷字、插图与批注，去除黄底/暗角/阴影噪点）；
//  2. 再在电子文档图上跑 Vision OCR 提取 1:1 精确归一化版面坐标 (x, y, w, h)，
//     形成类似 WPS 双层电子文档的体验：视觉上是超清电子文档原图，点击放大后可直接点选/复制版面文字。
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
        let enhancedBase64: String?
        let blocks: [[String: Any]]
    }

    private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    /// WPS 扫描级「纸质变电子文档」增强：
    /// 局部光照归一化（原图 ÷ 大半径模糊背景）彻底消除阴影、暗角与发黄纸底，
    /// 保留真实印刷文字、插图与彩色批注，再做纸白提亮与文字锐化。
    static func enhanceToElectronicDocument(_ rawImage: UIImage) -> UIImage {
        let image = normalizedUpImage(rawImage)
        guard let cgImage = image.cgImage else { return image }

        let input = CIImage(cgImage: cgImage)
        let extent = input.extent
        let blurRadius = max(24.0, min(90.0, Double(min(extent.width, extent.height)) * 0.04))

        // 1. 估计局部纸张光照与阴影背景
        let clamped = input.clampedToExtent()
        guard let blurFilter = CIFilter(name: "CIGaussianBlur") else { return image }
        blurFilter.setValue(clamped, forKey: kCIInputImageKey)
        blurFilter.setValue(blurRadius, forKey: kCIInputRadiusKey)
        guard let blurred = blurFilter.outputImage?.cropped(to: extent) else { return image }

        // 2. 光照除法归一化（CoreImage CIDivideBlendMode 公式为 background / input，
        //    因此 background=原图, input=模糊光照背景，阴影与泛黄底色自动趋近纯白 1.0）
        guard let divideFilter = CIFilter(name: "CIDivideBlendMode") else { return image }
        divideFilter.setValue(blurred, forKey: kCIInputImageKey)
        divideFilter.setValue(input, forKey: kCIInputBackgroundImageKey)
        guard let normalized = divideFilter.outputImage?.cropped(to: extent) else { return image }

        // 3. 转为高净度灰度，彻底消除纸张偏黄/边角偏蓝底色
        var current = normalized
        if let grayFilter = CIFilter(name: "CIColorControls") {
            grayFilter.setValue(current, forKey: kCIInputImageKey)
            grayFilter.setValue(0.0, forKey: kCIInputSaturationKey)
            grayFilter.setValue(1.0, forKey: kCIInputContrastKey)
            grayFilter.setValue(0.0, forKey: kCIInputBrightnessKey)
            if let out = grayFilter.outputImage?.cropped(to: extent) {
                current = out
            }
        }

        // 4. WPS 级黑白文档色阶曲线：深色笔迹压成浓黑，纸底与阴影彻底漂白为纯白 #FFFFFF
        if let toneCurve = CIFilter(name: "CIToneCurve") {
            toneCurve.setValue(current, forKey: kCIInputImageKey)
            toneCurve.setValue(CIVector(x: 0.0, y: 0.0), forKey: "inputPoint0")
            toneCurve.setValue(CIVector(x: 0.46, y: 0.01), forKey: "inputPoint1")
            toneCurve.setValue(CIVector(x: 0.72, y: 0.42), forKey: "inputPoint2")
            toneCurve.setValue(CIVector(x: 0.91, y: 0.99), forKey: "inputPoint3")
            toneCurve.setValue(CIVector(x: 1.0, y: 1.0), forKey: "inputPoint4")
            if let out = toneCurve.outputImage?.cropped(to: extent) {
                current = out
            }
        }

        // 5. 轻度锐化笔锋，让手写与印刷字边缘更清晰
        if let sharpen = CIFilter(name: "CISharpenLuminance") {
            sharpen.setValue(current, forKey: kCIInputImageKey)
            sharpen.setValue(0.45, forKey: kCIInputSharpnessKey)
            if let out = sharpen.outputImage?.cropped(to: extent) {
                current = out
            }
        }

        guard let outCG = ciContext.createCGImage(current, from: extent) else { return image }
        return UIImage(cgImage: outCG, scale: image.scale, orientation: .up)
    }

    /// 先增强为电子文档原图，再识别图片中的文字及其 1:1 精确版面坐标（左上角原点归一化 0..1）
    static func recognizeLayout(imageBase64: String, languages: [String], enhance: Bool = true, completion: @escaping (LayoutResult?) -> Void) {
        guard let data = Data(base64Encoded: imageBase64, options: .ignoreUnknownCharacters),
              let rawImage = UIImage(data: data) else {
            completion(nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let processed = enhance ? enhanceToElectronicDocument(rawImage) : normalizedUpImage(rawImage)
            guard let cgImage = processed.cgImage else {
                DispatchQueue.main.async { completion(nil) }
                return
            }

            let imgW = cgImage.width
            let imgH = cgImage.height
            let aspectRatio = (imgW > 0 && imgH > 0) ? (Double(imgW) / Double(imgH)) : 0.72
            let enhancedB64 = processed.jpegData(compressionQuality: 0.84)?.base64EncodedString()

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
                    enhancedBase64: enhancedB64,
                    blocks: blocks
                )
                DispatchQueue.main.async {
                    completion(res)
                }
            } catch {
                // 即使 OCR 失败，也返回去阴影增白后的电子文档图
                let res = LayoutResult(
                    text: "",
                    width: imgW,
                    height: imgH,
                    aspectRatio: aspectRatio,
                    enhancedBase64: enhancedB64,
                    blocks: []
                )
                DispatchQueue.main.async { completion(res) }
            }
        }
    }

    /// 兼容旧接口：只返回拼接文本
    static func recognize(imageBase64: String, languages: [String], completion: @escaping (String?) -> Void) {
        recognizeLayout(imageBase64: imageBase64, languages: languages, enhance: false) { res in
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

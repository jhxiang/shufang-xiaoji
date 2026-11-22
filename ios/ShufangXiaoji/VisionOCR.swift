//
//  VisionOCR.swift
//  Apple Vision 框架文字识别：处理纸质读书笔记照片，输出中文/英文文字。
//

import Foundation
import Vision
import UIKit

enum VisionOCR {

    /// 识别图片中的文字，按阅读顺序拼接返回。
    static func recognize(imageBase64: String, languages: [String], completion: @escaping (String?) -> Void) {
        guard let data = Data(base64Encoded: imageBase64, options: .ignoreUnknownCharacters),
              let image = UIImage(data: data),
              let cgImage = image.cgImage else {
            completion(nil)
            return
        }

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

                // 按行纵向位置排序，尽量保持原文段落顺序
                let sorted = observations.sorted { a, b in
                    let ay = 1 - a.boundingBox.maxY
                    let by = 1 - b.boundingBox.maxY
                    if abs(ay - by) > 0.012 { return ay < by }
                    return a.boundingBox.minX < b.boundingBox.minX
                }

                var lines: [String] = []
                var lastY: CGFloat = -1
                for obs in sorted {
                    guard let candidate = obs.topCandidates(1).first else { continue }
                    let y = 1 - obs.boundingBox.maxY
                    if lastY >= 0 && (y - lastY) > 0.028 {
                        lines.append("")
                    }
                    lines.append(candidate.string)
                    lastY = y
                }

                let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                DispatchQueue.main.async {
                    completion(text.isEmpty ? nil : text)
                }
            } catch {
                DispatchQueue.main.async { completion(nil) }
            }
        }
    }
}

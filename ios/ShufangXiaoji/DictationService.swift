//
//  DictationService.swift
//  语音听写：使用 SFSpeechRecognizer + AVAudioEngine 进行中文实时转写。
//

import Foundation
import Speech
import AVFoundation

final class DictationService {

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finalText = ""
    private var hasReported = false

    private let onText: (String) -> Void
    private let onEnd: () -> Void

    init(onText: @escaping (String) -> Void, onEnd: @escaping () -> Void) {
        self.onText = onText
        self.onEnd = onEnd
    }

    /// 请求权限并启动听写；失败时回调 nil 表示不可用。
    func start(locale: String = "zh-CN") {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self = self else { return }
            guard status == .authorized else {
                DispatchQueue.main.async {
                    self.onEnd()
                    self.onText("__PERMISSION_DENIED__")
                }
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                guard granted else {
                    DispatchQueue.main.async {
                        self.onEnd()
                        self.onText("__MICROPHONE_DENIED__")
                    }
                    return
                }
                DispatchQueue.main.async { self.beginSession() }
            }
        }
    }

    private func beginSession() {
        stop(notify: false)
        finalText = ""
        hasReported = false

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer?.supportsOnDeviceRecognition == true {
                request.requiresOnDeviceRecognition = false // 允许混合，提升中文准确率
            }
            audioEngine = engine
            self.request = request

            let inputNode = engine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }

            engine.prepare()
            try engine.start()

            task = recognizer?.recognitionTask(with: request, resultHandler: { [weak self] result, error in
                guard let self = self else { return }
                if let result = result {
                    let text = result.bestTranscription.formattedString
                    if !text.isEmpty, text != self.finalText {
                        self.finalText = text
                        DispatchQueue.main.async { self.onText(text) }
                    }
                    if result.isFinal {
                        DispatchQueue.main.async { self.onEnd() }
                        self.stop(notify: false)
                    }
                }
                if error != nil {
                    DispatchQueue.main.async { self.onEnd() }
                    self.stop(notify: false)
                }
            })
        } catch {
            onEnd()
            stop(notify: false)
        }
    }

    /// 停止听写。notify 为 true 时额外回调 onEnd（避免重复触发 UI 状态）。
    func stop(notify: Bool = false) {
        if let engine = audioEngine, engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        audioEngine = nil

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        if notify {
            onEnd()
        }
    }
}

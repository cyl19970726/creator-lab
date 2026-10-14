#!/usr/bin/env swift
import Foundation
import Vision

struct Manifest: Decodable {
    let schemaVersion: String?
    struct Frame: Decodable {
        let id: String
        let actionId: String
        let actionIds: [String]?
        let time: Double
        let frame: String
    }
    struct Action: Decodable {
        let id: String
        let frameIds: [String]
    }
    let `protocol`: String?
    let frames: [Frame]
    let actions: [Action]?
}

struct CaptureProtocol: Decodable {
    struct Action: Decodable {
        let id: String
        let mode: String
    }
    let captureActions: [Action]
}

struct OCRLine: Encodable {
    let id: String
    let text: String
    let confidence: Float
    let boundingBox: [Double]
}

struct OCRFrame: Encodable {
    let frameId: String
    let actionId: String
    let actionIds: [String]?
    let time: Double
    let sourceFrame: String
    let status: String
    let lines: [OCRLine]
    let error: String?
}

struct OCROutput: Encodable {
    let schemaVersion: String
    let sourceFrameBase: String?
    let generatedAt: String
    let manifest: String
    let recognitionLanguages: [String]
    let frames: [OCRFrame]
}

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

guard let manifestRaw = argument("--manifest"), let outRaw = argument("--out") else {
    FileHandle.standardError.write(Data("Usage: swift ocr-frames.swift --manifest targeted-evidence.json --out ocr-evidence.json\n".utf8))
    exit(2)
}

let manifestURL = URL(fileURLWithPath: manifestRaw).standardizedFileURL
let outputURL = URL(fileURLWithPath: outRaw).standardizedFileURL
let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
let baseURL = manifestURL.deletingLastPathComponent()
let dedicated = manifest.schemaVersion == "ocr-input-1.0"
if dedicated {
    for frame in manifest.frames {
        guard let actionIds = frame.actionIds, !actionIds.isEmpty, actionIds.first == frame.actionId else {
            throw NSError(domain: "OCR", code: 4, userInfo: [NSLocalizedDescriptionKey: "Dedicated OCR frame actionIds are invalid"])
        }
    }
}
var requestedFrameActions: [String: String] = [:]
var requestedModesPresent = false
if !dedicated, let protocolPath = manifest.protocol {
    let protocolURL = URL(fileURLWithPath: protocolPath, relativeTo: baseURL).standardizedFileURL
    let captureProtocol = try JSONDecoder().decode(CaptureProtocol.self, from: Data(contentsOf: protocolURL))
    let textActions = captureProtocol.captureActions.filter { $0.mode == "ocr_review" || $0.mode == "ui_state_review" }
    requestedModesPresent = !textActions.isEmpty
    let manifestFrameIds = Set(manifest.frames.map(\.id))
    for action in textActions {
        let mapped = manifest.actions?.first(where: { $0.id == action.id })?.frameIds
            ?? manifest.frames.filter { $0.actionId == action.id }.map(\.id)
        if mapped.isEmpty {
            throw NSError(domain: "OCR", code: 2, userInfo: [NSLocalizedDescriptionKey: "OCR action \(action.id) has no targeted frames in manifest"])
        }
        if let missing = mapped.first(where: { !manifestFrameIds.contains($0) }) {
            throw NSError(domain: "OCR", code: 3, userInfo: [NSLocalizedDescriptionKey: "OCR action \(action.id) references missing frame \(missing)"])
        }
        for frameId in mapped { requestedFrameActions[frameId] = action.id }
    }
}
let languages = ["zh-Hans", "en-US"]
var outputs: [OCRFrame] = []
var lineNumber = 0

for frame in manifest.frames where dedicated || !requestedModesPresent || requestedFrameActions[frame.id] != nil {
    let actionId = requestedFrameActions[frame.id] ?? frame.actionId
    let imageURL = baseURL.appendingPathComponent(frame.frame)
    do {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = languages
        let handler = VNImageRequestHandler(url: imageURL, options: [:])
        try handler.perform([request])
        let observations = (request.results ?? []).sorted {
            if abs($0.boundingBox.maxY - $1.boundingBox.maxY) > 0.02 { return $0.boundingBox.maxY > $1.boundingBox.maxY }
            return $0.boundingBox.minX < $1.boundingBox.minX
        }
        let lines: [OCRLine] = observations.compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            lineNumber += 1
            let box = observation.boundingBox
            return OCRLine(
                id: String(format: "OCR-%05d", lineNumber),
                text: candidate.string,
                confidence: candidate.confidence,
                boundingBox: [Double(box.minX), Double(box.minY), Double(box.width), Double(box.height)]
            )
        }
        outputs.append(OCRFrame(frameId: frame.id, actionId: actionId, actionIds: dedicated ? frame.actionIds : nil, time: frame.time, sourceFrame: frame.frame, status: "processed", lines: lines, error: nil))
    } catch {
        outputs.append(OCRFrame(frameId: frame.id, actionId: actionId, actionIds: dedicated ? frame.actionIds : nil, time: frame.time, sourceFrame: frame.frame, status: "failed", lines: [], error: String(describing: error)))
    }
}

let formatter = ISO8601DateFormatter()
let payload = OCROutput(schemaVersion: "ocr-evidence-1.0", sourceFrameBase: dedicated ? "candidate-root" : nil, generatedAt: formatter.string(from: Date()), manifest: manifestURL.path, recognitionLanguages: languages, frames: outputs)
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
let data = try encoder.encode(payload)
try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try data.write(to: outputURL, options: .atomic)
print("output=" + outputURL.path + " frames=" + String(outputs.count) + " lines=" + String(lineNumber) + " failed=" + String(outputs.filter { $0.status == "failed" }.count))

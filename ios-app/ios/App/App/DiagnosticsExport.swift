import Foundation

// Export a new, bounded snapshot of known startup events. Never copy raw log
// lines: diagnostic console output can contain prompts, credentials or URLs.
enum DiagnosticsExport {
    static let maximumReadBytesPerLog = 32 * 1024
    static let maximumExportBytes = 128 * 1024
    static let maximumEvents = 240
    static let directoryName = "SillyTavernDiagnostics"
    static let logNames = ["startup.log.2", "startup.log.1", "startup.log"]

    struct Context {
        let appVersion: String?
        let appBuild: String?
        let runtimeVersion: String?
        let deploymentId: String?
        let startupState: String
        let osVersion: String
        let deviceFamily: String
        let webViewAvailable: Bool
        let foreground: Bool
    }

    struct Artifact {
        let fileURL: URL
        fileprivate let directoryURL: URL
        fileprivate let rootURL: URL
    }

    enum ExportError: Error {
        case invalidTemporaryRoot, tooLarge
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        guard let range = value.range(of: pattern, options: .regularExpression) else { return false }
        return range.lowerBound == value.startIndex && range.upperBound == value.endIndex
    }

    private static func safeVersion(_ value: String?) -> String {
        guard let value = value, value.utf8.count <= 48,
              matches(value, #"^\d{1,4}(?:\.\d{1,4}){0,3}(?:-[A-Za-z0-9.]{1,20})?$"#) else { return "unknown" }
        return value
    }

    private static func safeHash(_ value: String?) -> String {
        guard let value = value, matches(value, #"^[a-f0-9]{64}$"#) else { return "unknown" }
        return value
    }

    // A final scrub is defense in depth after constructing an allowlisted
    // snapshot. It is deliberately not the privacy boundary for raw messages.
    static func scrub(_ value: String) -> String {
        value
            .replacingOccurrences(of: #"\b(?:sk-|sk_)[A-Za-z0-9_-]+"#, with: "[redacted]", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)\bBearer\s+[^\s,;]+"#, with: "Bearer [redacted]", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)[\"']?\b(?:api[_-]?key|authorization|password|secret|cookie|token)[\"']?\s*[:=]\s*[^\r\n]+"#, with: "[redacted]", options: .regularExpression)
    }

    private static func capture(_ value: String, _ pattern: String) -> [String]? {
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
              match.range.length == value.utf16.count else { return nil }
        return (1..<match.numberOfRanges).compactMap { index in
            guard let range = Range(match.range(at: index), in: value) else { return nil }
            return String(value[range])
        }
    }

    static func normalizedEvent(_ line: String) -> [String: String]? {
        guard line.utf8.count <= 2048,
              let fields = capture(line, #"^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] (.*)$"#),
              fields.count == 2 else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard formatter.date(from: fields[0]) != nil else { return nil }
        let message = fields[1]
        var event = ["at": fields[0]]
        if message == "Server initialization completed" {
            event["event"] = "server-ready"
        } else if message == "Native bridge unavailable; HTTP readiness remains available" {
            event["event"] = "native-bridge-unavailable"
        } else if let start = capture(message, #"^Starting SillyTavern (\d{1,4}(?:\.\d{1,4}){1,3}); Node (v\d{1,4}(?:\.\d{1,4}){1,3}); deployment ([a-f0-9]{64})$"#), start.count == 3 {
            event["event"] = "server-starting"
            event["runtimeVersion"] = safeVersion(start[0])
            event["nodeVersion"] = safeVersion(String(start[1].dropFirst()))
            event["deploymentId"] = safeHash(start[2])
        } else if message.hasPrefix("STARTUP FAILED:") {
            // The arbitrary failure message can contain paths, API URLs or
            // provider errors. Retain only the fact that startup failed.
            event["event"] = "startup-failed"
        } else if message == "WARN: Application warn; details omitted" {
            event["event"] = "application-warning"
        } else if message == "ERROR: Application error; details omitted" {
            event["event"] = "application-error"
        } else if let failure = capture(message, #"^(WARN|ERROR): Application (warn|error) \(([A-Z0-9_]{1,40})\); details omitted$"#), failure.count == 3,
                  (failure[0] == "WARN" && failure[1] == "warn") || (failure[0] == "ERROR" && failure[1] == "error") {
            event["event"] = failure[0] == "WARN" ? "application-warning" : "application-error"
            let knownCodes = ["EADDRINUSE", "ECONNREFUSED", "ECONNRESET", "ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "EINVAL", "EPIPE"]
            if knownCodes.contains(failure[2]) { event["code"] = failure[2] }
        } else {
            return nil
        }
        return event.mapValues(scrub)
    }

    private static func isPlainDirectory(_ url: URL) -> Bool {
        guard url.isFileURL,
              let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else { return false }
        return values.isDirectory == true && values.isSymbolicLink != true
    }

    static func snapshot(context: Context, logsDirectory: URL, now: Date = Date()) -> [String: Any] {
        let states = ["waiting-server", "waiting-frontend", "waiting-interaction", "ready", "failed"]
        let metadata: [String: Any] = [
            "appVersion": safeVersion(context.appVersion),
            "appBuild": safeVersion(context.appBuild),
            "runtimeVersion": safeVersion(context.runtimeVersion),
            "deploymentId": safeHash(context.deploymentId),
            "startupState": states.contains(context.startupState) ? context.startupState : "unknown",
            "osVersion": safeVersion(context.osVersion),
            "deviceFamily": ["iPhone", "iPad", "iPod touch"].contains(context.deviceFamily) ? context.deviceFamily : "unknown",
            "webViewAvailable": context.webViewAvailable,
            "foreground": context.foreground,
        ]
        let canReadDirectory = isPlainDirectory(logsDirectory)
        var remainingEvents = maximumEvents
        var logs: [[String: Any]] = []
        for name in logNames.reversed() {
            var result: [String: Any] = ["name": name, "status": "unavailable", "events": [[String: String]]()]
            let file = logsDirectory.appendingPathComponent(name, isDirectory: false)
            guard canReadDirectory else {
                logs.append(result)
                continue
            }
            guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
                  values.isRegularFile == true, values.isSymbolicLink != true else {
                result["status"] = FileManager.default.fileExists(atPath: file.path) ? "not-regular-file" : "missing"
                logs.append(result)
                continue
            }
            do {
                let handle = try FileHandle(forReadingFrom: file)
                defer { try? handle.close() }
                let size = try handle.seekToEnd()
                let offset = size > UInt64(maximumReadBytesPerLog) ? size - UInt64(maximumReadBytesPerLog) : 0
                try handle.seek(toOffset: offset)
                let data = try handle.read(upToCount: maximumReadBytesPerLog) ?? Data()
                var text = String(decoding: data, as: UTF8.self)
                if offset > 0 {
                    // The first tail fragment may begin halfway through a
                    // UTF-8 scalar, credential, or event. Discard it entirely.
                    if let newline = text.firstIndex(of: "\n") { text = String(text[text.index(after: newline)...]) }
                    else { text = "" }
                }
                let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
                let parsed = lines.compactMap { normalizedEvent(String($0).trimmingCharacters(in: .newlines)) }
                // Assign the budget to the current log before its rotations.
                // An older rotation must not hide the latest startup failure.
                let events = Array(parsed.suffix(remainingEvents))
                remainingEvents -= events.count
                result["status"] = data.isEmpty ? "empty" : events.isEmpty ? "filtered" : "included"
                result["readBytes"] = data.count
                result["tailTruncated"] = offset > 0
                result["omittedLines"] = max(0, lines.count - events.count)
                result["events"] = events
            } catch {
                // Do not serialize localizedDescription, filesystem paths, or
                // user/provider details from an underlying read error.
                result["status"] = "read-failed"
            }
            logs.append(result)
        }
        return [
            "formatVersion": 1,
            "kind": "sillytavern-ios-startup-diagnostics",
            "createdAt": ISO8601DateFormatter().string(from: now),
            "metadata": metadata,
            "privacy": ["contents": "validated app metadata and normalized startup events", "rawLogLinesIncluded": false, "userDataRead": false],
            "limits": ["maximumReadBytesPerLog": maximumReadBytesPerLog, "maximumExportBytes": maximumExportBytes, "maximumEvents": maximumEvents],
            "logs": Array(logs.reversed()),
        ]
    }

    static func create(context: Context, logsDirectory: URL, temporaryDirectory: URL = FileManager.default.temporaryDirectory, now: Date = Date()) throws -> Artifact {
        guard isPlainDirectory(temporaryDirectory) else { throw ExportError.invalidTemporaryRoot }
        let root = temporaryDirectory.appendingPathComponent(directoryName, isDirectory: true)
        if FileManager.default.fileExists(atPath: root.path) {
            guard isPlainDirectory(root) else { throw ExportError.invalidTemporaryRoot }
        } else {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        let data = try JSONSerialization.data(withJSONObject: snapshot(context: context, logsDirectory: logsDirectory, now: now), options: [.prettyPrinted, .sortedKeys])
        guard data.count <= maximumExportBytes else { throw ExportError.tooLarge }
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let filename = "SillyTavern-diagnostics-\(formatter.string(from: now)).json"
        let file = directory.appendingPathComponent(filename)
        do {
            try data.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
        return Artifact(fileURL: file, directoryURL: directory, rootURL: root)
    }

    static func remove(_ artifact: Artifact) throws {
        // FileManager may enumerate an absolute URL with a different base URL
        // or directory-slash representation than the URL used to create it.
        // Ownership is the standardized filesystem path, not URL identity.
        guard artifact.directoryURL.deletingLastPathComponent().standardizedFileURL.path == artifact.rootURL.standardizedFileURL.path,
              artifact.rootURL.lastPathComponent == directoryName,
              UUID(uuidString: artifact.directoryURL.lastPathComponent) != nil,
              isPlainDirectory(artifact.rootURL) else { throw ExportError.invalidTemporaryRoot }
        if !FileManager.default.fileExists(atPath: artifact.directoryURL.path) { return }
        guard isPlainDirectory(artifact.directoryURL) else { throw ExportError.invalidTemporaryRoot }
        let contents = try FileManager.default.contentsOfDirectory(at: artifact.directoryURL, includingPropertiesForKeys: nil)
        guard contents.allSatisfy({ $0.standardizedFileURL.path == artifact.fileURL.standardizedFileURL.path }) else { throw ExportError.invalidTemporaryRoot }
        try FileManager.default.removeItem(at: artifact.directoryURL)
    }

    // A previous process can be killed while a share sheet is open. Only this
    // helper's UUID directories containing a single diagnostic JSON are owned.
    static func removeAbandoned(temporaryDirectory: URL = FileManager.default.temporaryDirectory) {
        let root = temporaryDirectory.appendingPathComponent(directoryName, isDirectory: true)
        guard isPlainDirectory(temporaryDirectory), isPlainDirectory(root),
              let directories = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for directory in directories.prefix(32) {
            guard UUID(uuidString: directory.lastPathComponent) != nil, isPlainDirectory(directory),
                  let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil),
                  files.count == 1, let file = files.first,
                  matches(file.lastPathComponent, #"^SillyTavern-diagnostics-\d{8}-\d{6}\.json$"#) else { continue }
            let artifact = Artifact(fileURL: file, directoryURL: directory, rootURL: root)
            try? remove(artifact)
        }
    }
}

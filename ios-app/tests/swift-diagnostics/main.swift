import Foundation

struct HarnessFailure: Error { let message: String }
func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try condition() == false { throw HarnessFailure(message: message) }
}

let manager = FileManager.default
let fixture = manager.temporaryDirectory.appendingPathComponent("st-diagnostics-helper-" + UUID().uuidString, isDirectory: true)
try manager.createDirectory(at: fixture, withIntermediateDirectories: false)
defer { try? manager.removeItem(at: fixture) }
let fixedDate = Date(timeIntervalSince1970: 1_790_697_600)
let hash = String(repeating: "a", count: 64)
let timestamp = "[2026-09-29T09:00:00.000Z] "
let readyLine = timestamp + "Server initialization completed\n"
let startLine = timestamp + "Starting SillyTavern 1.19.0; Node v18.20.4; deployment " + hash + "\n"
var results: [[String: String]] = []
var caseStage = "running"

func context(appVersion: String? = "1.19.0", build: String? = "10191", runtime: String? = "1.19.0", deployment: String? = nil,
             state: String = "ready", os: String = "26.4.1", family: String = "iPhone") -> DiagnosticsExport.Context {
    DiagnosticsExport.Context(appVersion: appVersion, appBuild: build, runtimeVersion: runtime, deploymentId: deployment ?? hash,
                              startupState: state, osVersion: os, deviceFamily: family, webViewAvailable: true, foreground: true)
}

func directory(_ name: String) throws -> URL {
    let url = fixture.appendingPathComponent(name, isDirectory: true)
    try manager.createDirectory(at: url, withIntermediateDirectories: false)
    return url
}

func json(_ value: [String: Any]) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
}

func logs(_ value: [String: Any]) -> [[String: Any]] { value["logs"] as? [[String: Any]] ?? [] }
func events(_ value: [String: Any]) -> [[String: String]] {
    logs(value).flatMap { $0["events"] as? [[String: String]] ?? [] }
}

func check(_ name: String, _ body: () throws -> Void) {
    caseStage = "running"
    do {
        try body()
        results.append(["name": name, "status": "passed"])
    } catch {
        let message: String
        if let failure = error as? HarnessFailure {
            message = failure.message
        } else if let failure = error as? DiagnosticsExport.ExportError {
            switch failure {
            case .invalidTemporaryRoot: message = "Helper rejected the temporary ownership path"
            case .tooLarge: message = "Helper rejected an oversized diagnostic snapshot"
            }
        } else {
            let underlying = error as NSError
            let domain = [NSCocoaErrorDomain, NSPOSIXErrorDomain].contains(underlying.domain) ? underlying.domain : "other"
            message = "Fixture/helper error domain=\(domain) code=\(underlying.code)"
        }
        // Keep failure diagnostics useful without logging underlying paths,
        // userInfo, localized descriptions or private fixture canaries.
        results.append(["name": name, "status": "failed", "stage": caseStage, "detail": message])
    }
}

check("known startup events become a typed snapshot") {
    let root = try directory("known-events")
    try (startLine + readyLine + timestamp + "WARN: Application warn (EADDRINUSE); details omitted\n").write(to: root.appendingPathComponent("startup.log"), atomically: true, encoding: .utf8)
    let snapshot = DiagnosticsExport.snapshot(context: context(), logsDirectory: root, now: fixedDate)
    let values = events(snapshot)
    try require(values.count == 3, "Known event count did not match")
    try require(values[0]["event"] == "server-starting" && values[0]["nodeVersion"] == "18.20.4", "Version normalization failed")
    try require(values[1]["event"] == "server-ready" && values[2]["code"] == "EADDRINUSE", "Ready/error enum failed")
    let metadata = snapshot["metadata"] as? [String: Any] ?? [:]
    try require(metadata["startupState"] as? String == "ready" && metadata["deploymentId"] as? String == hash, "Metadata did not match")
}

check("private console messages and arbitrary startup errors are not copied") {
    let root = try directory("private-canaries")
    let canaries = ["private-chat-canary", "private-prompt-canary", "sk-secret-canary", "cookie-canary", "query-secret-canary", "path-user-canary"]
    let text = timestamp + "INFO: private-chat-canary private-prompt-canary\n"
        + timestamp + "STARTUP FAILED: {\"api_key\":\"sk-secret-canary\",\"Cookie\":\"cookie-canary\"} https://example.test/?secret=query-secret-canary /private/path-user-canary\n"
        + timestamp + "Server initialization completed private-chat-canary\n"
        + timestamp + "ERROR: Application error (PRIVATE_PROMPT_CANARY); details omitted\n"
    try text.write(to: root.appendingPathComponent("startup.log"), atomically: true, encoding: .utf8)
    let snapshot = DiagnosticsExport.snapshot(context: context(state: "failed"), logsDirectory: root)
    let output = try json(snapshot)
    for canary in canaries { try require(!output.contains(canary), "A private canary was retained") }
    try require(!output.contains("PRIVATE_PROMPT_CANARY"), "An arbitrary error code was retained")
    try require(events(snapshot).contains { $0["event"] == "startup-failed" }, "The generic failure event was lost")
    try require(events(snapshot).count == 2, "Unknown/full console text was retained")
}

check("malformed metadata and trailing newlines become unknown") {
    let root = try directory("malformed-metadata")
    let snapshot = DiagnosticsExport.snapshot(context: context(appVersion: "1.19.0\n", build: "10191?secret=canary", runtime: "user-canary",
                                                                deployment: hash + "\n", state: "private-chat-canary", os: "26.4.1\n", family: "personal-name-canary"), logsDirectory: root)
    let metadata = snapshot["metadata"] as? [String: Any] ?? [:]
    for key in ["appVersion", "appBuild", "runtimeVersion", "deploymentId", "startupState", "osVersion", "deviceFamily"] {
        try require(metadata[key] as? String == "unknown", "Malformed metadata was retained")
    }
    try require(!(try json(snapshot)).contains("canary"), "A metadata canary was retained")
}

check("missing logs still produce useful failed-startup metadata") {
    let root = try directory("missing-logs")
    let snapshot = DiagnosticsExport.snapshot(context: context(state: "failed"), logsDirectory: root)
    try require(logs(snapshot).count == 3 && logs(snapshot).allSatisfy { $0["status"] as? String == "missing" }, "Missing logs were not reported")
    caseStage = "create"
    let artifact = try DiagnosticsExport.create(context: context(state: "failed"), logsDirectory: root, temporaryDirectory: fixture)
    try require(manager.fileExists(atPath: artifact.fileURL.path), "Missing-log snapshot could not be exported")
    caseStage = "remove"
    try DiagnosticsExport.remove(artifact)
}

check("symlink log files and unexpected filenames are never read") {
    let root = try directory("symlink-file")
    let outside = fixture.appendingPathComponent("outside-private-canary.log")
    let original = Data((startLine + "private-canary\n").utf8)
    try original.write(to: outside)
    try manager.createSymbolicLink(at: root.appendingPathComponent("startup.log"), withDestinationURL: outside)
    try readyLine.write(to: root.appendingPathComponent("unexpected.log"), atomically: true, encoding: .utf8)
    let snapshot = DiagnosticsExport.snapshot(context: context(), logsDirectory: root)
    try require(events(snapshot).isEmpty, "A linked or unexpected log was read")
    try require(logs(snapshot).last?["status"] as? String == "not-regular-file", "Symlink rejection was not recorded")
    try require(try Data(contentsOf: outside) == original, "The source outside the log directory was changed")
    try require(!(try json(snapshot)).contains("outside-private-canary"), "An outside path was serialized")
}

check("symlink log directories cannot redirect reads outside the log root") {
    let outside = try directory("outside-directory")
    try startLine.write(to: outside.appendingPathComponent("startup.log"), atomically: true, encoding: .utf8)
    let alias = fixture.appendingPathComponent("directory-alias")
    try manager.createSymbolicLink(at: alias, withDestinationURL: outside)
    let snapshot = DiagnosticsExport.snapshot(context: context(), logsDirectory: alias)
    try require(events(snapshot).isEmpty && logs(snapshot).allSatisfy { $0["status"] as? String == "unavailable" }, "A linked directory was read")
}

check("oversized Unicode and invalid UTF-8 retain only complete bounded events") {
    let root = try directory("unicode-tail")
    var bytes = Data(String(repeating: "한글🙂private-unicode-canary", count: 6000).utf8)
    bytes.append(contentsOf: [0xF0, 0x80, 0x80, 0x80, 0x0A])
    bytes.append(Data(startLine.utf8))
    try bytes.write(to: root.appendingPathComponent("startup.log"))
    let snapshot = DiagnosticsExport.snapshot(context: context(), logsDirectory: root)
    try require(events(snapshot).count == 1 && events(snapshot)[0]["event"] == "server-starting", "Partial/invalid Unicode damaged the complete event")
    let current = logs(snapshot).last ?? [:]
    try require(current["readBytes"] as? Int == DiagnosticsExport.maximumReadBytesPerLog && current["tailTruncated"] as? Bool == true, "The tail read was not bounded")
    try require(!(try json(snapshot)).contains("private-unicode-canary"), "A partial private line was retained")
}

check("old rotations cannot consume the budget before current startup events") {
    let root = try directory("event-budget")
    try String(repeating: readyLine, count: 400).write(to: root.appendingPathComponent("startup.log.2"), atomically: true, encoding: .utf8)
    try (startLine + timestamp + "STARTUP FAILED: private-latest-canary\n").write(to: root.appendingPathComponent("startup.log"), atomically: true, encoding: .utf8)
    let snapshot = DiagnosticsExport.snapshot(context: context(state: "failed"), logsDirectory: root)
    try require(events(snapshot).count <= DiagnosticsExport.maximumEvents, "The event budget was exceeded")
    let current = logs(snapshot).last?["events"] as? [[String: String]] ?? []
    try require(current.count == 2 && current[0]["event"] == "server-starting" && current[1]["event"] == "startup-failed", "The latest startup events were hidden by an old rotation")
}

check("JSON output is bounded and original logs remain unchanged") {
    let root = try directory("total-bound")
    for name in DiagnosticsExport.logNames { try String(repeating: startLine, count: 500).write(to: root.appendingPathComponent(name), atomically: true, encoding: .utf8) }
    let original = try Data(contentsOf: root.appendingPathComponent("startup.log"))
    caseStage = "create"
    let artifact = try DiagnosticsExport.create(context: context(), logsDirectory: root, temporaryDirectory: fixture, now: fixedDate)
    let data = try Data(contentsOf: artifact.fileURL)
    try require(data.count <= DiagnosticsExport.maximumExportBytes, "JSON exceeded its byte limit")
    let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    try require(value["kind"] as? String == "sillytavern-ios-startup-diagnostics", "The exported file was not a diagnostic snapshot")
    try require(events(value).count <= DiagnosticsExport.maximumEvents, "The serialized event count exceeded its limit")
    try require(try Data(contentsOf: root.appendingPathComponent("startup.log")) == original, "Original logs were modified")
    caseStage = "remove"
    try DiagnosticsExport.remove(artifact)
}

check("share completion or cancellation cleanup is repeatable") {
    let root = try directory("repeat-cleanup")
    for _ in 0..<3 {
        caseStage = "create"
        let artifact = try DiagnosticsExport.create(context: context(), logsDirectory: root, temporaryDirectory: fixture)
        let directory = artifact.fileURL.deletingLastPathComponent()
        caseStage = "remove"
        try DiagnosticsExport.remove(artifact)
        caseStage = "repeat-remove"
        try DiagnosticsExport.remove(artifact)
        try require(!manager.fileExists(atPath: directory.path), "The completed/cancelled export directory remained")
    }
}

check("abandoned cleanup touches only owned diagnostic UUID directories") {
    let logsRoot = try directory("abandoned-logs")
    let artifact = try DiagnosticsExport.create(context: context(), logsDirectory: logsRoot, temporaryDirectory: fixture)
    let root = fixture.appendingPathComponent(DiagnosticsExport.directoryName)
    let foreign = root.appendingPathComponent("unowned-user-folder", isDirectory: true)
    try manager.createDirectory(at: foreign, withIntermediateDirectories: false)
    let original = foreign.appendingPathComponent("personal.txt")
    try "personal-cleanup-canary".write(to: original, atomically: true, encoding: .utf8)
    let unknown = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try manager.createDirectory(at: unknown, withIntermediateDirectories: false)
    try "keep".write(to: unknown.appendingPathComponent("unknown.json"), atomically: true, encoding: .utf8)
    DiagnosticsExport.removeAbandoned(temporaryDirectory: fixture)
    try require(!manager.fileExists(atPath: artifact.fileURL.path), "An abandoned owned export remained")
    try require(manager.fileExists(atPath: original.path) && manager.fileExists(atPath: unknown.path), "An unowned file or directory was removed")
}

check("symlink temporary roots are rejected before writing an export") {
    let temp = try directory("invalid-temporary")
    let outside = try directory("outside-temporary")
    let logsRoot = try directory("invalid-temporary-logs")
    try manager.createSymbolicLink(at: temp.appendingPathComponent(DiagnosticsExport.directoryName), withDestinationURL: outside)
    var rejected = false
    do { _ = try DiagnosticsExport.create(context: context(), logsDirectory: logsRoot, temporaryDirectory: temp) }
    catch DiagnosticsExport.ExportError.invalidTemporaryRoot { rejected = true }
    try require(rejected, "A symlink temporary root was accepted")
    try require(try manager.contentsOfDirectory(atPath: outside.path).isEmpty, "An export was written outside the temporary root")
}

check("additional redaction removes quoted keys and authorization text") {
    let result = DiagnosticsExport.scrub("sk-private-token Bearer private-auth; cookie=private-cookie\napi_key=private-key\n\"api_key\": \"quoted-private-key\"")
    for canary in ["sk-private-token", "private-auth", "private-cookie", "private-key", "quoted-private-key"] {
        try require(!result.contains(canary), "A final-scrub canary was retained")
    }
}

let failed = results.filter { $0["status"] == "failed" }.count
let report: [String: Any] = ["formatVersion": 1, "executionScope": "Foundation-helper-host", "physicalDeviceValidated": false,
                            "testCount": results.count, "passed": results.count - failed, "failed": failed, "cases": results]
let reportData = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(reportData)
FileHandle.standardOutput.write(Data("\n".utf8))
if failed > 0 { exit(1) }

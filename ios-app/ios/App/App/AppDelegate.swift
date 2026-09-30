import UIKit
import Capacitor
import CryptoKit

struct RuntimeManifest: Codable, Equatable {
    struct FileEntry: Codable, Equatable {
        let path: String
        let sha256: String
        let size: Int64
    }

    let formatVersion: Int
    let applicationVersion: String
    let deploymentId: String
    let files: [FileEntry]
}

private struct RuntimeInstallError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private(set) var runtimeManifest: RuntimeManifest?
    private(set) var runtimePreparationError: String?
    private var runtimePreparationAttempted = false

    private let fileManager = FileManager.default
    private let updateTimeKey = "CapacitorNodeJS_AppUpdateTime"

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        prepareRuntimeIfNeeded()
        return true
    }

    // Also called before Capacitor creates plugins, since storyboard view
    // loading can precede didFinishLaunchingWithOptions.
    func prepareRuntimeIfNeeded() {
        guard !runtimePreparationAttempted else { return }
        runtimePreparationAttempted = true
        do {
            let manifest = try prepareRuntime()
            try writeBundlePathConfig(manifest: manifest)
            runtimeManifest = manifest
            NSLog("[ST-Swift] Verified runtime %@ (%@)", manifest.applicationVersion, manifest.deploymentId)
        } catch {
            runtimePreparationError = error.localizedDescription
            // An old path config must never authorize a partially installed runtime.
            if let configURL = try? pathConfigURL() {
                try? fileManager.removeItem(at: configURL)
            }
            NSLog("[ST-Swift] Runtime preparation failed: %@", error.localizedDescription)
        }
    }

    private func pathConfigURL() throws -> URL {
        let support = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return support.appendingPathComponent("st_config.json")
    }

    private func writeBundlePathConfig(manifest: RuntimeManifest) throws {
        let publicURL = Bundle.main.bundleURL.appendingPathComponent("public", isDirectory: true)
        let documents = try fileManager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let config: [String: String] = [
            "bundlePublicPath": publicURL.path,
            "bundleServerRoot": publicURL.appendingPathComponent("st-defaults", isDirectory: true).path,
            "documentsPath": documents.path,
            "applicationVersion": manifest.applicationVersion,
            "deploymentId": manifest.deploymentId
        ]
        let data = try JSONSerialization.data(withJSONObject: config)
        try data.write(to: pathConfigURL(), options: .atomic)
    }

    private func prepareRuntime() throws -> RuntimeManifest {
        let bundledRuntime = Bundle.main.bundleURL.appendingPathComponent("public/nodejs-project", isDirectory: true)
        let expected = try readManifest(in: bundledRuntime)
        try verifyRuntime(at: bundledRuntime, manifest: expected)

        let library = try fileManager.url(for: .libraryDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let runtimeRoot = library.appendingPathComponent("nodejs", isDirectory: true)
        try fileManager.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
        let installed = runtimeRoot.appendingPathComponent("public", isDirectory: true)
        let staging = runtimeRoot.appendingPathComponent("public.pending", isDirectory: true)
        let previous = runtimeRoot.appendingPathComponent("public.previous", isDirectory: true)

        // Recover an interrupted directory swap before attempting another update.
        if fileManager.fileExists(atPath: previous.path) {
            if !fileManager.fileExists(atPath: installed.path) {
                try fileManager.moveItem(at: previous, to: installed)
            } else if !isVerifiedRuntime(at: installed, manifest: expected) {
                try fileManager.removeItem(at: installed)
                try fileManager.moveItem(at: previous, to: installed)
            } else {
                try fileManager.removeItem(at: previous)
            }
        }
        if fileManager.fileExists(atPath: staging.path) {
            try fileManager.removeItem(at: staging)
        }

        let runtimeChanged = !isVerifiedRuntime(at: installed, manifest: expected)
        if runtimeChanged {
            try fileManager.copyItem(at: bundledRuntime, to: staging)
            try verifyRuntime(at: staging, manifest: expected)
            if fileManager.fileExists(atPath: installed.path) {
                try fileManager.moveItem(at: installed, to: previous)
            }
            do {
                try fileManager.moveItem(at: staging, to: installed)
                try verifyRuntime(at: installed, manifest: expected)
            } catch {
                if fileManager.fileExists(atPath: installed.path) {
                    try? fileManager.removeItem(at: installed)
                }
                if fileManager.fileExists(atPath: previous.path) {
                    try? fileManager.moveItem(at: previous, to: installed)
                }
                throw error
            }
            if fileManager.fileExists(atPath: previous.path) {
                try fileManager.removeItem(at: previous)
            }
        }

        // The plugin owns builtin_modules. A missing directory is copied even
        // when AppUpdateTime matches; remove old builtins when the app changes.
        let buildVersion = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        if runtimeChanged || UserDefaults.standard.string(forKey: updateTimeKey) != buildVersion {
            let builtins = runtimeRoot.appendingPathComponent("builtin_modules", isDirectory: true)
            if fileManager.fileExists(atPath: builtins.path) {
                try fileManager.removeItem(at: builtins)
            }
        }
        // public is now complete and verified, so the plugin must not recopy it.
        UserDefaults.standard.set(buildVersion, forKey: updateTimeKey)
        return expected
    }

    private func readManifest(in directory: URL) throws -> RuntimeManifest {
        let manifestURL = directory.appendingPathComponent("runtime-manifest.json")
        let manifest = try JSONDecoder().decode(RuntimeManifest.self, from: Data(contentsOf: manifestURL))
        guard manifest.formatVersion == 1,
              !manifest.applicationVersion.isEmpty,
              isSHA256(manifest.deploymentId),
              !manifest.files.isEmpty else {
            throw RuntimeInstallError(message: "The bundled runtime manifest is invalid. Rebuild the app resources.")
        }
        var paths = Set<String>()
        for file in manifest.files {
            let components = file.path.split(separator: "/", omittingEmptySubsequences: false)
            guard !file.path.isEmpty, !file.path.hasPrefix("/"),
                  !file.path.contains("\\"), !file.path.contains(":"),
                  file.path.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
                  !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  file.path != "runtime-manifest.json", file.size >= 0,
                  isSHA256(file.sha256), paths.insert(file.path).inserted else {
                throw RuntimeInstallError(message: "The runtime manifest contains an invalid file entry.")
            }
        }
        guard Set(["server-ios.js", "server-bundle.mjs", "config.yaml", "package.json"]).isSubset(of: paths) else {
            throw RuntimeInstallError(message: "The runtime manifest is missing required startup files.")
        }
        let canonical = manifest.files.sorted {
            $0.path.utf16.lexicographicallyPrecedes($1.path.utf16)
        }.map { "\($0.path)\t\($0.sha256)\t\($0.size)\n" }.joined()
        let deploymentHash = SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
        guard deploymentHash == manifest.deploymentId else {
            throw RuntimeInstallError(message: "The runtime manifest deployment checksum is invalid.")
        }
        return manifest
    }

    private func isSHA256(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) }
    }

    private func isVerifiedRuntime(at directory: URL, manifest: RuntimeManifest) -> Bool {
        guard let installedManifest = try? readManifest(in: directory), installedManifest == manifest else { return false }
        do {
            try verifyRuntime(at: directory, manifest: manifest)
            return true
        } catch {
            return false
        }
    }

    private func verifyRuntime(at directory: URL, manifest: RuntimeManifest) throws {
        let rootPath = directory.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        for file in manifest.files {
            let url = directory.appendingPathComponent(file.path)
            let attributes = try fileManager.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  url.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(rootPath),
                  (attributes[.size] as? NSNumber)?.int64Value == file.size else {
                throw RuntimeInstallError(message: "Runtime file validation failed: \(file.path)")
            }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hasher = SHA256()
            while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
                hasher.update(data: chunk)
            }
            let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            guard digest == file.sha256 else {
                throw RuntimeInstallError(message: "Runtime checksum mismatch: \(file.path)")
            }
        }
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}

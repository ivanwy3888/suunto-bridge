import Cocoa
import WebKit
import CryptoKit

// MARK: - Paths

let supportDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let dir = base.appendingPathComponent("SuuntoBridge", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}()

func toolURL() -> URL? {
    Bundle.main.url(forResource: "suuntool", withExtension: nil, subdirectory: "bin")
}

func startMs(_ w: [String: Any]) -> Double {
    (w["startTime"] as? Double) ?? Double(w["startTime"] as? Int ?? 0)
}

func baseURL(for region: String) -> String {
    region == "global"
        ? "https://api.sports-tracker.com/apiserver/v1/"
        : "https://api.suunto.cn/apiserver/v1/"
}

func sessionURL(for region: String) -> URL {
    supportDir.appendingPathComponent("session-\(region).json")
}

// MARK: - Suuntool runner

struct ToolResult {
    let code: Int32
    let out: String
    let err: String
}

final class Backend {
    private let lock = NSLock()
    private var cancelled = false
    private var current: Process?

    private func setCurrent(_ p: Process?) {
        lock.lock(); current = p; lock.unlock()
    }
    private func isCancelled() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }
    func cancel() {
        lock.lock()
        cancelled = true
        let p = current
        current = nil
        lock.unlock()
        p?.terminate()
    }
    private func begin() {
        lock.lock(); cancelled = false; lock.unlock()
    }
    func isBusy() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return current != nil
    }

    private func run(_ tool: URL, _ args: [String], env: [String: String], stdin: Data?, timeout: Double) -> ToolResult {
        let p = Process()
        p.executableURL = tool
        p.arguments = args
        var e = ProcessInfo.processInfo.environment
        for (k, v) in env { e[k] = v }
        p.environment = e

        let outURL = supportDir.appendingPathComponent("stdout.tmp")
        let errURL = supportDir.appendingPathComponent("stderr.tmp")
        FileManager.default.createFile(atPath: outURL.path, contents: nil)
        FileManager.default.createFile(atPath: errURL.path, contents: nil)
        guard let outHandle = try? FileHandle(forWritingTo: outURL),
              let errHandle = try? FileHandle(forWritingTo: errURL) else {
            return ToolResult(code: 1, out: "", err: "无法创建临时文件")
        }
        p.standardOutput = outHandle
        p.standardError = errHandle
        let inPipe = Pipe()
        p.standardInput = inPipe

        do { try p.run() } catch {
            try? outHandle.close(); try? errHandle.close()
            return ToolResult(code: 1, out: "", err: "无法启动组件: \(error.localizedDescription)")
        }
        setCurrent(p)
        if let d = stdin {
            inPipe.fileHandleForWriting.write(d)
        }
        inPipe.fileHandleForWriting.closeFile()

        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline && !isCancelled() {
            usleep(120_000)
        }
        if p.isRunning {
            p.terminate()
            usleep(200_000)
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
        p.waitUntilExit()
        setCurrent(nil)
        try? outHandle.close(); try? errHandle.close()

        let outData = (try? Data(contentsOf: outURL)) ?? Data()
        let errData = (try? Data(contentsOf: errURL)) ?? Data()
        try? FileManager.default.removeItem(at: outURL)
        try? FileManager.default.removeItem(at: errURL)
        return ToolResult(code: p.terminationStatus,
                          out: String(data: outData, encoding: .utf8) ?? "",
                          err: String(data: errData, encoding: .utf8) ?? "")
    }

    // MARK: Region / account

    func hasSession(region: String) -> Bool {
        FileManager.default.fileExists(atPath: sessionURL(for: region).path)
    }

    func email(for region: String) -> String {
        guard let data = try? Data(contentsOf: sessionURL(for: region)),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let e = obj["email"] as? String else { return "" }
        return e
    }

    func login(region: String, email: String, password: String) -> [String: Any] {
        guard let tool = toolURL() else { return ["ok": false, "message": "缺少 suuntool 组件"] }
        let res = run(tool,
                      ["login", "--email", email, "--password-stdin"],
                      env: ["SUUNTOOL_BASE_URL": baseURL(for: region),
                            "SUUNTOOL_SESSION_FILE": sessionURL(for: region).path,
                            "NO_COLOR": "1"],
                      stdin: Data((password + "\n").utf8),
                      timeout: 60)
        if res.code == 0 {
            return ["ok": true, "message": "登录成功"]
        }
        var msg = friendlyError(res)
        if res.code == 4 || msg.isEmpty { msg = "邮箱或密码不对（\(res.code)）" }
        return ["ok": false, "message": msg]
    }

    private func friendlyError(_ r: ToolResult) -> String {
        let text = (r.err + "\n" + r.out)
            .split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if let line = text.first(where: { $0.lowercased().contains("error") || $0.lowercased().contains("fail") }) {
            return line.count > 220 ? String(line.prefix(220)) + "…" : line
        }
        return ""
    }

    // MARK: Export

    private func fetchWorkouts(region: String, from: Double, to: Double,
                               progress: @escaping ([String: Any]) -> Void) -> (items: [[String: Any]], error: [String: Any]?) {
        guard let tool = toolURL() else { return ([], ["ok": false, "message": "缺少 suuntool 组件"]) }
        guard hasSession(region: region) else { return ([], ["ok": false, "message": "请先登录颂拓账号"]) }
        let env = ["SUUNTOOL_BASE_URL": baseURL(for: region),
                   "SUUNTOOL_SESSION_FILE": sessionURL(for: region).path,
                   "NO_COLOR": "1"]
        progress(["type": "stage", "text": "正在获取记录列表…"])
        let pageFile = supportDir.appendingPathComponent("workouts-page.json")
        var sinceArgs: [String] = []
        if from > 0 {
            let iso = ISO8601DateFormatter()
            sinceArgs = ["--since", iso.string(from: Date(timeIntervalSince1970: from / 1000))]
        }
        var workouts: [[String: Any]] = []
        var seenKeys = Set<String>()
        var offset = 0
        while offset < 20000 {
            if isCancelled() { break }
            try? FileManager.default.removeItem(at: pageFile)
            var listArgs = ["workouts", "list", "--limit", "100", "--offset", "\(offset)",
                            "--format", "json", "-o", pageFile.path]
            listArgs += sinceArgs
            let res = run(tool, listArgs, env: env, stdin: nil, timeout: 120)
            if res.code == 4 { return ([], ["ok": false, "message": "登录已过期，请重新登录"]) }
            guard res.code == 0,
                  let data = try? Data(contentsOf: pageFile),
                  let obj = try? JSONSerialization.jsonObject(with: data),
                  let dict = obj as? [String: Any] else {
                if workouts.isEmpty {
                    return ([], ["ok": false, "message": "获取列表失败（\(res.code)）"])
                }
                break
            }
            let items = (dict["items"] as? [[String: Any]]) ?? []
            var added = 0
            for w in items {
                if let k = w["key"] as? String, !seenKeys.contains(k) {
                    seenKeys.insert(k)
                    workouts.append(w)
                    added += 1
                }
            }
            progress(["type": "stage", "text": "正在读取记录…（已取到 \(workouts.count) 条）"])
            if items.count < 100 || added == 0 { break }
            offset += 100
        }
        if workouts.isEmpty {
            if from > 0 || to > 0 {
                return ([], ["ok": false, "empty": true, "message": "这段时间里没有记录，换个日期再试"])
            }
            return ([], ["ok": false, "message": "账号里没有记录"])
        }

        if from > 0 || to > 0 {
            workouts = workouts.filter { w in
                let ms = startMs(w)
                if from > 0 && ms < from { return false }
                if to > 0 && ms > to { return false }
                return true
            }
            if workouts.isEmpty {
                return ([], ["ok": false, "empty": true, "message": "这段时间里没有记录，换个日期再试"])
            }
            progress(["type": "stage", "text": "符合条件的有 \(workouts.count) 条", "total": workouts.count])
        } else {
            progress(["type": "stage", "text": "共 \(workouts.count) 条记录", "total": workouts.count])
        }
        return (workouts, nil)
    }

    func count(region: String, from: Double, to: Double) -> [String: Any] {
        begin()
        let r = fetchWorkouts(region: region, from: from, to: to) { _ in }
        if let e = r.error {
            if (e["empty"] as? Bool) == true { return ["ok": true, "total": 0] }
            return e
        }
        return ["ok": true, "total": r.items.count]
    }

    func export(region: String, folder: String, from: Double, to: Double,
                progress: @escaping ([String: Any]) -> Void) -> [String: Any] {
        begin()
        guard let tool = toolURL() else { return ["ok": false, "message": "缺少 suuntool 组件"] }
        guard hasSession(region: region) else { return ["ok": false, "message": "请先登录颂拓账号"] }

        let dir = URL(fileURLWithPath: folder, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let env = ["SUUNTOOL_BASE_URL": baseURL(for: region),
                   "SUUNTOOL_SESSION_FILE": sessionURL(for: region).path,
                   "NO_COLOR": "1"]

        let fetched = fetchWorkouts(region: region, from: from, to: to, progress: progress)
        if let err = fetched.error { return err }
        let workouts = fetched.items

        let total = workouts.count

        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyyMMdd-HHmm"

        var csv = "\u{FEFF}开始时间,activityId,总时长秒,距离米,爬升米,步数,平均心率,文件名,workoutKey\n"
        var okCount = 0, skipCount = 0, failCount = 0
        var failures: [String] = []
        let maxItems = Int(ProcessInfo.processInfo.environment["SUUNTO_BRIDGE_MAX"] ?? "0") ?? 0

        for (i, w) in workouts.enumerated() {
            if isCancelled() { break }
            if maxItems > 0 && i >= maxItems { break }
            let key = w["key"] as? String ?? ""
            let start = startMs(w)
            let date = Date(timeIntervalSince1970: start / 1000.0)
            let act = w["activityId"] as? Int ?? 0
            let name = "\(fmt.string(from: date))_a\(act)_\(key).fit"
            let dest = dir.appendingPathComponent(name)
            let exists = ((try? FileManager.default.attributesOfItem(atPath: dest.path)[.size]) as? Int) ?? 0
            let hasFile = exists > 200

            var note = ""
            if hasFile {
                skipCount += 1
                note = "已存在"
            } else {
                let res = run(tool, ["workouts", "fit", key, "-o", dest.path, "--timeout", "90s"],
                              env: env, stdin: nil, timeout: 120)
                let size = ((try? FileManager.default.attributesOfItem(atPath: dest.path)[.size]) as? Int) ?? 0
                let header = (try? FileHandle(forReadingFrom: dest))?.readData(ofLength: 14) ?? Data()
                let sig = header.count == 14 ? header.subdata(in: 8..<12) : Data()
                let isFit = String(data: sig, encoding: .ascii) == ".FIT"
                if res.code == 0 && size > 200 && isFit {
                    okCount += 1
                } else {
                    try? FileManager.default.removeItem(at: dest)
                    failCount += 1
                    failures.append(name)
                    note = "失败 \(res.code)"
                }
            }

            let dur = w["totalTime"] as? Double ?? 0
            let dist = w["totalDistance"] as? Double ?? 0
            let asc = w["totalAscent"] as? Double ?? 0
            let steps = w["stepCount"] as? Int ?? 0
            var avgHr: Any = ""
            if let hr = w["hrdata"] as? [String: Any], let a = hr["avg"] as? Int { avgHr = a }
            let written = ((try? FileManager.default.attributesOfItem(atPath: dest.path)[.size]) as? Int) ?? 0
            let fileCell = written > 200 ? name : ""
            csv += "\(fmt.string(from: date)),\(act),\(Int(dur)),\(Int(dist)),\(Int(asc)),\(steps),\(avgHr),\(fileCell),\(key)\n"

            progress(["type": "item", "index": i + 1, "total": total,
                      "name": name, "note": note,
                      "ok": okCount, "skip": skipCount, "fail": failCount])
            if !hasFile { usleep(500_000) }
        }

        let csvURL = dir.appendingPathComponent("导出清单.csv")
        try? csv.data(using: .utf8)?.write(to: csvURL)

        let stopped = isCancelled()
        progress(["type": "stage", "text": stopped ? "已停止" : "导出结束，清单已保存"])
        return ["ok": true, "stopped": stopped,
                "total": total, "downloaded": okCount, "skipped": skipCount,
                "failed": failCount, "failures": Array(failures.prefix(8)),
                "csv": csvURL.path, "folder": dir.path]
    }

    // MARK: FitnessSyncer

    private let fsRedirectURI = "https://personal.fitnesssyncer.com/"
    private let fsScopes = "source_read source_data_activity_read notebook_activity_write destination_read destination_write"
    private let fsPublicClientID = "0EFA66C9AABD4CC0909BCC142990E553"

    private var fsAuthFile: URL { supportDir.appendingPathComponent("fs-oauth.json") }

    private var fsAuth: [String: Any] {
        get {
            guard let d = try? Data(contentsOf: fsAuthFile),
                  let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
            return o
        }
        set {
            let d = (try? JSONSerialization.data(withJSONObject: newValue, options: [.sortedKeys])) ?? Data()
            try? d.write(to: fsAuthFile, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fsAuthFile.path)
        }
    }

    private var fsActiveClientID: String { fsPublicClientID }

    private var pkceVerifier: String?
    private var didMigrateAuth = false

    private func migrateAuthIfNeeded() {
        guard !didMigrateAuth else { return }
        didMigrateAuth = true
        var a = fsAuth
        if ((a["clientId"] as? String) ?? "") != fsPublicClientID {
            a.removeValue(forKey: "accessToken")
            a.removeValue(forKey: "refreshToken")
            a.removeValue(forKey: "expiresAt")
            a.removeValue(forKey: "clientSecret")
            a["clientId"] = fsPublicClientID
            fsAuth = a
        }
    }

    private func newPKCEChallenge() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        for i in 0..<bytes.count { bytes[i] = UInt8.random(in: 0...255) }
        let verifier = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        pkceVerifier = verifier
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    func fsAuthState() -> [String: Any] {
        migrateAuthIfNeeded()
        let a = fsAuth
        let hasToken = !((a["refreshToken"] as? String) ?? "").isEmpty
        return ["hasSecret": true,
                "secretLength": 0,
                "connected": hasToken,
                "clientId": fsPublicClientID]
    }

    func fsSignOut() -> [String: Any] {
        var a = fsAuth
        a.removeValue(forKey: "accessToken")
        a.removeValue(forKey: "refreshToken")
        a.removeValue(forKey: "expiresAt")
        fsAuth = a
        return ["ok": true]
    }

    func fsAuthorizeURL(state: String) -> URL? {
        migrateAuthIfNeeded()
        let challenge = newPKCEChallenge()
        var c = URLComponents(string: "https://www.fitnesssyncer.com/api/oauth/authorize")
        c?.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: fsActiveClientID),
            URLQueryItem(name: "redirect_uri", value: fsRedirectURI),
            URLQueryItem(name: "scope", value: fsScopes),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256")
        ]
        return c?.url
    }

    private func formBody(_ pairs: [(String, String)]) -> Data {
        let allowed = CharacterSet.alphanumerics
        let s = pairs.map { k, v in
            "\(k)=\(v.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")"
        }.joined(separator: "&")
        return Data(s.utf8)
    }

    private func httpResp(_ method: String, _ urlStr: String, token: String? = nil,
                          body: Data? = nil, contentType: String? = nil) -> (status: Int, location: String?, data: Data) {
        guard let url = URL(string: urlStr) else { return (0, nil, Data()) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 120
        req.setValue("SuuntoBridge/1.0 (macOS)", forHTTPHeaderField: "User-Agent")
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let b = body {
            req.httpBody = b
            if let ct = contentType { req.setValue(ct, forHTTPHeaderField: "Content-Type") }
        }
        let sem = DispatchSemaphore(value: 0)
        var status = 0
        var location: String?
        var data = Data()
        URLSession.shared.dataTask(with: req) { d, r, _ in
            status = (r as? HTTPURLResponse)?.statusCode ?? 0
            location = (r as? HTTPURLResponse)?.value(forHTTPHeaderField: "Location")
            data = d ?? Data()
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 130)
        return (status, location, data)
    }

    private func http(_ method: String, _ urlStr: String, token: String? = nil,
                      body: Data? = nil, contentType: String? = nil) -> (Int, Data) {
        let r = httpResp(method, urlStr, token: token, body: body, contentType: contentType)
        return (r.status, r.data)
    }

    private func tokenJSON(_ d: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    private func storeToken(_ obj: [String: Any]) {
        var a = fsAuth
        if let t = obj["access_token"] as? String { a["accessToken"] = t }
        if let r = obj["refresh_token"] as? String { a["refreshToken"] = r }
        let ttl = (obj["expires_in"] as? Double) ?? Double(obj["expires_in"] as? Int ?? 0)
        a["expiresAt"] = Date().timeIntervalSince1970 + ttl
        if let s = obj["scope"] as? String { a["scope"] = s }
        fsAuth = a
    }

    private func textOf(_ d: Data) -> String {
        String(data: d.prefix(300), encoding: .utf8) ?? ""
    }

    private func arraysFrom(_ obj: Any) -> [[String: Any]] {
        if let a = obj as? [[String: Any]] { return a }
        if let d = obj as? [String: Any] {
            for k in ["items", "sources", "data", "results", "list"] {
                if let a = d[k] as? [[String: Any]] { return a }
            }
            if let inner = d["data"] as? [String: Any] {
                for k in ["items", "sources"] {
                    if let a = inner[k] as? [[String: Any]] { return a }
                }
            }
        }
        return []
    }

    func fsExchangeCode(_ code: String) -> [String: Any] {
        migrateAuthIfNeeded()
        guard let verifier = pkceVerifier, !verifier.isEmpty else {
            return ["ok": false, "message": "授权校验码丢了，再点一次「登录并授权」"]
        }
        pkceVerifier = nil
        var pairs: [(String, String)] = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", fsActiveClientID),
            ("redirect_uri", fsRedirectURI),
            ("code_verifier", verifier)
        ]
        if let secret = fsAuth["clientSecret"] as? String, !secret.isEmpty {
            pairs.append(("client_secret", secret))
        }
        let body = formBody(pairs)
        let (status, data) = http("POST", "https://api.fitnesssyncer.com/api/oauth/access_token",
                                  body: body, contentType: "application/x-www-form-urlencoded")
        guard status == 200, let obj = tokenJSON(data), obj["access_token"] is String else {
            let o = tokenJSON(data)
            let msg = (o?["error_description"] as? String) ?? (o?["error"] as? String) ?? textOf(data)
            return ["ok": false, "message": "换令牌失败（HTTP \(status)）：\(msg)"]
        }
        storeToken(obj)
        return ["ok": true]
    }

    private func fsToken(force: Bool = false) -> String? {
        migrateAuthIfNeeded()
        let a = fsAuth
        let now = Date().timeIntervalSince1970
        let exp = (a["expiresAt"] as? Double) ?? 0
        let cached = (a["accessToken"] as? String) ?? ""
        if !force, !cached.isEmpty, exp - now > 120 { return cached }
        guard let rt = a["refreshToken"] as? String, !rt.isEmpty else {
            return cached.isEmpty ? nil : cached
        }
        var pairs: [(String, String)] = [
            ("grant_type", "refresh_token"),
            ("refresh_token", rt),
            ("client_id", fsActiveClientID),
            ("redirect_uri", fsRedirectURI)
        ]
        if let secret = a["clientSecret"] as? String, !secret.isEmpty {
            pairs.append(("client_secret", secret))
        }
        let body = formBody(pairs)
        let (status, data) = http("POST", "https://api.fitnesssyncer.com/api/oauth/access_token",
                                  body: body, contentType: "application/x-www-form-urlencoded")
        if status == 200, let obj = tokenJSON(data), obj["access_token"] is String {
            storeToken(obj)
            return obj["access_token"] as? String
        }
        return cached.isEmpty ? nil : cached
    }

    func fsConnect() -> [String: Any] {
        guard var tok = fsToken() else { return ["ok": false, "message": "还没授权，先点登录并授权"] }
        var (status, data) = http("GET", "https://api.fitnesssyncer.com/api/providers/sources", token: tok)
        if status == 401 {
            tok = fsToken(force: true) ?? tok
            (status, data) = http("GET", "https://api.fitnesssyncer.com/api/providers/sources", token: tok)
        }
        guard status == 200 else {
            return ["ok": false, "message": "读来源失败（HTTP \(status)）：\(textOf(data))"]
        }
        let list = arraysFrom((try? JSONSerialization.jsonObject(with: data)) ?? [:])
        var out: [[String: Any]] = []
        for s in list {
            var id = ""
            if let v = s["id"] as? String { id = v }
            else if let v = s["id"] as? Int { id = String(v) }
            else if let v = s["sourceId"] as? String { id = v }
            var name = ""
            for k in ["name", "displayName", "title", "provider"] {
                if let v = s[k] as? String, !v.isEmpty { name = v; break }
            }
            if id.isEmpty { continue }
            out.append(["id": id, "name": name.isEmpty ? id : name])
        }
        return ["ok": true, "sources": out]
    }

    private func fsFilesAndLedger(_ folder: String) -> (files: [URL], ledger: Set<String>) {
        let dir = URL(fileURLWithPath: folder, isDirectory: true)
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))?
            .filter { $0.pathExtension.lowercased() == "fit" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }) ?? []
        var ledger = Set<String>()
        if let raw = try? String(contentsOf: dir.appendingPathComponent("已上传.txt"), encoding: .utf8) {
            for line in raw.split(separator: "\n") {
                let n = line.trimmingCharacters(in: .whitespaces)
                if !n.isEmpty { ledger.insert(n) }
            }
        }
        return (files, ledger)
    }

    func folderStats(folder: String) -> [String: Any] {
        let (files, ledger) = fsFilesAndLedger(folder)
        let done = files.filter { ledger.contains($0.lastPathComponent) }.count
        return ["ok": true, "total": files.count, "done": done, "pending": files.count - done]
    }

    func fsUpload(sourceId: String, folder: String,
                  progress: @escaping ([String: Any]) -> Void) -> [String: Any] {
        begin()
        guard var tok = fsToken() else { return ["ok": false, "message": "还没授权"] }
        let dir = URL(fileURLWithPath: folder, isDirectory: true)
        let (files, ledger) = fsFilesAndLedger(folder)
        if files.isEmpty { return ["ok": false, "message": "这个文件夹里没有 .fit 文件"] }

        let sid = sourceId.isEmpty ? "notebook" : sourceId
        let srcName = "FitnessSyncer"

        let ledgerURL = dir.appendingPathComponent("已上传.txt")
        let done = ledger
        if !FileManager.default.fileExists(atPath: ledgerURL.path) {
            FileManager.default.createFile(atPath: ledgerURL.path, contents: Data())
        }

        let endpoint = "https://api.fitnesssyncer.com/api/providers/sources/\(sid)/items/upload"

        var okCount = 0, skipCount = 0, failCount = 0
        var failures: [String] = []
        let total = files.count

        for (i, f) in files.enumerated() {
            if isCancelled() { break }
            let name = f.lastPathComponent
            if done.contains(name) {
                skipCount += 1
                progress(["type": "item", "index": i + 1, "total": total, "name": name,
                          "note": "之前传过", "ok": okCount, "skip": skipCount, "fail": failCount])
                continue
            }
            guard let fileData = try? Data(contentsOf: f) else {
                failCount += 1; failures.append(name)
                continue
            }
            let boundary = "----SuuntoBridge\(UUID().uuidString)"
            var body = Data()
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n".utf8))
            body.append(Data("Content-Type: application/octet-stream\r\n\r\n".utf8))
            body.append(fileData)
            body.append(Data("\r\n--\(boundary)--\r\n".utf8))

            var (status, resp) = http("POST", endpoint, token: tok, body: body,
                                      contentType: "multipart/form-data; boundary=\(boundary)")
            if status == 401 {
                tok = fsToken(force: true) ?? tok
                (status, resp) = http("POST", endpoint, token: tok, body: body,
                                      contentType: "multipart/form-data; boundary=\(boundary)")
            }
            var note = ""
            if status == 200 {
                okCount += 1
                if let h = try? FileHandle(forWritingTo: ledgerURL) {
                    h.seekToEndOfFile()
                    h.write(Data((name + "\n").utf8))
                    try? h.close()
                }
                if let o = (try? JSONSerialization.jsonObject(with: resp)) as? [String: Any],
                   let its = o["items"] as? [[String: Any]] {
                    let hint = fsItemDateHint(name)
                    var cleared = 0
                    for it in its {
                        if let iid = it["id"] as? String,
                           fsClearImportedComment(itemID: iid, hint: hint, tok: &tok) {
                            cleared += 1
                        }
                    }
                    if cleared > 0 { note = "已清掉文件名评论" }
                }
            } else {
                failCount += 1
                failures.append(name)
                note = "HTTP \(status)"
                if status == 401 || status == 403 {
                    progress(["type": "item", "index": i + 1, "total": total, "name": name,
                              "note": note, "ok": okCount, "skip": skipCount, "fail": failCount])
                    return ["ok": false, "message": "FitnessSyncer 拒绝了这次上传（HTTP \(status)）：\(textOf(resp))",
                            "total": total, "uploaded": okCount, "skipped": skipCount, "failed": failCount]
                }
            }
            progress(["type": "item", "index": i + 1, "total": total, "name": name, "note": note,
                      "ok": okCount, "skip": skipCount, "fail": failCount])
            usleep(400_000)
        }

        let stopped = isCancelled()
        progress(["type": "stage", "text": stopped ? "已停止" : "上传结束"])
        return ["ok": true, "stopped": stopped, "total": total,
                "uploaded": okCount, "skipped": skipCount, "failed": failCount,
                "failures": Array(failures.prefix(8)),
                "source": srcName.isEmpty ? sid : srcName]
    }

    // MARK: 清掉上传时自动加的文件名评论

    private func fsItemDateHint(_ name: String) -> Date? {
        guard name.count >= 13 else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyyMMdd-HHmm"
        return f.date(from: String(name.prefix(13)))
    }

    private func fsClearImportedComment(itemID: String, hint: Date?, tok: inout String) -> Bool {
        let nb = "https://api.fitnesssyncer.com/api/providers/sources/notebook"
        func find(_ query: String) -> [String: Any]? {
            var r = httpResp("GET", "\(nb)/itemsByType/Activity?\(query)", token: tok)
            if r.status == 401 {
                tok = fsToken(force: true) ?? tok
                r = httpResp("GET", "\(nb)/itemsByType/Activity?\(query)", token: tok)
            }
            guard r.status == 200,
                  let o = (try? JSONSerialization.jsonObject(with: r.data)) as? [String: Any],
                  let its = o["items"] as? [[String: Any]] else { return nil }
            return its.first { ($0["itemId"] as? String) == itemID }
        }
        var hit: [String: Any]?
        if let d = hint {
            let ms = Int64(d.timeIntervalSince1970 * 1000)
            let span: Int64 = 2 * 86_400_000
            hit = find("startDate=\(ms - span)&endDate=\(ms + span)&limit=100")
        }
        if hit == nil { hit = find("limit=100") }
        guard var item = hit else { return false }
        let c = (item["comment"] as? String) ?? ""
        guard c.hasPrefix("Imported from") else { return true }
        // 更新接口是整条覆盖，所以读回完整记录、只去掉评论再写回
        item.removeValue(forKey: "comment")
        guard let payload = try? JSONSerialization.data(withJSONObject: item) else { return false }
        var r = httpResp("POST", "\(nb)/items/\(itemID)", token: tok, body: payload,
                         contentType: "application/json")
        if r.status == 401 {
            tok = fsToken(force: true) ?? tok
            r = httpResp("POST", "\(nb)/items/\(itemID)", token: tok, body: payload,
                         contentType: "application/json")
        }
        return r.status == 200
    }

    // MARK: 目的地（颂拓国际）

    private let fsDestURL = "https://api.fitnesssyncer.com/api/providers/destinations/"

    private func fsNum(_ v: Any?) -> Double {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let n = v as? NSNumber { return n.doubleValue }
        return 0
    }

    private func fsDestCall(_ method: String, _ urlStr: String, tok: inout String,
                            body: [String: Any]? = nil) -> (status: Int, location: String?, data: Data) {
        let payload = body.map { (try? JSONSerialization.data(withJSONObject: $0)) ?? Data() }
        var r = httpResp(method, urlStr, token: tok, body: payload,
                         contentType: payload == nil ? nil : "application/json")
        if r.status == 401 {
            tok = fsToken(force: true) ?? tok
            r = httpResp(method, urlStr, token: tok, body: payload,
                         contentType: payload == nil ? nil : "application/json")
        }
        return r
    }

    private func fsDestList(_ tok: inout String) -> [[String: Any]]? {
        let r = fsDestCall("GET", fsDestURL, tok: &tok)
        guard r.status == 200 else { return nil }
        return arraysFrom((try? JSONSerialization.jsonObject(with: r.data)) ?? [:])
    }

    private func fsSuuntoDest(_ list: [[String: Any]]) -> [String: Any]? {
        list.first { ($0["providerType"] as? String) == "SuuntoApp" }
    }

    private func fsSuuntoAuthID(_ tok: inout String) -> String? {
        let r = fsDestCall("GET", "https://api.fitnesssyncer.com/api/providers/authentication/", tok: &tok)
        guard r.status == 200,
              let o = (try? JSONSerialization.jsonObject(with: r.data)) as? [String: Any],
              let provs = o["providers"] as? [[String: Any]] else { return nil }
        for p in provs where (p["providerType"] as? String) == "SuuntoApp" {
            if let id = ((p["keys"] as? [[String: Any]]) ?? []).first?["id"] as? String { return id }
        }
        return nil
    }

    func destAuthed() -> Bool {
        guard var tok = fsToken() else { return false }
        return fsSuuntoAuthID(&tok) != nil
    }

    func destStatus() -> [String: Any] {
        guard var tok = fsToken() else {
            return ["ok": false, "needFs": true, "message": "还没连接 FitnessSyncer，先在第二个选项卡里授权"]
        }
        guard let list = fsDestList(&tok) else {
            return ["ok": false, "message": "读目的地失败：令牌里可能没有「目的地」权限，去第二个选项卡点「重新授权」"]
        }
        guard let dest = fsSuuntoDest(list) else {
            return ["ok": true, "found": false, "authed": false]
        }
        let id = (dest["id"] as? String) ?? ""
        let authed = id.isEmpty ? false : fsSuuntoAuthID(&tok) != nil
        var sync: [String: Any] = [:]
        let sr = fsDestCall("GET", "https://api.fitnesssyncer.com/api/syncs/", tok: &tok)
        if sr.status == 200,
           let o = (try? JSONSerialization.jsonObject(with: sr.data)) as? [String: Any],
           let results = o["results"] as? [[String: Any]],
           let hit = results.last(where: { ($0["id"] as? String) == id }) {
            sync = hit
        }
        return ["ok": true, "found": true, "authed": authed, "id": id,
                "name": (dest["name"] as? String) ?? "颂拓国际",
                "enabled": (dest["enabled"] as? Bool) ?? true,
                "lastDate": fsNum(dest["date"]),
                "lastError": (dest["lastError"] as? String) ?? "",
                "syncQueue": (sync["queueStatus"] as? String) ?? "",
                "syncStatus": (sync["status"] as? String) ?? "",
                "syncUpdate": (sync["update"] as? String) ?? "",
                "syncOk": (sync["success"] as? Bool) ?? false]
    }

    func destPrepare(force: Bool = false) -> [String: Any] {
        guard var tok = fsToken() else {
            return ["ok": false, "needFs": true, "message": "还没连接 FitnessSyncer，先在第二个选项卡里授权"]
        }
        guard let list = fsDestList(&tok) else {
            return ["ok": false, "message": "读目的地失败：令牌里可能没有「目的地」权限，去第二个选项卡点「重新授权」"]
        }
        var dest = fsSuuntoDest(list)
        var created = false
        if dest == nil {
            let r = fsDestCall("PUT", fsDestURL, tok: &tok,
                               body: ["type": "sync", "name": "颂拓国际", "providerType": "SuuntoApp",
                                      "taskType": "Activity", "enabled": true])
            let obj = (try? JSONSerialization.jsonObject(with: r.data)) as? [String: Any]
            let newID = (obj?["id"] as? String) ?? ((obj?["item"] as? [String: Any])?["id"] as? String) ?? ""
            guard r.status == 200, !newID.isEmpty else {
                return ["ok": false, "message": "建接收方失败（HTTP \(r.status)）：\(textOf(r.data))"]
            }
            dest = ["id": newID, "name": "颂拓国际"]
            created = true
        }
        let id = (dest?["id"] as? String) ?? ""
        let name = (dest?["name"] as? String) ?? "颂拓国际"
        guard !id.isEmpty else { return ["ok": false, "message": "接收方 id 是空的"] }

        if !force, let authID = fsSuuntoAuthID(&tok) {
            if created {
                let r = fsDestCall("PUT", "\(fsDestURL)\(id)/authentication", tok: &tok,
                                   body: ["type": "OAuthReuse", "id": authID])
                guard r.status == 200 else {
                    return ["ok": false, "message": "复用颂拓授权失败（HTTP \(r.status)）：\(textOf(r.data))"]
                }
            }
            return ["ok": true, "needAuth": false, "name": name, "id": id]
        }
        let r = fsDestCall("PUT", "\(fsDestURL)\(id)/authentication", tok: &tok,
                           body: ["type": "OAuth", "redirect": "https://personal.fitnesssyncer.com/?dst=1"])
        guard r.status == 202, let loc = r.location, !loc.isEmpty else {
            return ["ok": false, "message": "发起颂拓授权失败（HTTP \(r.status)）：\(textOf(r.data))"]
        }
        return ["ok": true, "needAuth": true, "url": loc, "name": name, "id": id]
    }

    func destSync() -> [String: Any] {
        guard var tok = fsToken() else {
            return ["ok": false, "message": "还没连接 FitnessSyncer，先在第二个选项卡里授权"]
        }
        guard let list = fsDestList(&tok) else {
            return ["ok": false, "message": "读目的地失败：令牌里可能没有「目的地」权限，去第二个选项卡点「重新授权」"]
        }
        guard let dest = fsSuuntoDest(list), let id = dest["id"] as? String, !id.isEmpty else {
            return ["ok": false, "message": "FitnessSyncer 里还没有颂拓国际接收方，先点「登录颂拓国际」"]
        }
        guard fsSuuntoAuthID(&tok) != nil else {
            return ["ok": false, "message": "颂拓国际还没登录授权，先点「登录颂拓国际」"]
        }
        let r = fsDestCall("POST", "\(fsDestURL)\(id)/execute", tok: &tok)
        switch r.status {
        case 200, 202:
            return ["ok": true, "message": "已提交给 FitnessSyncer，正在往颂拓国际送记录"]
        case 409:
            return ["ok": false, "message": "上一次同步还没跑完，过一会儿再点"]
        case 403:
            return ["ok": false, "message": "FitnessSyncer 没给这个账号开「立即执行」，可以先让它在网站上按计划跑"]
        default:
            return ["ok": false, "message": "提交失败（HTTP \(r.status)）：\(textOf(r.data))"]
        }
    }

}

// MARK: - Window drag strip

final class DragStripView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.performZoom(nil)
        } else {
            window?.performDrag(with: event)
        }
    }
}

// MARK: - 授权窗口

final class FsAuthWindow: NSObject, WKNavigationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private var hint: NSTextField!
    private var cancelBtn: NSButton!
    private var expectedState = ""
    private var destinationMode = false
    private var onFinish: (([String: Any]) -> Void)?
    private var finished = false

    func present(over parent: NSWindow, url: URL, state: String,
                 destinationMode: Bool = false,
                 onFinish: @escaping ([String: Any]) -> Void) {
        expectedState = state
        self.destinationMode = destinationMode
        self.onFinish = onFinish
        let rect = NSRect(x: 0, y: 0, width: 760, height: 800)
        let w = NSWindow(contentRect: rect,
                         styleMask: [.titled, .closable, .resizable],
                         backing: .buffered, defer: false)
        w.title = destinationMode ? "登录颂拓国际" : "登录 FitnessSyncer"

        let container = NSView(frame: rect)
        container.autoresizingMask = [.width, .height]

        web = WKWebView(frame: NSRect(x: 0, y: 46, width: rect.width, height: rect.height - 46),
                        configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        container.addSubview(web)

        let bar = NSView(frame: NSRect(x: 0, y: 0, width: rect.width, height: 46))
        bar.autoresizingMask = [.width, .maxYMargin]
        let line = NSBox(frame: NSRect(x: 0, y: 45, width: rect.width, height: 1))
        line.boxType = .separator
        line.autoresizingMask = [.width, .minYMargin]
        bar.addSubview(line)

        hint = NSTextField(labelWithString: "")
        hint.frame = NSRect(x: 16, y: 13, width: rect.width - 132, height: 20)
        hint.font = .systemFont(ofSize: 11.5)
        hint.textColor = .secondaryLabelColor
        hint.lineBreakMode = .byTruncatingTail
        hint.autoresizingMask = [.width]
        bar.addSubview(hint)

        cancelBtn = NSButton(title: "关闭", target: self, action: #selector(cancelTapped))
        cancelBtn.bezelStyle = .rounded
        cancelBtn.keyEquivalent = "\u{1b}"
        cancelBtn.frame = NSRect(x: rect.width - 104, y: 9, width: 88, height: 28)
        cancelBtn.autoresizingMask = [.minXMargin, .maxYMargin]
        bar.addSubview(cancelBtn)

        container.addSubview(bar)
        w.contentView = container
        w.delegate = self
        window = w
        web.load(URLRequest(url: url))
        parent.beginSheet(w)
    }

    @objc private func cancelTapped() {
        finish(code: "", state: "")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("(document.body||{}).innerText||''") { [weak self] v, _ in
            guard let self = self, let s = v as? String, !s.isEmpty else { return }
            let rejected = s.contains("请求无效") || s.contains("The request is invalid")
            let denied = s.contains("拒绝") && s.contains("授权")
            if rejected || denied {
                self.hint.stringValue = self.destinationMode
                    ? "颂拓拒绝了这次登录：关掉窗口，重新点「登录颂拓国际」"
                    : "FitnessSyncer 拒绝了这个请求：关掉窗口，重新点「登录并授权」再试"
                self.hint.textColor = .systemRed
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = navigationAction.request.url, u.host == "personal.fitnesssyncer.com" {
            if destinationMode {
                decisionHandler(.cancel)
                finish(code: "done", state: "")
                return
            }
            let items = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let code = items.first { $0.name == "code" }?.value ?? ""
            let st = items.first { $0.name == "state" }?.value ?? ""
            decisionHandler(.cancel)
            finish(code: code, state: st)
            return
        }
        decisionHandler(.allow)
    }

    func windowWillClose(_ notification: Notification) {
        finish(code: "", state: "")
    }

    private func finish(code: String, state: String) {
        guard !finished else { return }
        finished = true
        if let p = window.sheetParent { p.endSheet(window) }
        let cb = onFinish
        onFinish = nil
        web.navigationDelegate = nil
        window = nil
        cb?(["code": code, "state": state])
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let backend = Backend()
    let workQueue = DispatchQueue(label: "bridge.work", qos: .userInitiated)
    private var authWindow: FsAuthWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "bridge")
        config.userContentController = ucc
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let maxH = (NSScreen.main?.visibleFrame.height ?? 900) - 24
        let rect = NSRect(x: 0, y: 0, width: 860, height: min(1010, maxH))
        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]

        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "颂拓记录搬家"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 720, height: 620)

        let container = NSView(frame: rect)
        container.addSubview(webView)
        let strip = DragStripView(frame: NSRect(x: 0, y: rect.height - 40, width: rect.width, height: 40))
        strip.autoresizingMask = [.width, .minYMargin]
        container.addSubview(strip)
        window.contentView = container

        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let webDir = Bundle.main.url(forResource: "web", withExtension: nil) {
            let index = webDir.appendingPathComponent("index.html")
            webView.loadFileURL(index, allowingReadAccessTo: webDir)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let dict = message.body as? [String: Any],
              let id = dict["id"] as? Int,
              let cmd = dict["cmd"] as? String else { return }
        let payload = dict["payload"] as? [String: Any] ?? [:]

        switch cmd {
        case "status":
            var st: [String: Any] = ["hasCN": backend.hasSession(region: "cn"),
                                     "hasGlobal": backend.hasSession(region: "global"),
                                     "busy": backend.isBusy(),
                                     "emailCN": backend.email(for: "cn"),
                                     "emailGlobal": backend.email(for: "global"),
                                     "fs": backend.fsAuthState()]
            if let home = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first {
                st["defaultFolder"] = home.appendingPathComponent("颂拓导出").path
            }
            reply(id: id, ok: true, data: st)

        case "pickFolder":
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            panel.prompt = "选择"
            panel.message = "选择导出到哪个文件夹"
            if panel.runModal() == .OK, let u = panel.url {
                reply(id: id, ok: true, data: ["path": u.path])
            } else {
                reply(id: id, ok: false, data: ["message": "已取消"])
            }

        case "cancel":
            backend.cancel()
            reply(id: id, ok: true, data: [:])

        case "logout":
            if backend.isBusy() {
                reply(id: id, ok: false, data: ["message": "正在下载，先点停止再退出登录"])
                return
            }
            let region = payload["region"] as? String ?? "cn"
            try? FileManager.default.removeItem(at: sessionURL(for: region))
            reply(id: id, ok: true, data: ["ok": true])

        case "pageReady":
            let stamp = "\(Date())\n"
            try? stamp.data(using: .utf8)?.write(to: supportDir.appendingPathComponent("ui-loaded.txt"))
            reply(id: id, ok: true, data: [:])

        case "fitHeight":
            if let h = payload["height"] as? Double { fitWindowHeight(h) }
            reply(id: id, ok: true, data: [:])

        case "login":
            let region = payload["region"] as? String ?? "cn"
            let email = payload["email"] as? String ?? ""
            let password = payload["password"] as? String ?? ""
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.login(region: region, email: email, password: password)
                self.reply(id: id, ok: (r["ok"] as? Bool) ?? false, data: r)
            }

        case "count":
            let region = payload["region"] as? String ?? "cn"
            let from = (payload["from"] as? Double) ?? 0
            let to = (payload["to"] as? Double) ?? 0
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.count(region: region, from: from, to: to)
                self.reply(id: id, ok: (r["ok"] as? Bool) ?? false, data: r)
            }

        case "export":
            let region = payload["region"] as? String ?? "cn"
            let folder = payload["folder"] as? String ?? ""
            let from = (payload["from"] as? Double) ?? 0
            let to = (payload["to"] as? Double) ?? 0
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.export(region: region, folder: folder, from: from, to: to) { event in
                    self.sendEvent(event)
                }
                self.reply(id: id, ok: (r["ok"] as? Bool) ?? false, data: r)
            }

        case "fsSignOut":
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.fsSignOut()
                self.reply(id: id, ok: true, data: r)
            }

        case "fsStartAuth":
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let state = UUID().uuidString.replacingOccurrences(of: "-", with: "")
                guard let url = self.backend.fsAuthorizeURL(state: state) else {
                    self.reply(id: id, ok: false, data: ["message": "授权地址拼不出来"])
                    return
                }
                DispatchQueue.main.async {
                    let auth = FsAuthWindow()
                    self.authWindow = auth
                    auth.present(over: self.window, url: url, state: state) { res in
                        self.authWindow = nil
                        let code = res["code"] as? String ?? ""
                        let got = res["state"] as? String ?? ""
                        if code.isEmpty {
                            self.reply(id: id, ok: false, data: ["message": "授权没做完，窗口被关掉了"])
                            return
                        }
                        if code == "error" {
                            self.reply(id: id, ok: false, data: ["message": "FitnessSyncer 没有同意这次授权"])
                            return
                        }
                        if got != state {
                            self.reply(id: id, ok: false, data: ["message": "回传校验没对上，再点一次登录授权"])
                            return
                        }
                        self.workQueue.async {
                            let r = self.backend.fsExchangeCode(code)
                            self.reply(id: id, ok: (r["ok"] as? Bool) ?? false, data: r)
                        }
                    }
                }
            }

        case "fsConnect":
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.fsConnect()
                self.reply(id: id, ok: (r["ok"] as? Bool) ?? false, data: r)
            }

        case "folderStats":
            let folder = payload["folder"] as? String ?? ""
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.folderStats(folder: folder)
                self.reply(id: id, ok: (r["ok"] as? Bool) ?? false, data: r)
            }

        case "fsUpload":
            let sourceId = payload["sourceId"] as? String ?? ""
            let folder = payload["folder"] as? String ?? ""
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.fsUpload(sourceId: sourceId, folder: folder) { event in
                    self.sendEvent(event)
                }
                self.reply(id: id, ok: (r["ok"] as? Bool) ?? false, data: r)
            }

        case "destStatus":
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.destStatus()
                self.reply(id: id, ok: (r["ok"] as? Bool) ?? false, data: r)
            }

        case "destPrepare":
            let force = payload["force"] as? Bool ?? false
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.destPrepare(force: force)
                guard (r["ok"] as? Bool) == true else {
                    self.reply(id: id, ok: false, data: r)
                    return
                }
                guard (r["needAuth"] as? Bool) == true else {
                    self.reply(id: id, ok: true, data: r)
                    return
                }
                guard let loc = r["url"] as? String, let url = URL(string: loc) else {
                    self.reply(id: id, ok: false, data: ["message": "授权地址拿不到"])
                    return
                }
                DispatchQueue.main.async {
                    let auth = FsAuthWindow()
                    self.authWindow = auth
                    auth.present(over: self.window, url: url, state: "", destinationMode: true) { res in
                        self.authWindow = nil
                        guard (res["code"] as? String) == "done" else {
                            self.reply(id: id, ok: false, data: ["message": "授权窗口被关掉了，颂拓那边还没登完"])
                            return
                        }
                        self.workQueue.async {
                            var ok = false
                            for _ in 0..<10 {
                                if self.backend.destAuthed() { ok = true; break }
                                usleep(2_000_000)
                            }
                            self.reply(id: id, ok: ok, data: ok
                                ? ["ok": true, "needAuth": false, "message": "颂拓国际已连上"]
                                : ["message": "颂拓那边没走完授权，再点一次「连接颂拓国际」"])
                        }
                    }
                }
            }

        case "destSync":
            workQueue.async { [weak self] in
                guard let self = self else { return }
                let r = self.backend.destSync()
                self.reply(id: id, ok: (r["ok"] as? Bool) ?? false, data: r)
            }

        default:
            reply(id: id, ok: false, data: ["message": "未知指令"])
        }
    }

    private func js(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        let fn = (obj["event"] as? Bool) == true ? "window.__event" : "window.__bridge"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript("\(fn)(\(s))", completionHandler: nil)
        }
    }

    private func reply(id: Int, ok: Bool, data: [String: Any]) {
        js(["id": id, "ok": ok, "data": data])
    }

    private func sendEvent(_ event: [String: Any]) {
        var e = event
        e["event"] = true
        js(e)
    }

    private func fitWindowHeight(_ contentHeight: Double) {
        guard let win = window else { return }
        let visible = (win.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        var target = contentHeight
        if target > Double(visible.height) - 24 { target = Double(visible.height) - 24 }
        if target < 560 { target = 560 }
        var f = win.frame
        if abs(Double(f.size.height) - target) < 8 { return }
        let top = f.origin.y + f.size.height
        f.size.height = CGFloat(target)
        f.origin.y = top - f.size.height
        if f.origin.y < visible.minY { f.origin.y = visible.minY }
        if f.maxY > visible.maxY { f.origin.y = visible.maxY - f.size.height }
        win.setFrame(f, display: true, animate: false)
    }
}

if CommandLine.arguments.contains("--selftest") {
    let b = Backend()
    var out: [String: Any] = [:]
    out["hasSessionCN"] = b.hasSession(region: "cn")
    let tmp = "/tmp/suuntobridge-selftest"
    try? FileManager.default.removeItem(atPath: tmp)
    let r = b.export(region: "cn", folder: tmp, from: 0, to: 0) { e in
        if let t = e["text"] as? String { FileHandle.standardError.write(Data(("[self] " + t + "\n").utf8)) }
    }
    out["export"] = r
    let files = (try? FileManager.default.contentsOfDirectory(atPath: tmp)) ?? []
    out["files"] = files.sorted().prefix(5).map { $0 }
    out["fileCount"] = files.count

    let rangeTmp = "/tmp/suuntobridge-range"
    try? FileManager.default.removeItem(atPath: rangeTmp)
    let fromMs = Date().addingTimeInterval(-40 * 86400).timeIntervalSince1970 * 1000
    out["countAll"] = b.count(region: "cn", from: 0, to: 0)
    out["count40d"] = b.count(region: "cn", from: fromMs, to: 0)
    out["rangeExport"] = b.export(region: "cn", folder: rangeTmp, from: fromMs, to: 0) { _ in }
    if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
        print(String(data: data, encoding: .utf8) ?? "{}")
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

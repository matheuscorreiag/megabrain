import Foundation

// Where the panel lives: this Mac (localhost) or another Mac over Tailscale.
// Defaults can be overridden per launch, e.g. `-localPort 7681` for a test server.
enum Prefs {
  private static var defaults: UserDefaults { .standard }

  static var localURL: URL {
    let port = defaults.integer(forKey: "localPort")
    return URL(string: "http://127.0.0.1:\(port == 0 ? 7680 : port)")!
  }
  static var useRemote: Bool {
    get { defaults.bool(forKey: "useRemote") }
    set { defaults.set(newValue, forKey: "useRemote") }
  }
  static var remoteURL: String {
    get { defaults.string(forKey: "remoteURL") ?? "" }
    set { defaults.set(newValue, forKey: "remoteURL") }
  }
  static var isLocal: Bool { !useRemote || normalized(remoteURL) == nil }
  static var serverURL: URL {
    #if DEBUG
      if let testServerURL { return testServerURL }
    #endif
    return isLocal ? localURL : normalized(remoteURL)!
  }
  #if DEBUG
    static var testServerURL: URL? // the self-test points the app at a dead port
  #endif
  static var launchdLabel: String { defaults.string(forKey: "launchdLabel") ?? "com.matheuscorreiag.megabrain" }

  // Just scheme, host and port: "https://mac.tailnet.ts.net/#abc" → "https://mac.tailnet.ts.net".
  static func normalized(_ text: String) -> URL? {
    guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespaces)),
      parts.scheme == "http" || parts.scheme == "https", parts.host?.isEmpty == false
    else { return nil }
    parts.path = ""
    parts.query = nil
    parts.fragment = nil
    return parts.url
  }
}

struct ServerStatus {
  var reachable = false
  var on = false
  var thisMac = false // only a browser (or this app) on the server's own Mac may turn it on or off
}

// The server's HTTP API, as the pages use it.
final class Server {
  static let shared = Server()
  private(set) var status = ServerStatus()
  var onStatus: ((ServerStatus) -> Void)?

  func refresh(then done: (() -> Void)? = nil) {
    var request = URLRequest(url: Prefs.serverURL.appending(path: "api/config"))
    request.timeoutInterval = 5
    URLSession.shared.dataTask(with: request) { data, response, _ in
      var next = ServerStatus()
      if let data, (response as? HTTPURLResponse)?.statusCode == 200,
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      {
        next = ServerStatus(reachable: true, on: json["on"] as? Bool ?? true, thisMac: json["thisMac"] as? Bool ?? false)
      }
      DispatchQueue.main.async {
        self.status = next
        self.onStatus?(next)
        done?()
      }
    }.resume()
  }

  func setPower(_ on: Bool, then done: (() -> Void)? = nil) {
    var request = URLRequest(url: Prefs.serverURL.appending(path: on ? "api/turn-on" : "api/turn-off"))
    request.httpMethod = "POST"
    request.setValue("1", forHTTPHeaderField: "X-Megabrain")
    URLSession.shared.dataTask(with: request) { _, _, _ in
      DispatchQueue.main.async { self.refresh(then: done) }
    }.resume()
  }

  private var plist: String {
    FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/LaunchAgents/\(Prefs.launchdLabel).plist").path
  }

  // Installed on this Mac (scripts/launchd.sh install)? A copy of the app on
  // another Mac has no server of its own to start.
  var hasService: Bool { FileManager.default.fileExists(atPath: plist) }

  // The process itself stopped (`scripts/launchd.sh stop`): do what `start` does.
  func startService(then done: (() -> Void)? = nil) {
    let label = Prefs.launchdLabel
    let domain = "gui/\(getuid())"
    let plist = plist
    DispatchQueue.global().async {
      Self.run("/bin/launchctl", ["enable", "\(domain)/\(label)"])
      Self.run("/bin/launchctl", ["bootstrap", domain, plist])
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.refresh(then: done) }
    }
  }

  private static func run(_ tool: String, _ args: [String]) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = args
    try? process.run()
    process.waitUntilExit()
  }
}

// The chat list, live: its own socket to /ws/chat (the same broadcast the
// pages get), so notifications and the badge don't depend on the window.
// It never says it's visible, so it never marks a chat read.
final class ChatFeed {
  var onChats: (([[String: Any]]) -> Void)?
  var onDisconnect: (() -> Void)?
  private let session = URLSession(configuration: .default)
  private var task: URLSessionWebSocketTask?
  private var generation = 0
  private var retries = 0

  func start() {
    stop()
    connect()
  }

  func stop() {
    generation += 1
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
  }

  private func connect() {
    guard var parts = URLComponents(url: Prefs.serverURL, resolvingAgainstBaseURL: false) else { return }
    parts.scheme = parts.scheme == "https" ? "wss" : "ws"
    parts.path = "/ws/chat"
    guard let url = parts.url else { return }
    let task = session.webSocketTask(with: url)
    self.task = task
    task.resume()
    receive(task, generation)
  }

  private func receive(_ task: URLSessionWebSocketTask, _ generation: Int) {
    task.receive { [weak self] result in
      DispatchQueue.main.async {
        guard let self, generation == self.generation else { return }
        switch result {
        case .success(let message):
          self.retries = 0
          if case .string(let text) = message, let data = text.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            json["op"] as? String == "chats", let chats = json["chats"] as? [[String: Any]]
          {
            self.onChats?(chats)
          }
          self.receive(task, generation)
        case .failure:
          // Turned off, restarting, asleep or unreachable: back off up to 30 s.
          self.task = nil
          self.onDisconnect?()
          let delay = min(30, pow(2, Double(self.retries)))
          self.retries += 1
          DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            if generation == self.generation { self.connect() }
          }
        }
      }
    }
  }
}

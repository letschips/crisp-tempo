// Crisp Tempo's bridge to macOS Reminders and Calendar (EventKit).
//
// Usage: tempo-apple-helper <command>, with a JSON request on stdin for commands that take one.
// Every run prints one JSON object on stdout: {"ok":true,...} or {"ok":false,"code":"…","message":"…"}.
// Obsidian starts this program, so macOS asks for (and remembers) the permission as Obsidian.
//
// Commands:
//   status                      authorization of Reminders and Calendar
//   request-access              {"reminders":bool,"calendar":bool}; asks for full access where undetermined
//   reminder-lists              lists that hold reminders
//   calendars                   calendars that hold events
//   reminders                   {"lists":[id],"items":[{"id","externalId"}]}: open reminders in the lists,
//                               plus the given items in any state and list; items not found are in "missing"
//   apply-reminders             {"updates":[{"id","externalId","listId"?,"title"?,"notes"?,"due"?,"completed"?,"expect"?}],
//                                "creates":[{"key","listId","title","notes"?,"due"?}]}
//                               an update whose "expect" values no longer match the reminder is refused
//                               with code "changed" (edited elsewhere since it was read)
//   events                      {"from":ms,"to":ms,"calendars":[id]|null}: events overlapping the range

import EventKit
import Foundation

struct HelperError: Error {
  let code: String
  let message: String
}

let store = EKEventStore()

func emit(_ object: [String: Any]) {
  var out = object
  if out["ok"] == nil { out["ok"] = true }
  let data = (try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ error: HelperError) -> Never {
  emit(["ok": false, "code": error.code, "message": error.message])
  exit(1)
}

func readRequest() -> [String: Any] {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  if data.isEmpty { return [:] }
  guard let object = try? JSONSerialization.jsonObject(with: data), let dict = object as? [String: Any] else {
    fail(HelperError(code: "bad_request", message: "The request on stdin is not a JSON object."))
  }
  return dict
}

func authorization(_ type: EKEntityType) -> String {
  switch EKEventStore.authorizationStatus(for: type) {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .fullAccess: return "fullAccess"
  case .writeOnly: return "writeOnly"
  @unknown default: return "unknown"
  }
}

func statusObject() -> [String: Any] {
  ["reminders": authorization(.reminder), "calendar": authorization(.event)]
}

func requireAccess(_ type: EKEntityType) {
  let state = authorization(type)
  if state == "fullAccess" { return }
  let what = type == .reminder ? "Reminders" : "Calendar"
  fail(HelperError(code: state == "notDetermined" ? "not_determined" : "permission_denied",
                   message: "\(what) access is \(state)."))
}

func requestAccess(_ type: EKEntityType) {
  guard authorization(type) == "notDetermined" else { return }
  let done = DispatchSemaphore(value: 0)
  let completion: (Bool, Error?) -> Void = { _, _ in done.signal() }
  if #available(macOS 14.0, *) {
    if type == .reminder {
      store.requestFullAccessToReminders(completion: completion)
    } else {
      store.requestFullAccessToEvents(completion: completion)
    }
  } else {
    store.requestAccess(to: type, completion: completion)
  }
  done.wait()
}

func hexColor(_ cg: CGColor?) -> Any {
  guard let cg, let rgb = cg.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil),
        let c = rgb.components, c.count >= 3 else { return NSNull() }
  let v = c.prefix(3).map { Int((max(0, min(1, $0)) * 255).rounded()) }
  return String(format: "#%02x%02x%02x", v[0], v[1], v[2])
}

func calendarObject(_ calendar: EKCalendar) -> [String: Any] {
  [
    "id": calendar.calendarIdentifier,
    "title": calendar.title,
    "color": hexColor(calendar.cgColor),
    "source": calendar.source?.title ?? "",
    "writable": calendar.allowsContentModifications,
  ]
}

func millis(_ date: Date?) -> Any {
  guard let date else { return NSNull() }
  return Int64((date.timeIntervalSince1970 * 1000).rounded())
}

/// "YYYY-MM-DD" of a reminder's due date in its own components, so a date-only reminder never shifts a day.
func dueString(_ comps: DateComponents?) -> Any {
  guard let comps else { return NSNull() }
  if let y = comps.year, let m = comps.month, let d = comps.day {
    return String(format: "%04d-%02d-%02d", y, m, d)
  }
  guard let date = Calendar.current.date(from: comps) else { return NSNull() }
  let local = Calendar.current.dateComponents([.year, .month, .day], from: date)
  return String(format: "%04d-%02d-%02d", local.year ?? 0, local.month ?? 0, local.day ?? 0)
}

func reminderObject(_ r: EKReminder) -> [String: Any] {
  [
    "id": r.calendarItemIdentifier,
    "externalId": r.calendarItemExternalIdentifier ?? NSNull(),
    "listId": r.calendar?.calendarIdentifier ?? NSNull(),
    "listTitle": r.calendar?.title ?? NSNull(),
    "title": r.title ?? "",
    "notes": r.notes ?? "",
    "due": dueString(r.dueDateComponents),
    "dueHasTime": r.dueDateComponents?.hour != nil,
    "completed": r.isCompleted,
    "completedAt": millis(r.completionDate),
    "modifiedAt": millis(r.lastModifiedDate),
  ]
}

func fetchReminders(_ predicate: NSPredicate) -> [EKReminder] {
  let done = DispatchSemaphore(value: 0)
  var result: [EKReminder] = []
  store.fetchReminders(matching: predicate) { reminders in
    result = reminders ?? []
    done.signal()
  }
  done.wait()
  return result
}

func findReminder(id: String?, externalId: String?, listId: String? = nil) -> EKReminder? {
  // The external identifier is the same on every Mac that syncs the list; the local one is not.
  // It can match more than one item: the local id, then the list the link was in, decide.
  if let externalId, !externalId.isEmpty {
    let matches = store.calendarItems(withExternalIdentifier: externalId).compactMap { $0 as? EKReminder }
    if let found = matches.first(where: { $0.calendarItemIdentifier == id })
      ?? matches.first(where: { listId != nil && $0.calendar?.calendarIdentifier == listId })
      ?? matches.first {
      return found
    }
  }
  if let id, !id.isEmpty, let found = store.calendarItem(withIdentifier: id) as? EKReminder {
    return found
  }
  return nil
}

func strings(_ value: Any?) -> [String] {
  (value as? [Any])?.compactMap { $0 as? String } ?? []
}

func parseDay(_ value: String) -> (Int, Int, Int)? {
  let parts = value.split(separator: "-").compactMap { Int($0) }
  guard parts.count == 3, value.count == 10 else { return nil }
  var probe = DateComponents()
  probe.year = parts[0]; probe.month = parts[1]; probe.day = parts[2]
  guard let date = Calendar(identifier: .gregorian).date(from: probe) else { return nil }
  let back = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: date)
  guard back.year == parts[0], back.month == parts[1], back.day == parts[2] else { return nil }
  return (parts[0], parts[1], parts[2])
}

/// Sets the due day. A time of day the reminder already had is kept; clearing removes the due date.
func setDue(_ reminder: EKReminder, _ value: Any?) throws {
  if value is NSNull {
    reminder.dueDateComponents = nil
    return
  }
  guard let day = value as? String, let (y, m, d) = parseDay(day) else {
    throw HelperError(code: "bad_request", message: "due must be YYYY-MM-DD or null.")
  }
  var comps = reminder.dueDateComponents ?? DateComponents()
  if comps.calendar == nil { comps.calendar = Calendar(identifier: .gregorian) }
  comps.year = y; comps.month = m; comps.day = d
  reminder.dueDateComponents = comps
}

func runReminders(_ request: [String: Any]) {
  requireAccess(.reminder)
  let listIds = Set(strings(request["lists"]))
  let lists = store.calendars(for: .reminder).filter { listIds.contains($0.calendarIdentifier) }
  var byId: [String: [String: Any]] = [:]
  var order: [String] = []
  if !lists.isEmpty {
    let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)
    for r in fetchReminders(predicate) {
      if byId[r.calendarItemIdentifier] == nil { order.append(r.calendarItemIdentifier) }
      byId[r.calendarItemIdentifier] = reminderObject(r)
    }
  }
  var found: [[String: Any]] = []
  var missing: [String] = []
  for item in (request["items"] as? [[String: Any]]) ?? [] {
    let id = item["id"] as? String
    let externalId = item["externalId"] as? String
    if let r = findReminder(id: id, externalId: externalId, listId: item["listId"] as? String) {
      var object = reminderObject(r)
      object["requestedId"] = id ?? NSNull()
      found.append(object)
    } else if let id {
      missing.append(id)
    }
  }
  emit([
    "reminders": order.compactMap { byId[$0] },
    "items": found,
    "missing": missing,
    "lists": lists.map(calendarObject),
  ])
}

func runApplyReminders(_ request: [String: Any]) {
  requireAccess(.reminder)
  var results: [[String: Any]] = []
  for update in (request["updates"] as? [[String: Any]]) ?? [] {
    let id = update["id"] as? String
    guard let reminder = findReminder(id: id, externalId: update["externalId"] as? String, listId: update["listId"] as? String) else {
      results.append(["id": id ?? NSNull(), "ok": false, "code": "missing", "message": "The reminder no longer exists."])
      continue
    }
    if let expect = update["expect"] as? [String: Any] {
      let now = reminderObject(reminder)
      let changed = expect.keys.filter { key in
        let a = expect[key].flatMap { $0 is NSNull ? nil : $0 }
        let b = now[key].flatMap { $0 is NSNull ? nil : $0 }
        switch (a, b) {
        case (nil, nil): return false
        case let (x as String, y as String): return x != y
        case let (x as Bool, y as Bool): return x != y
        default: return true
        }
      }
      if !changed.isEmpty {
        results.append(["id": id ?? NSNull(), "ok": false, "code": "changed",
                        "message": "Changed in Reminders since it was read: \(changed.sorted().joined(separator: ", "))."])
        continue
      }
    }
    do {
      if let title = update["title"] as? String { reminder.title = title }
      if update.keys.contains("notes") {
        let notes = update["notes"] as? String ?? ""
        reminder.notes = notes.isEmpty ? nil : notes
      }
      if update.keys.contains("due") { try setDue(reminder, update["due"]) }
      if let completed = update["completed"] as? Bool { reminder.isCompleted = completed }
      try store.save(reminder, commit: false)
      var object = reminderObject(reminder)
      object["requestedId"] = id ?? NSNull()
      results.append(["id": id ?? NSNull(), "ok": true, "reminder": object])
    } catch let error as HelperError {
      results.append(["id": id ?? NSNull(), "ok": false, "code": error.code, "message": error.message])
    } catch {
      results.append(["id": id ?? NSNull(), "ok": false, "code": "eventkit_error", "message": error.localizedDescription])
    }
  }
  var created: [(String, EKReminder)] = []
  var createResults: [[String: Any]] = []
  for create in (request["creates"] as? [[String: Any]]) ?? [] {
    let key = create["key"] as? String ?? ""
    let listId = create["listId"] as? String
    let list = listId.flatMap { id in store.calendars(for: .reminder).first { $0.calendarIdentifier == id } }
      ?? store.defaultCalendarForNewReminders()
    guard let list else {
      createResults.append(["key": key, "ok": false, "code": "no_list", "message": "No reminder list to add to."])
      continue
    }
    let reminder = EKReminder(eventStore: store)
    reminder.calendar = list
    reminder.title = create["title"] as? String ?? ""
    if let notes = create["notes"] as? String, !notes.isEmpty { reminder.notes = notes }
    do {
      if let due = create["due"], !(due is NSNull) { try setDue(reminder, due) }
      try store.save(reminder, commit: false)
      created.append((key, reminder))
    } catch let error as HelperError {
      createResults.append(["key": key, "ok": false, "code": error.code, "message": error.message])
    } catch {
      createResults.append(["key": key, "ok": false, "code": "eventkit_error", "message": error.localizedDescription])
    }
  }
  do {
    try store.commit()
  } catch {
    fail(HelperError(code: "eventkit_error", message: error.localizedDescription))
  }
  // Identifiers are final only after the commit.
  for (key, reminder) in created {
    createResults.append(["key": key, "ok": true, "reminder": reminderObject(reminder)])
  }
  emit(["updates": results, "creates": createResults])
}

func availabilityName(_ value: EKEventAvailability) -> String {
  switch value {
  case .busy: return "busy"
  case .free: return "free"
  case .tentative: return "tentative"
  case .unavailable: return "unavailable"
  case .notSupported: return "notSupported"
  @unknown default: return "unknown"
  }
}

func statusName(_ value: EKEventStatus) -> String {
  switch value {
  case .none: return "none"
  case .confirmed: return "confirmed"
  case .tentative: return "tentative"
  case .canceled: return "canceled"
  @unknown default: return "unknown"
  }
}

func runEvents(_ request: [String: Any]) {
  requireAccess(.event)
  guard let from = request["from"] as? Double, let to = request["to"] as? Double, to > from else {
    fail(HelperError(code: "bad_request", message: "events needs numeric from < to (ms)."))
  }
  var calendars: [EKCalendar]? = nil
  if let ids = request["calendars"] as? [Any] {
    let wanted = Set(ids.compactMap { $0 as? String })
    calendars = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
    if calendars!.isEmpty {
      emit(["events": []])
      return
    }
  }
  let predicate = store.predicateForEvents(
    withStart: Date(timeIntervalSince1970: from / 1000),
    end: Date(timeIntervalSince1970: to / 1000),
    calendars: calendars)
  let events = store.events(matching: predicate).map { e -> [String: Any] in
    [
      "id": e.calendarItemIdentifier,
      "title": e.title ?? "",
      "start": millis(e.startDate),
      "end": millis(e.endDate),
      "allDay": e.isAllDay,
      "calendarId": e.calendar?.calendarIdentifier ?? NSNull(),
      "calendarTitle": e.calendar?.title ?? NSNull(),
      "color": hexColor(e.calendar?.cgColor),
      "location": e.location ?? NSNull(),
      "availability": availabilityName(e.availability),
      "status": statusName(e.status),
    ]
  }
  emit(["events": events])
}

let args = CommandLine.arguments.dropFirst()
guard let command = args.first else {
  fail(HelperError(code: "bad_request", message: "Missing command."))
}

switch command {
case "status":
  emit(statusObject())
case "request-access":
  let request = readRequest()
  if request["reminders"] as? Bool == true { requestAccess(.reminder) }
  if request["calendar"] as? Bool == true { requestAccess(.event) }
  emit(statusObject())
case "reminder-lists":
  requireAccess(.reminder)
  let lists = store.calendars(for: .reminder)
  emit([
    "lists": lists.map(calendarObject),
    "defaultId": store.defaultCalendarForNewReminders()?.calendarIdentifier ?? NSNull(),
  ])
case "calendars":
  requireAccess(.event)
  emit(["calendars": store.calendars(for: .event).map(calendarObject)])
case "reminders":
  runReminders(readRequest())
case "apply-reminders":
  runApplyReminders(readRequest())
case "events":
  runEvents(readRequest())
case "version":
  emit(["version": 1])
default:
  fail(HelperError(code: "bad_request", message: "Unknown command: \(command)"))
}

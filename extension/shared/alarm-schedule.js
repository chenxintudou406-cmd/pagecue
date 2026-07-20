(function initAlarmSchedule(globalScope) {
  function safeTimezone(timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone || "Asia/Shanghai" }).format(new Date());
      return timezone || "Asia/Shanghai";
    } catch { return "Asia/Shanghai"; }
  }

  function zonedParts(value, timezone) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: safeTimezone(timezone), year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    });
    return Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  }

  function zonedDateToUtc(parts, timezone) {
    const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    let candidate = target;
    for (let index = 0; index < 3; index += 1) {
      const observed = zonedParts(candidate, timezone);
      const observedUtc = Date.UTC(Number(observed.year), Number(observed.month) - 1, Number(observed.day), Number(observed.hour), Number(observed.minute), 0, 0);
      candidate += target - observedUtc;
    }
    return candidate;
  }

  function recurringOccurrence(schedule, afterMs) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(schedule.timeOfDay || ""));
    if (!match) return null;
    const timezone = safeTimezone(schedule.timezone);
    const start = zonedParts(afterMs, timezone);
    const base = Date.UTC(Number(start.year), Number(start.month) - 1, Number(start.day));
    for (let offset = 0; offset < 370; offset += 1) {
      const date = new Date(base + offset * 86_400_000);
      const day = date.getUTCDay();
      const allowed = schedule.mode === "daily" || (schedule.mode === "weekdays" && day >= 1 && day <= 5) || (schedule.mode === "weekly" && (schedule.weekdays || []).map(Number).includes(day));
      if (!allowed) continue;
      const candidate = zonedDateToUtc({
        year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
        hour: Number(match[1]), minute: Number(match[2])
      }, timezone);
      if (candidate > afterMs) return new Date(candidate).toISOString();
    }
    return null;
  }

  function nextAlarmOccurrence(schedule = {}, after = Date.now()) {
    const afterMs = new Date(after).getTime();
    if (!Number.isFinite(afterMs)) return null;
    if (schedule.mode === "once") {
      const triggerMs = Date.parse(schedule.triggerAt || "");
      return Number.isFinite(triggerMs) && triggerMs > afterMs ? new Date(triggerMs).toISOString() : null;
    }
    if (["daily", "weekdays", "weekly"].includes(schedule.mode)) return recurringOccurrence(schedule, afterMs);
    return null;
  }

  const api = { nextAlarmOccurrence };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.PageCueAlarmSchedule = api;
})(typeof globalThis !== "undefined" ? globalThis : self);

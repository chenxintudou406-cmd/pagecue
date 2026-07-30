class ReminderChannelAdapter {
  constructor(name) { this.name = name; }
  isEnabled() { return false; }
  async send() { return { accepted: false, reason: "channel_not_configured" }; }
}

class WeComReminderChannelAdapter extends ReminderChannelAdapter {
  constructor() { super("wecom"); }
}

module.exports = { ReminderChannelAdapter, WeComReminderChannelAdapter };

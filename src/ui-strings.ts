export const ui = {
  start:
    "Hi! I'm your assistant for calendar and email.\n\n" +
    "I can show you what's on your calendar and recent messages from your inbox.\n" +
    "Type /help to see what I understand right now.",

  help:
    "*Available commands*\n\n" +
    "/today — events on your calendar today\n" +
    "/tomorrow — events on your calendar tomorrow\n" +
    "/week — events for the next 7 days\n" +
    "/mail — most recent inbox messages (last hour)\n" +
    "/help — this list\n\n" +
    "More natural language coming soon.",

  unknownCommand:
    "I don't recognise that yet. Type /help for the list of commands.",

  testBadge: "🧪 TEST",
  testModeOn:
    "🧪 Test mode ON. Calendar and mail now use the test Google account (your own). Send /prod to switch back.",
  testModeOff: "Production mode. Calendar and mail use the client's account.",
  testModeUnavailable: "Test mode isn't configured on this bot.",

  noEvents: "Nothing scheduled in this window.",
  noMail: "No new inbox messages in this window.",
  thinking: "Working on it…",
  errorGeneric: "Something went wrong reaching your calendar. Try again in a moment.",
  errorUnauthorized:
    "Lost access to your Google account. The owner needs to re-authorise the Mari credential in n8n.",
};

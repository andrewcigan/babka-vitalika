function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}

export const env = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  n8nWebhookUrl: required("N8N_WEBHOOK_URL"),
  n8nWebhookUrlTest: process.env.N8N_WEBHOOK_URL_TEST,
  n8nWebhookSecret: required("N8N_WEBHOOK_SECRET"),
  databaseUrl: process.env.DATABASE_URL,
  port: Number(optional("PORT", "3000")),
  nodeEnv: optional("NODE_ENV", "production"),
  productTimezone: optional("PRODUCT_TIMEZONE", "America/New_York"),
};

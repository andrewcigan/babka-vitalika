import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { env } from "./env.js";
import { log } from "./logger.js";

export function startHealthServer(): { close: () => Promise<void> } {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/healthz" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "babka-vitalika-bot" }));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(env.port, () => {
    log.info({ port: env.port }, "healthcheck server listening");
  });

  return {
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

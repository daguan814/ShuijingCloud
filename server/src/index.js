import fs from "node:fs";
import http from "node:http";
import https from "node:https";

import { app } from "./app.js";
import { config } from "./config.js";

const useTls =
  config.tlsCert &&
  config.tlsKey &&
  fs.existsSync(config.tlsCert) &&
  fs.existsSync(config.tlsKey);

const server = useTls
  ? https.createServer(
      {
        cert: fs.readFileSync(config.tlsCert),
        key: fs.readFileSync(config.tlsKey),
      },
      app,
    )
  : http.createServer(app);

server.listen(config.port, config.host, () => {
  const protocol = useTls ? "https" : "http";
  console.log(
    `[shuijing-cloud] listening on ${protocol}://${config.host}:${config.port}`,
  );
});

function shutdown(signal) {
  console.log(`[shuijing-cloud] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

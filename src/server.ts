import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { metaDir } from "./metadata.js";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Health check + public files: /disclosure, /meta/<id>.json, /img/<id>.<ext>. No secrets are served. */
export function startServer(port: number, renderDisclosure: () => string): void {
  http
    .createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0];
      try {
        if (url === "/disclosure") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(renderDisclosure());
          return;
        }
        let m: RegExpExecArray | null = /^\/meta\/([a-f0-9]{16})\.json$/.exec(url);
        if (m) {
          const f = path.join(metaDir(), `${m[1]}.json`);
          if (fs.existsSync(f)) {
            res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
            res.end(fs.readFileSync(f));
            return;
          }
        }
        m = /^\/img\/([a-f0-9]{16})\.(png|jpg|jpeg|webp|gif)$/.exec(url);
        if (m) {
          const f = path.join(metaDir(), `${m[1]}.${m[2]}`);
          if (fs.existsSync(f)) {
            res.writeHead(200, { "content-type": MIME[m[2]], "access-control-allow-origin": "*" });
            res.end(fs.readFileSync(f));
            return;
          }
        }
        res.writeHead(url === "/" ? 200 : 404);
        res.end(url === "/" ? "ok" : "not found");
      } catch {
        res.writeHead(500);
        res.end("error");
      }
    })
    .listen(port);
}

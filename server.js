// A link shortener: a long web address in, a short code out, and the code leads back to it.
//
//   POST /shorten        a web address, as JSON { "url": ... } or as plain text; answers { "code": ... }
//   GET  /<code>         302, with the address in Location
//   GET  /stats/<code>   { "code", "url", "count" }: how many times the code was followed
//
// Everything is kept in memory. The same address always gets the same code.
const http = require("http");

const PORT = 3000;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LONGEST_BODY = 64 * 1024;

const byCode = new Map(); // code -> { url, clicks }
const byUrl = new Map(); // url -> code

/** The address as given, if it is a web address; nothing otherwise. */
function webAddress(given) {
  if (typeof given !== "string") return undefined;
  const trimmed = given.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return undefined;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (!parsed.hostname) return undefined;
  return trimmed;
}

/** The next code nobody has yet: counted up, so no two addresses can ever share one. */
function freshCode() {
  let n = byCode.size + 1;
  for (;;) {
    let code = "";
    for (let left = n + 14776336; left > 0; left = Math.floor(left / ALPHABET.length)) code = ALPHABET[left % ALPHABET.length] + code;
    if (!byCode.has(code) && code !== "shorten" && code !== "stats") return code;
    n += 1;
  }
}

function send(response, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  response.end(text);
}

function read(request) {
  return new Promise((resolve, reject) => {
    const pieces = [];
    let size = 0;
    request.on("data", (piece) => {
      size += piece.length;
      if (size > LONGEST_BODY) {
        reject(new Error("too long"));
        request.destroy();
        return;
      }
      pieces.push(piece);
    });
    request.on("end", () => resolve(Buffer.concat(pieces).toString("utf8")));
    request.on("error", reject);
  });
}

/** The address a request to shorten carries: JSON with a url field, or the body itself as plain text. */
function addressIn(body, contentType) {
  const text = body.trim();
  if (/json/i.test(contentType) || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === "object" ? parsed.url : undefined;
    } catch {
      return undefined;
    }
  }
  return text;
}

async function shorten(request, response) {
  let body;
  try {
    body = await read(request);
  } catch {
    return send(response, 413, { error: "that is too long to be a web address" });
  }
  const url = webAddress(addressIn(body, String(request.headers["content-type"] || "")));
  if (url === undefined) return send(response, 400, { error: "that is not a web address" });
  let code = byUrl.get(url);
  if (code === undefined) {
    code = freshCode();
    byCode.set(code, { url, clicks: 0 });
    byUrl.set(url, code);
  }
  return send(response, 200, { code });
}

http.createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/shorten") {
    if (request.method !== "POST") return send(response, 405, { error: "send the address with POST" }, { allow: "POST" });
    return void shorten(request, response);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, { error: "only GET here" }, { allow: "GET" });
  const stats = path.match(/^\/stats\/([^/]+)\/?$/);
  if (stats) {
    const code = decodeURIComponent(stats[1]);
    const kept = byCode.get(code);
    if (!kept) return send(response, 404, { error: "no such code" });
    return send(response, 200, { code, url: kept.url, count: kept.clicks });
  }
  const followed = path.match(/^\/([^/]+)\/?$/);
  const kept = followed ? byCode.get(decodeURIComponent(followed[1])) : undefined;
  if (!kept) return send(response, 404, { error: "no such code" });
  kept.clicks += 1;
  return send(response, 302, undefined, { location: kept.url });
}).listen(PORT);

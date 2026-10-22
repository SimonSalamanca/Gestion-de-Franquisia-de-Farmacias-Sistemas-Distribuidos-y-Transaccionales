import { config } from "./config.mjs";

const MAX_BODY = 100_000;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("payload"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function origenPermitido(req) {
  const origin = req?.headers?.origin;
  if (origin && config.corsOrigins.includes(origin)) return origin;
  return config.corsOrigins[0];
}

export function send(res, status, body) {
  const payload = body && status !== 204 ? JSON.stringify(body) : "";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origenPermitido(res.req),
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export function tokenDe(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

// Router mínimo: rutas exactas o con expresión regular; los grupos capturados llegan en ctx.params.
export function crearRouter() {
  const rutas = [];
  const add = (method) => (path, handler) => rutas.push({ method, path, handler });
  return {
    get: add("GET"),
    post: add("POST"),
    usar(registrar) {
      registrar(this);
      return this;
    },
    buscar(method, pathname) {
      for (const ruta of rutas) {
        if (ruta.method !== method) continue;
        if (typeof ruta.path === "string") {
          if (ruta.path === pathname) return { handler: ruta.handler, params: [] };
        } else {
          const match = pathname.match(ruta.path);
          if (match) return { handler: ruta.handler, params: match.slice(1) };
        }
      }
      return null;
    },
  };
}

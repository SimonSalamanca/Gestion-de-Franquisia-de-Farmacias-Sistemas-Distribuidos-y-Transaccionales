import http from "http";
import { central, local } from "./db.mjs";
import { migrate } from "./migrate.mjs";
import { login, sesionDe, abrirModulo, cerrarSesion, perfil, MODULES } from "./auth.mjs";
import { pullReplica, flushOutbox, probeCentral, link, conectividad, estadoReal, inyectarProbe } from "./sync.mjs";

const port = Number(process.env.PORT || 4000);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
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

function send(res, status, body) {
  const payload = body && status !== 204 ? JSON.stringify(body) : "";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function tokenDe(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, null);
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/conectividad") {
      const conflictos = await local.query("select count(*)::int as n from sync_conflicto where resuelto = false");
      return send(res, 200, { ...conectividad(), conflictos: conflictos.rows[0].n });
    }
    if (req.method === "POST" && url.pathname === "/api/conectividad/simular") {
      const body = await readBody(req);
      if (body.probe != null) {
        const veces = Number(body.veces || 1);
        if (!["ok", "lento", "timeout"].includes(body.probe) || !Number.isInteger(veces) || veces < 1 || veces > 20) {
          return send(res, 400, { mensaje: "Probe no válido" });
        }
        inyectarProbe(body.probe, veces);
      }
      if (body.estado !== undefined) {
        if (![null, "online", "degradado", "offline"].includes(body.estado)) {
          return send(res, 400, { mensaje: "Estado no válido" });
        }
        link.force = body.estado === "online" || body.estado == null ? null : body.estado;
      }
      if (body.probe == null && body.estado === undefined) {
        return send(res, 400, { mensaje: "Nada que simular" });
      }
      return send(res, 200, conectividad());
    }
    if (req.method === "POST" && url.pathname === "/api/sync/ahora") {
      const enviados = (await flushOutbox())?.sent ?? 0;
      const pull = await pullReplica().catch((error) => ({ applied: 0, skipped: true, error: error.message }));
      const cursor = await local.query("select coalesce(max(ultimo_evento_visto), 0)::bigint as cursor from replica_cursor");
      return send(res, 200, {
        enviados,
        aplicados: pull.applied ?? 0,
        skipped: Boolean(pull.skipped),
        cursor: Number(cursor.rows[0]?.cursor || 0),
      });
    }
    if (req.method === "POST" && (url.pathname === "/api/local/auth/login" || url.pathname === "/api/central/auth/login")) {
      const body = await readBody(req);
      const nodo = url.pathname.includes("/local/") ? "local" : "central";
      const result = await login({
        nodo,
        usuario: body.usuario,
        password: body.password,
        idempotencyKey: req.headers["idempotency-key"],
      });
      return send(res, result.status, result.body);
    }
    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const nodo = url.searchParams.get("nodo");
      const sesion = await sesionDe(tokenDe(req), nodo);
      if (!sesion) return send(res, 401, { codigo: "SESION", mensaje: "Sesión inválida o expirada" });
      return send(res, 200, perfil(sesion));
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const body = await readBody(req);
      await cerrarSesion(tokenDe(req), body.nodo);
      return send(res, 204, null);
    }
    const modulo = url.pathname.match(/^\/api\/(local|central)\/modulos\/([A-Z0-9_]+)$/);
    if (req.method === "GET" && modulo) {
      const result = await abrirModulo(tokenDe(req), modulo[1], modulo[2]);
      return send(res, result.status, result.body);
    }
    if (req.method === "GET" && url.pathname === "/api/modulos") {
      return send(res, 200, MODULES);
    }
    return send(res, 404, { mensaje: "Ruta no encontrada" });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    return send(res, status, { mensaje: status === 400 ? "JSON inválido" : "Error interno" });
  }
});

async function ciclo() {
  await probeCentral();
  if (estadoReal() === "offline") return;
  await flushOutbox();
  await pullReplica();
}

await migrate();
await pullReplica().catch((error) => console.error("sync inicial", error.message));
await Promise.all([central.query("select 1"), local.query("select 1")]).catch((error) =>
  console.error("pre-warm", error.message),
);
server.listen(port, () => {
  console.log(`API FarmaHub en http://localhost:${port}`);
});
setInterval(() => {
  ciclo().catch((error) => console.error("sync", error.message));
}, 10000);

process.on("SIGINT", async () => {
  server.close();
  await central.end();
  await local.end();
  process.exit(0);
});

import crypto from "crypto";
import { central, local } from "../apps/api/db.mjs";

const BASE = "http://localhost:4000";
const uuid = () => crypto.randomUUID();
const T0 = Date.now();
const results = [];
const check = (nombre, cond, info = "") => {
  const ok = Boolean(cond);
  results.push({ nombre, ok, info: String(info).slice(400) });
  console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${ok ? "OK    " : "FALLO "} ${nombre}${ok ? "" : ` :: ${String(info).slice(200)}`}`);
};

async function api(method, path, { key, body } = {}) {
  const headers = { "Content-Type": "application/json", "Idempotency-Key": key };
  const res = await fetch(`${BASE}${path}`, { method, headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const { rows: demoRows } = await central.query(
  "select id_empleado, usuario, id_tienda from empleado where usuario in ('cajero1','admin.tienda')",
);
const cajero = demoRows.find((r) => r.usuario === "cajero1");
const adminTienda = demoRows.find((r) => r.usuario === "admin.tienda");

const at = await api("POST", "/api/central/auth/login", { key: uuid(), body: { usuario: "admin.tienda", password: "Farma123" } });
check("doc · admin de tienda no entra a la consola central → 403 SIN_PERMISO_RED", at.status === 403 && at.body?.codigo === "SIN_PERMISO_RED", JSON.stringify(at.body));

const hashGuardada = (await local.query("select contrasena_hash from empleado_ref where id_empleado = $1", [cajero.id_empleado])).rows[0]?.contrasena_hash;
let hashOk = Boolean(hashGuardada);
try {
  await local.query("update empleado_ref set contrasena_hash = null where id_empleado = $1", [cajero.id_empleado]);
  const pend = (await local.query("select count(*)::int as n from outbox_sync where id_empleado = $1 and estado in ('PENDIENTE','ERROR')", [cajero.id_empleado])).rows[0].n;
  const r = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "cajero1", password: "Farma123" } });
  check("doc · hash no replicado → 401 CREDENCIAL_NO_SINCRONIZADA", r.status === 401 && r.body?.codigo === "CREDENCIAL_NO_SINCRONIZADA", JSON.stringify(r.body));
  const pend2 = (await local.query("select count(*)::int as n from outbox_sync where id_empleado = $1 and estado in ('PENDIENTE','ERROR')", [cajero.id_empleado])).rows[0].n;
  check("doc · sin hash no encola eventos de sesión", pend2 === pend, `${pend} → ${pend2}`);
} finally {
  if (hashOk) await local.query("update empleado_ref set contrasena_hash = $2 where id_empleado = $1", [cajero.id_empleado, hashGuardada]);
}
const tras = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "cajero1", password: "Farma123" } });
check("hash restaurado → login vuelve a funcionar", tras.status === 200, JSON.stringify(tras.body).slice(0, 200));

const intentosDesconocido = [];
for (let i = 1; i <= 5; i += 1) {
  const r = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "intruso.nadie", password: "x" } });
  intentosDesconocido.push(r.body?.codigo);
}
check("doc · 5 fallos de usuario desconocido no bloquean ninguna cuenta", intentosDesconocido.every((c) => c === "CREDENCIALES"), intentosDesconocido.join(","));
const bloqueos = (await local.query("select count(*)::int as n from control_acceso where estado = 'BLOQUEADO'")).rows[0].n;
check("sin cuentas bloqueadas por los intentos desconocidos", bloqueos === 0, `pendientes=${bloqueos}`);
const ca = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "cajero1", password: "Farma123" } });
check("cajero1 sigue operativo tras los intentos del intruso", ca.status === 200, JSON.stringify(ca.body).slice(0, 200));

if (!adminTienda) check("admin.tienda existe", false);

const fallidos = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - fallidos.length}/${results.length} pruebas extra OK en ${((Date.now() - T0) / 1000).toFixed(1)} s ===`);
for (const r of fallidos) console.log(`FALLO: ${r.nombre} :: ${r.info}`);
process.exit(fallidos.length === 0 ? 0 : 1);

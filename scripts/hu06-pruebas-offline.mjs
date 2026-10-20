import crypto from "crypto";
import { login, abrirModulo } from "../apps/api/auth.mjs";
import { link } from "../apps/api/sync.mjs";
import { central, local } from "../apps/api/db.mjs";

const uuid = () => crypto.randomUUID();
const T0 = Date.now();
const results = [];
const check = (nombre, cond, info = "") => {
  const ok = Boolean(cond);
  results.push({ nombre, ok, info: String(info).slice(400) });
  console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${ok ? "OK    " : "FALLO "} ${nombre}${ok ? "" : ` :: ${String(info).slice(200)}`}`);
};

async function paso(nombre, fn) {
  try {
    await fn();
  } catch (error) {
    check(nombre, false, `EXCEPCION: ${error.message}`);
  }
}

const { rows: demoRows } = await central.query(
  "select id_empleado, usuario, id_tienda from empleado where usuario in ('cajero1','admin.general')",
);
const cajero = demoRows.find((r) => r.usuario === "cajero1");
const adminGeneral = demoRows.find((r) => r.usuario === "admin.general");

await paso("preparación", async () => {
  for (const id of [cajero.id_empleado, adminGeneral.id_empleado]) {
    for (const pool of [central, local]) {
      await pool.query(
        `insert into control_acceso (id_empleado) values ($1)
         on conflict (id_empleado) do update set estado = 'ACTIVO', bloqueado_hasta = null,
           provisional = false, provisional_hasta = null`,
        [Number(id)],
      );
    }
  }
  console.log("nodo central y local alcanzables al comenzar");
});

let tokenRed = null;
await paso("antes de la caída: sesión de red vigente", async () => {
  const r = await login({ nodo: "central", usuario: "admin.general", password: "Farma123", idempotencyKey: uuid() });
  check("admin.general inicia sesión en la consola central → 200", r.status === 200, JSON.stringify(r.body).slice(0, 300));
  tokenRed = r.body?.token;
});

await paso("cambio a offline", async () => {
  link.estado = "offline";
  link.openedUntil = Date.now() + 120000;
  link.ultimaSync = new Date().toISOString();
});

let tokenCajeroOffline = null;
await paso("consola de red caída", async () => {
  const r = await login({ nodo: "central", usuario: "admin.general", password: "Farma123", idempotencyKey: uuid() });
  check("CA·offline · login central → 503 SIN_CONEXION", r.status === 503 && r.body?.codigo === "SIN_CONEXION", JSON.stringify(r.body));
  check("CA·offline · estado_real offline en la respuesta", r.body?.estado_real === "offline");
  check("CA·offline · hora de última sync incluida", typeof r.body?.ultima_sync === "string" && r.body.ultima_sync.length > 0, r.body?.ultima_sync);
  check("CA·offline · no trae totales en cero", !("tiendas" in (r.body || {})) && !("ventas_red" in (r.body || {})), JSON.stringify(r.body));

  const mod = await abrirModulo(tokenRed, "central", "RED_VISIBILIDAD");
  check("CA·offline · módulo de red con sesión → 503 SIN_CONEXION", mod.status === 503 && mod.body?.codigo === "SIN_CONEXION", JSON.stringify(mod.body).slice(0, 200));
});

await paso("local sigue operando offline", async () => {
  const r = await login({ nodo: "local", usuario: "cajero1", password: "Farma123", idempotencyKey: uuid() });
  check("login local del cajero funciona offline → 200", r.status === 200, JSON.stringify(r.body).slice(0, 300));
  check("login trae tienda y rol automáticamente", Number(r.body?.id_tienda) === Number(cajero.id_tienda) && r.body?.rol === "cajero");
  tokenCajeroOffline = r.body?.token;
  const mod = await abrirModulo(tokenCajeroOffline, "local", "INVENTARIO_CONSULTAR");
  check("módulo de tienda accesible offline → 200", mod.status === 200);
  const denegado = await abrirModulo(tokenCajeroOffline, "local", "RED_VISIBILIDAD");
  check("sin permiso de red sigue 403 (no confunde offline con permiso)", denegado.status === 403, JSON.stringify(denegado.body).slice(0, 200));
  const fila = await local.query(
    "select count(*)::int as n from outbox_sync where id_empleado = $1 and estado in ('PENDIENTE','ERROR')",
    [Number(cajero.id_empleado)],
  );
  check("el intento queda en el outbox para reenvío (no se descarta)", fila.rows[0].n >= 1, `pendientes=${fila.rows[0].n}`);
});

link.estado = "online";
link.openedUntil = 0;

const fallidos = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - fallidos.length}/${results.length} pruebas offline OK en ${((Date.now() - T0) / 1000).toFixed(1)} s ===`);
for (const r of fallidos) console.log(`FALLO: ${r.nombre} :: ${r.info}`);
process.exit(fallidos.length === 0 ? 0 : 1);

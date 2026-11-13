import "./lib/owner.mjs";
import { desactivarTiendaCentral, limpiarConsolidadoTienda } from "./lib/central.mjs";
// Pruebas HTTP de HU-15: las rutas reales de app.mjs (métodos, Idempotency-Key, cuerpo, códigos).
// Complementa probar-hu15.mjs, que llama las funciones directas. ESCRIBE en las bases del .env:
// con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba). Correr con el API detenido.
import crypto from "crypto";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica } = await import("../apps/api/sync.mjs");
const { crearServidor } = await import("../apps/api/app.mjs");

const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}

await migrate();
link.estado = "online";
link.openedUntil = 0;

const server = crearServidor();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function pedir(ruta, { method = "GET", token, key, body, crudo } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers["Idempotency-Key"] = key;
  if (body !== undefined || crudo !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(base + ruta, { method, headers, body: crudo ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { status: r.status, data, headers: r.headers };
}

const NOMBRE = "HU15 HTTP Temporal";
let id = null;
try {
  const admin = await pedir("/api/central/auth/login", {
    method: "POST",
    key: crypto.randomUUID(),
    body: { usuario: "admin.general", password: "Farma123" },
  });
  check("login central", admin.status === 200, String(admin.status));
  const token = admin.data.token;
  const cajero = await pedir("/api/local/auth/login", {
    method: "POST",
    key: crypto.randomUUID(),
    body: { usuario: "cajero1", password: "Farma123" },
  });
  check("login local cajero", cajero.status === 200, String(cajero.status));

  const pre = await pedir("/api/central/tiendas", { method: "OPTIONS" });
  const metodos = pre.headers.get("access-control-allow-methods") || "";
  check("CORS admite PATCH y PUT", pre.status === 204 && metodos.includes("PATCH") && metodos.includes("PUT"), metodos);

  check("sin sesión 401", (await pedir("/api/central/tiendas")).status === 401);
  // El token del POS no es una sesión del central (RNF-01): la consola de red no lo acepta.
  check("token local en central 401", (await pedir("/api/central/tiendas", { token: cajero.data.token })).status === 401);

  const lista = await pedir("/api/central/tiendas", { token });
  check("listar 200", lista.status === 200 && Array.isArray(lista.data.tiendas), String(lista.status));

  const datos = { nombre: NOMBRE, direccion: "Carrera 7 #1-1", ciudad: "Tunja", telefono: "608000" };
  check("alta sin Idempotency-Key 400", (await pedir("/api/central/tiendas", { method: "POST", token, body: datos })).status === 400);
  check(
    "JSON inválido 400",
    (await pedir("/api/central/tiendas", { method: "POST", token, key: crypto.randomUUID(), crudo: "{no json" })).status === 400,
  );
  check(
    "campos obligatorios 400",
    (await pedir("/api/central/tiendas", { method: "POST", token, key: crypto.randomUUID(), body: { nombre: NOMBRE } })).status === 400,
  );

  const key = crypto.randomUUID();
  const alta = await pedir("/api/central/tiendas", { method: "POST", token, key, body: datos });
  check("alta 201", alta.status === 201 && alta.data.tienda?.activa === true, `${alta.status} ${alta.data.mensaje || ""}`);
  id = alta.data.tienda?.id_tienda;
  const repetida = await pedir("/api/central/tiendas", { method: "POST", token, key, body: datos });
  check("reintento HTTP devuelve la misma tienda", repetida.status === 201 && repetida.data.tienda?.id_tienda === id);
  const otraData = await pedir("/api/central/tiendas", { method: "POST", token, key, body: { ...datos, ciudad: "Otra" } });
  check("misma clave con otros datos 409", otraData.status === 409 && otraData.data.codigo === "IDEMPOTENCY_CONFLICT");
  const filas = await central.query("select count(*)::int as n from tienda where nombre = $1 and activa", [NOMBRE]);
  check("una sola fila tras reintentos", filas.rows[0].n === 1, String(filas.rows[0].n));

  const version = alta.data.tienda.version_tienda;
  const edit = await pedir(`/api/central/tiendas/${id}`, {
    method: "PATCH",
    token,
    key: crypto.randomUUID(),
    body: { ...datos, ciudad: "Duitama", version_tienda: version },
  });
  check("PATCH 200", edit.status === 200 && edit.data.tienda.ciudad === "Duitama" && edit.data.tienda.version_tienda === version + 1);
  const vieja = await pedir(`/api/central/tiendas/${id}`, {
    method: "PATCH",
    token,
    key: crypto.randomUUID(),
    body: { ...datos, ciudad: "Sogamoso", version_tienda: version },
  });
  check("PATCH con versión vieja 409", vieja.status === 409 && vieja.data.codigo === "CONFLICTO");
  check(
    "PATCH tienda inexistente 404",
    (await pedir("/api/central/tiendas/999999", { method: "PATCH", token, key: crypto.randomUUID(), body: { ...datos, version_tienda: 1 } })).status === 404,
  );

  const meds = await pedir("/api/central/medicamentos", { token });
  check("medicamentos 200", meds.status === 200 && meds.data.medicamentos.length > 0);
  const idMed = meds.data.medicamentos[0].id_medicamento;
  const umbral = await pedir(`/api/central/tiendas/${id}/umbrales`, {
    method: "PUT",
    token,
    key: crypto.randomUUID(),
    body: { id_medicamento: idMed, stock_minimo: 9, dias_alerta_caducidad: 20 },
  });
  check("PUT umbral 200", umbral.status === 200 && umbral.data.umbral.stock_minimo === 9, umbral.data.mensaje || "");
  check(
    "PUT umbral inválido 400",
    (await pedir(`/api/central/tiendas/${id}/umbrales`, { method: "PUT", token, key: crypto.randomUUID(), body: { id_medicamento: idMed, stock_minimo: -1, dias_alerta_caducidad: 5 } })).status === 400,
  );
  const umbrales = await pedir(`/api/central/tiendas/${id}/umbrales`, { token });
  check("GET umbrales", umbrales.status === 200 && umbrales.data.umbrales.some((u) => u.id_medicamento === idMed && u.stock_minimo === 9));

  await pullReplica();
  const redAntes = await pedir("/api/local/inventario/tiendas", { token: cajero.data.token });
  check("POS ve la tienda nueva tras la réplica", redAntes.status === 200 && JSON.stringify(redAntes.data).includes(NOMBRE));

  const baja = await pedir(`/api/central/tiendas/${id}/desactivar`, {
    method: "POST",
    token,
    key: crypto.randomUUID(),
    body: { version_tienda: edit.data.tienda.version_tienda },
  });
  check("desactivar 200", baja.status === 200 && baja.data.tienda.activa === false);
  const cruce = await pedir(`/api/central/disponibilidad?id_medicamento=${idMed}`, { token });
  check("disponibilidad excluye la desactivada", cruce.status === 200 && !cruce.data.disponibilidad.some((row) => row.id_tienda === id));
  const reporte = await pedir("/api/central/reportes/consolidado", { token });
  check("reporte excluye la desactivada", reporte.status === 200 && !reporte.data.reporte.some((row) => row.id_tienda === id));

  await pullReplica();
  const redDespues = await pedir("/api/local/inventario/tiendas", { token: cajero.data.token });
  check("POS deja de verla tras la réplica", redDespues.status === 200 && !JSON.stringify(redDespues.data).includes(NOMBRE));

  link.estado = "offline";
  const caida = await pedir("/api/central/tiendas", { token });
  check("central offline 503", caida.status === 503 && caida.data.codigo === "SIN_CONEXION");
  link.estado = "online";

  const auditoria = await central.query(
    `select accion from registro_actividad_central where entidad_afectada = 'tienda' and id_entidad_afectada = $1`,
    [id],
  );
  const acciones = new Set(auditoria.rows.map((row) => row.accion));
  check(
    "auditoría de alta, edición, umbral y baja",
    ["TIENDA_CREAR", "TIENDA_EDITAR", "UMBRAL_CONFIGURAR", "TIENDA_DESACTIVAR"].every((accion) => acciones.has(accion)),
    [...acciones].join(","),
  );
  check("ruta desconocida 404", (await pedir("/api/central/tiendas/abc", { token })).status === 404);
} finally {
  link.estado = "online";
  if (id) {
    await limpiarConsolidadoTienda(id);
    await local.query("delete from tienda_ref where id_tienda = $1", [id]);
    await desactivarTiendaCentral(id);
  }
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);

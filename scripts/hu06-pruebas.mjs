import crypto from "crypto";
import { central, local } from "../apps/api/db.mjs";

const BASE = "http://localhost:4000";
const PASSWORD = "Farma123";
const PASSWORD_MALO = "Incorrecto!234";
const uuid = () => crypto.randomUUID();
const T0 = Date.now();
const results = [];

const s = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
const check = (nombre, cond, info = "") => {
  const ok = Boolean(cond);
  results.push({ nombre, ok, info: String(info).slice(400) });
  console.log(`[${s()}s] ${ok ? "OK    " : "FALLO "} ${nombre}${ok ? "" : `  :: ${String(info).slice(200)}`}`);
};

async function api(method, path, { token, key, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers["Idempotency-Key"] = key;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json };
}

async function syncNow() {
  const r = await api("POST", "/api/sync/ahora");
  return r;
}

async function uno(pool, sql, params) {
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
}

async function esperar(condicion, ms = 10000, paso = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await condicion()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, paso));
  }
  return false;
}

async function paso(nombre, fn) {
  const t = Date.now();
  try {
    await fn();
  } catch (error) {
    check(nombre, false, `EXCEPCION: ${error.message}`);
  }
  console.log(`[${s()}s] ----- fin ${nombre} (${((Date.now() - t) / 1000).toFixed(1)})`);
}

const { rows: demoRows } = await central.query(
  "select id_empleado, usuario, id_tienda from empleado where usuario in ('cajero1','admin.tienda','admin.general')",
);
const demo = Object.fromEntries(demoRows.map((r) => [r.usuario, r]));
const cajero = demo.cajero1;
const adminTienda = demo["admin.tienda"];
const adminGeneral = demo["admin.general"];
const ids = [cajero?.id_empleado, adminTienda?.id_empleado, adminGeneral?.id_empleado].filter(Boolean);

await paso("preparación (1 round-trip por nodo)", async () => {
  check("usuarios demo existen en ambas bases", Boolean(cajero && adminTienda && adminGeneral), JSON.stringify(demo));
  if (!(cajero && adminTienda && adminGeneral)) return;
  const lista = ids.map(Number).join(",");
  const resetControl = ids
    .map(
      (id) =>
        `insert into control_acceso (id_empleado) values (${id})` +
        ` on conflict (id_empleado) do update set epoch = 1, intentos_en_epoch = 0, estado = 'ACTIVO',` +
        ` bloqueado_hasta = null, provisional = false, provisional_hasta = null, id_snapshot = 0;`,
    )
    .join("\n");
  await central.query(
    `begin;
${resetControl}
delete from bloqueo_canonico where id_empleado in (${lista});
commit;`,
  );
  await local.query(
    `begin;
${resetControl}
delete from outbox_sync where id_empleado in (${lista});
commit;`,
  );
});

await paso("CA1 sin autenticación", async () => {
  const me = await api("GET", "/api/auth/me?nodo=local");
  check("CA1 · /api/auth/me sin token → 401", me.status === 401, JSON.stringify(me.body));
  const m1 = await api("GET", "/api/local/modulos/INVENTARIO_CONSULTAR");
  check("CA1 · módulo sin token → 401", m1.status === 401, JSON.stringify(m1.body));
  const m2 = await api("GET", "/api/local/modulos/INVENTARIO_CONSULTAR", { token: "token-falso" });
  check("CA1 · módulo con token falso → 401", m2.status === 401, JSON.stringify(m2.body));
});

let tokenCajero = null;
await paso("CA2/CA3 login cajero e idempotencia", async () => {
  await syncNow();
  const k1 = uuid();
  const l1 = await api("POST", "/api/local/auth/login", { key: k1, body: { usuario: "cajero1", password: PASSWORD } });
  check("login local cajero1 → 200", l1.status === 200, JSON.stringify(l1.body).slice(0, 300));
  const permisos = (l1.body?.permisos || []).slice().sort();
  check(
    "CA3 · cajero solo tiene INVENTARIO_CONSULTAR y VENTA_REGISTRAR",
    JSON.stringify(permisos) === JSON.stringify(["INVENTARIO_CONSULTAR", "VENTA_REGISTRAR"]),
    permisos.join(","),
  );
  check(
    "CA2 · login asocia id_tienda y tienda automáticamente",
    Number(l1.body?.id_tienda) === Number(cajero.id_tienda) && Boolean(l1.body?.tienda),
    `${l1.body?.id_tienda} / ${l1.body?.tienda}`,
  );
  check("login trae rol cajero", l1.body?.rol === "cajero", l1.body?.rol);
  tokenCajero = l1.body?.token;

  const tokenHash = crypto.createHash("sha256").update(tokenCajero).digest("hex");
  const sesion = await uno(local, "select nodo_emisor, id_tienda, revocada from sesion_activa where token_hash = $1", [tokenHash]);
  check(
    "CA2 · sesión local con tienda asociada",
    Boolean(sesion) && sesion.nodo_emisor === "local" && !sesion.revocada && Number(sesion.id_tienda) === Number(cajero.id_tienda),
    JSON.stringify(sesion),
  );

  await syncNow();
  const auditoria0 = (await local.query(
    "select count(*)::int as n from registro_actividad where id_empleado = $1 and accion = 'INICIO_SESION'",
    [cajero.id_empleado],
  )).rows[0].n;
  const l2 = await api("POST", "/api/local/auth/login", { key: k1, body: { usuario: "cajero1", password: PASSWORD } });
  check("reintento idempotente devuelve la misma sesión", l2.status === 200 && l2.body?.token === tokenCajero, JSON.stringify(l2.body).slice(0, 300));
  const sesiones = (await local.query("select count(*)::int as n from sesion_activa where token_hash = $1", [tokenHash])).rows[0].n;
  const auditoria1 = (await local.query(
    "select count(*)::int as n from registro_actividad where id_empleado = $1 and accion = 'INICIO_SESION'",
    [cajero.id_empleado],
  )).rows[0].n;
  check("reintento no duplica sesiones ni auditoría", sesiones === 1 && auditoria1 === auditoria0, `sesiones=${sesiones} auditoria=${auditoria0}->${auditoria1}`);

  const l3 = await api("POST", "/api/local/auth/login", { key: k1, body: { usuario: "cajero1", password: "OTRA_PASSWORD" } });
  check("misma clave con otro payload → 409", l3.status === 409, JSON.stringify(l3.body));
  const sesionesTras409 = (await local.query("select count(*)::int as n from sesion_activa where token_hash = $1", [tokenHash])).rows[0].n;
  check("409 no escribe nada", sesionesTras409 === 1, `sesiones=${sesionesTras409}`);
});

await paso("CA3/CA4 módulos del cajero", async () => {
  const m1 = await api("GET", "/api/local/modulos/INVENTARIO_CONSULTAR", { token: tokenCajero });
  check("cajero abre INVENTARIO_CONSULTAR → 200", m1.status === 200, JSON.stringify(m1.body).slice(0, 200));
  const m2 = await api("GET", "/api/local/modulos/VENTA_REGISTRAR", { token: tokenCajero });
  check("cajero abre VENTA_REGISTRAR → 200", m2.status === 200);
  const m3 = await api("GET", "/api/local/modulos/CAJA_CERRAR", { token: tokenCajero });
  check("CA4 · cajero no abre CAJA_CERRAR → 403", m3.status === 403 && m3.body?.codigo === "ACCESO_DENEGADO", JSON.stringify(m3.body));
  const audit = (await local.query(
    "select count(*)::int as n from registro_actividad where id_empleado = $1 and accion = 'ACCESO_DENEGADO'",
    [cajero.id_empleado],
  )).rows[0].n;
  check("CA4 · rechazo por rol queda en auditoría", audit >= 1, `registros=${audit}`);
  const m4 = await api("GET", "/api/local/modulos/RED_VISIBILIDAD", { token: tokenCajero });
  check("cajero no ve módulos de red → 403", m4.status === 403, JSON.stringify(m4.body));
});

await paso("cierre de sesión", async () => {
  const lout = await api("POST", "/api/auth/logout", { token: tokenCajero, body: { nodo: "local" } });
  check("logout → 204", lout.status === 204);
  const me = await api("GET", "/api/auth/me?nodo=local", { token: tokenCajero });
  check("token revocado → 401", me.status === 401, JSON.stringify(me.body));
});

await paso("CA3 admin de tienda", async () => {
  const at = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "admin.tienda", password: PASSWORD } });
  check("admin.tienda login local → 200", at.status === 200, JSON.stringify(at.body).slice(0, 300));
  const esperados = ["CAJA_CERRAR", "EMPLEADO_GESTIONAR", "FACTURA_ANULAR", "INVENTARIO_CONSULTAR", "PRECIO_GESTIONAR", "VENTA_REGISTRAR"];
  const permisos = (at.body?.permisos || []).slice().sort();
  check("admin.tienda tiene exactamente sus 6 permisos", JSON.stringify(permisos) === JSON.stringify(esperados), permisos.join(","));
  const tok = at.body?.token;
  const caja = await api("GET", "/api/local/modulos/CAJA_CERRAR", { token: tok });
  check("admin.tienda abre cierre de caja → 200", caja.status === 200);
  const red = await api("GET", "/api/local/modulos/RED_VISIBILIDAD", { token: tok });
  check("admin.tienda no ve módulos de red → 403", red.status === 403, JSON.stringify(red.body));
  await syncNow();
});

await paso("CA3 admin general y consola central", async () => {
  const cajeroCentral = await api("POST", "/api/central/auth/login", { key: uuid(), body: { usuario: "cajero1", password: PASSWORD } });
  check(
    "cajero no entra a la consola central → 403 SIN_PERMISO_RED",
    cajeroCentral.status === 403 && cajeroCentral.body?.codigo === "SIN_PERMISO_RED",
    JSON.stringify(cajeroCentral.body),
  );
  const ag = await api("POST", "/api/central/auth/login", { key: uuid(), body: { usuario: "admin.general", password: PASSWORD } });
  check("admin.general login central → 200", ag.status === 200, JSON.stringify(ag.body).slice(0, 300));
  const permisos = ag.body?.permisos || [];
  check(
    "admin.general tiene permisos de red",
    permisos.includes("RED_VISIBILIDAD") && permisos.includes("RED_CONTROL") && permisos.length >= 10,
    permisos.join(","),
  );
  const tok = ag.body?.token;
  const v1 = await api("GET", "/api/central/modulos/RED_VISIBILIDAD", { token: tok });
  check("admin.general abre vista de red → 200", v1.status === 200);
  const v2 = await api("GET", "/api/central/modulos/RED_CONTROL", { token: tok });
  check("admin.general abre control de red → 200", v2.status === 200);
  const me = await api("GET", "/api/auth/me?nodo=central", { token: tok });
  check("sesión central relee permisos en /me → 200", me.status === 200 && (me.body?.permisos || []).includes("RED_CONTROL"), JSON.stringify(me.body).slice(0, 200));
  await syncNow();
});

await paso("alineación de epoch antes del bloqueo", async () => {
  await syncNow();
  const ok = await esperar(async () => {
    const c = await uno(central, "select epoch, estado from control_acceso where id_empleado = $1", [cajero.id_empleado]);
    const l = await uno(local, "select epoch, estado from control_acceso where id_empleado = $1", [cajero.id_empleado]);
    return Boolean(c && l && Number(c.epoch) === Number(l.epoch) && c.estado === "ACTIVO" && l.estado === "ACTIVO");
  });
  check("epoch sincronizado entre nodos antes del bloqueo", ok === true);
});

await paso("usuario desconocido", async () => {
  const dl = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "nadie.nadie", password: "x" } });
  check("usuario desconocido local → 401", dl.status === 401, JSON.stringify(dl.body));
  const intento = await uno(
    local,
    "select resultado from intento_acceso where usuario_intentado = 'nadie.nadie' and resultado = 'DESCONOCIDO' order by id_intento desc limit 1",
  );
  check("desconocido queda en intento_acceso local", Boolean(intento));
  const auditLocal = (await local.query(
    "select count(*)::int as n from registro_actividad where accion = 'INTENTO_FALLIDO' and id_empleado is null",
  )).rows[0].n;
  check("desconocido no escribe en registro_actividad local", auditLocal === 0, `n=${auditLocal}`);
  const dc = await api("POST", "/api/central/auth/login", { key: uuid(), body: { usuario: "nadie.nadie", password: "x" } });
  check("usuario desconocido central → 401", dc.status === 401);
  const auditCentral = (await central.query(
    "select count(*)::int as n from registro_actividad_central where accion = 'INTENTO_FALLIDO' and id_empleado is null",
  )).rows[0].n;
  check("desconocido central queda en auditoría con empleado nulo", auditCentral >= 1, `n=${auditCentral}`);
});

await paso("CA5 bloqueo por 5 intentos fallidos (lote en un round-trip)", async () => {
  const resultados = [];
  for (let i = 1; i <= 5; i += 1) {
    const r = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "cajero1", password: PASSWORD_MALO } });
    resultados.push(r);
  }
  const primeros = resultados.slice(0, 4);
  const quinto = resultados[4];
  check(
    "los primeros 4 fallos → 401 CREDENCIALES",
    primeros.every((r) => r.status === 401 && r.body?.codigo === "CREDENCIALES"),
    JSON.stringify(primeros.map((r) => r.body?.codigo)),
  );
  check(
    "CA5 · el 5º fallo bloquea la cuenta",
    quinto.status === 401 && quinto.body?.codigo === "CUENTA_BLOQUEADA",
    JSON.stringify(quinto.body),
  );
  check(
    "CA5 · bloqueo con fecha ~15 min y marca provisional",
    Boolean(quinto.body?.bloqueado_hasta) && quinto.body?.provisional === true,
    JSON.stringify(quinto.body),
  );
  const estadoLocal = await uno(local, "select estado, provisional, bloqueado_hasta, epoch from control_acceso where id_empleado = $1", [cajero.id_empleado]);
  check("local: control_acceso BLOQUEADO provisional", estadoLocal?.estado === "BLOQUEADO" && estadoLocal?.provisional === true, JSON.stringify(estadoLocal));
  const audit = (await local.query(
    "select count(*)::int as n from registro_actividad where id_empleado = $1 and accion = 'CUENTA_BLOQUEADA'",
    [cajero.id_empleado],
  )).rows[0].n;
  check("bloqueo queda en auditoría", audit >= 1, `n=${audit}`);
  const activas = (await local.query(
    "select count(*)::int as n from sesion_activa where id_empleado = $1 and revocada = false",
    [cajero.id_empleado],
  )).rows[0].n;
  check("bloqueo revoca sesiones activas locales", activas === 0, `n=${activas}`);
  const correcto = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "cajero1", password: PASSWORD } });
  check("con contraseña correcta sigue bloqueada", correcto.status === 401 && correcto.body?.codigo === "CUENTA_BLOQUEADA", JSON.stringify(correcto.body));

  await syncNow();
  await syncNow();
  const ep = Number(estadoLocal.epoch);
  const converge = await esperar(async () => {
    const c = await uno(central, "select estado from control_acceso where id_empleado = $1", [cajero.id_empleado]);
    const canon = await uno(central, "select count(*)::int as n from bloqueo_canonico where id_empleado = $1 and epoch = $2", [cajero.id_empleado, ep]);
    const l = await uno(local, "select provisional, epoch from control_acceso where id_empleado = $1", [cajero.id_empleado]);
    return Boolean(c && c.estado === "BLOQUEADO" && canon && canon.n === 1 && l && l.provisional === false && Number(l.epoch) === ep);
  });
  check("bloqueo canónico único en central y propagado al local (en segundos)", converge === true, `epoch base=${ep}`);
});

await paso("expiración del bloqueo y reconexión", async () => {
  await local.query(
    "update control_acceso set bloqueado_hasta = now() - interval '2 seconds' where id_empleado = $1",
    [cajero.id_empleado],
  );
  const sesion = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "cajero1", password: PASSWORD } });
  check("vencido el bloqueo, el login correcto entra", sesion.status === 200, JSON.stringify(sesion.body).slice(0, 300));
  await syncNow();
  await syncNow();
  const converge = await esperar(async () => {
    const c = await uno(central, "select epoch, estado from control_acceso where id_empleado = $1", [cajero.id_empleado]);
    const l = await uno(local, "select epoch, estado from control_acceso where id_empleado = $1", [cajero.id_empleado]);
    const outbox = await uno(local, "select count(*)::int as n from outbox_sync where id_empleado = $1 and estado in ('PENDIENTE','ERROR')", [cajero.id_empleado]);
    return Boolean(c && l && c.estado === "ACTIVO" && l.estado === "ACTIVO" && Number(l.epoch) >= 3 && outbox && outbox.n === 0);
  });
  check("tras sync el outbox del empleado queda vacío y la cuenta activa", converge === true);
  const c = await uno(central, "select epoch, estado, bloqueado_hasta from control_acceso where id_empleado = $1", [cajero.id_empleado]);
  const l = await uno(local, "select epoch, estado, bloqueado_hasta, provisional from control_acceso where id_empleado = $1", [cajero.id_empleado]);
  check(
    "epoch y estado coinciden en ambos nodos tras la sync",
    Boolean(c && l && Number(c.epoch) === Number(l.epoch) && c.estado === l.estado && c.bloqueado_hasta === l.bloqueado_hasta && l.provisional === false),
    JSON.stringify({ central: c, local: l }),
  );
});

await paso("usuario duplicado en local", async () => {
  try {
    const rol = await uno(local, "select id_rol from rol_ref where nombre = 'cajero'");
    await local.query("drop index if exists empleado_ref_usuario_key");
    await local.query(
      `insert into empleado_ref (id_empleado, id_rol, id_tienda, nombre_completo, usuario, activo, contrasena_hash, version_credencial)
       values (999999, $1, $2, 'Duplicado Prueba', 'cajero1', true, 'scrypt$aa$bb', 1)`,
      [rol.id_rol, cajero.id_tienda],
    );
    const dup = await api("POST", "/api/local/auth/login", { key: uuid(), body: { usuario: "cajero1", password: PASSWORD } });
    check("usuario duplicado → 409 CONFLICTO_REPLICA y no abre sesión", dup.status === 409 && dup.body?.codigo === "CONFLICTO_REPLICA", JSON.stringify(dup.body));
  } finally {
    await local.query("delete from empleado_ref where id_empleado = 999999");
    await local.query("create unique index if not exists empleado_ref_usuario_key on empleado_ref (usuario)");
  }
});

await paso("endpoint /api/sync/ahora", async () => {
  const r = await api("POST", "/api/sync/ahora");
  check(
    "sync on-demand responde enviados/aplicados/cursor",
    r.status === 200 && r.body && "enviados" in r.body && "aplicados" in r.body && "cursor" in r.body,
    JSON.stringify(r.body),
  );
});

const fallidos = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - fallidos.length}/${results.length} pruebas OK en ${((Date.now() - T0) / 1000).toFixed(1)} s ===`);
for (const r of fallidos) console.log(`FALLO: ${r.nombre} :: ${r.info}`);
process.exit(fallidos.length === 0 ? 0 : 1);

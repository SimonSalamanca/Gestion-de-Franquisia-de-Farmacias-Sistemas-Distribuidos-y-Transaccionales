import crypto from "crypto";
import { central, local, runtime, withTx } from "./db.mjs";
import { payloadHmac, verifyPassword } from "./crypto.mjs";
import { centralAlcanzable, estadoReal, link } from "./sync.mjs";
import { ErrorNegocio } from "./errores.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLE_LABEL = {
  cajero: "Cajero",
  administrador_tienda: "Administrador de tienda",
  administrador_general: "Administrador general",
};

export const MODULES = {
  INVENTARIO_CONSULTAR: { titulo: "Inventario", ambito: "tienda", texto: "Búsqueda de medicamentos y existencias en esta tienda y en la red." },
  INVENTARIO_GESTIONAR: { titulo: "Lotes y recepción", ambito: "tienda", texto: "Registro de lotes, recepción de pedidos y ajustes con historial." },
  VENTA_REGISTRAR: { titulo: "Ventas", ambito: "tienda", texto: "Registro de venta y facturación en el punto de venta." },
  FACTURA_ANULAR: { titulo: "Anulaciones", ambito: "tienda", texto: "Anulación o devolución con motivo obligatorio." },
  PRECIO_GESTIONAR: { titulo: "Precios", ambito: "tienda", texto: "Precio vigente e historial. No altera facturas ya emitidas." },
  EMPLEADO_GESTIONAR: { titulo: "Empleados", ambito: "tienda", texto: "Cuentas y roles de la tienda." },
  CAJA_CERRAR: { titulo: "Cierre de caja", ambito: "tienda", texto: "Total por método de pago comparado con el efectivo contado." },
  RED_VISIBILIDAD: { titulo: "Vista de red", ambito: "red", texto: "Inventario, ventas e ingresos consolidados. No es tiempo real estricto." },
  RED_CONTROL: { titulo: "Control de red", ambito: "red", texto: "Alta, edición y umbrales de las tiendas de la cadena." },
  TIENDA_GESTIONAR: { titulo: "Tiendas", ambito: "red", texto: "Registro y configuración de sucursales." },
  REPORTE_CONSOLIDADO_VER: { titulo: "Reportes de red", ambito: "red", texto: "Comparativo entre tiendas y exportación." },
};

const NODE = {
  local: {
    pool: local,
    empleado: "empleado_ref",
    rol: "rol_ref",
    permiso: "permiso_ref",
    rolPermiso: "rol_permiso_ref",
    tienda: "tienda_ref",
    actividad: "registro_actividad",
    actividadEmpleadoNullable: false,
  },
  central: {
    pool: central,
    empleado: "empleado",
    rol: "rol",
    permiso: "permiso",
    rolPermiso: "rol_permiso",
    tienda: "tienda",
    actividad: "registro_actividad_central",
    actividadEmpleadoNullable: true,
  },
};

function fail(status, codigo, mensaje, extra = {}) {
  return { status, body: { codigo, mensaje, ...extra } };
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function derivedUuid(key, salt) {
  const bytes = Buffer.from(crypto.createHash("sha256").update(`${key}:${salt}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function permisosDe(client, node, idEmpleado) {
  const result = await client.query(
    `select r.nombre as rol, p.codigo
     from ${node.empleado} e
     join ${node.rol} r on r.id_rol = e.id_rol
     join ${node.rolPermiso} rp on rp.id_rol = e.id_rol
     join ${node.permiso} p on p.id_permiso = rp.id_permiso
     where e.id_empleado = $1
     order by p.codigo`,
    [idEmpleado],
  );
  return {
    rol: result.rows[0]?.rol || null,
    permisos: result.rows.map((row) => row.codigo),
  };
}

async function auditar(client, node, idEmpleado, accion, detalle) {
  if (!idEmpleado && !node.actividadEmpleadoNullable) return;
  await client.query(
    `insert into ${node.actividad} (id_empleado, accion, entidad_afectada, detalle)
     values ($1, $2, 'sesion', $3)`,
    [idEmpleado, accion, String(detalle || "").slice(0, 400)],
  );
}

async function guardar(client, key, hmac, result, token) {
  await client.query(
    `insert into auth_operacion (idempotency_key, payload_hmac, resultado_http, cuerpo_json, token_entrega)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (idempotency_key) do nothing`,
    [key, hmac, result.status, JSON.stringify(result.body), token || null],
  );
  return result;
}

async function controlDe(client, idEmpleado) {
  await client.query("insert into control_acceso (id_empleado) values ($1) on conflict do nothing", [idEmpleado]);
  const result = await client.query(
    `select *,
            (estado = 'BLOQUEADO' and bloqueado_hasta is not null and bloqueado_hasta > now()) as sigue_bloqueado,
            (estado = 'BLOQUEADO' and bloqueado_hasta is not null and bloqueado_hasta <= now()) as expiro
     from control_acceso
     where id_empleado = $1
     for update`,
    [idEmpleado],
  );
  return result.rows[0];
}

function payloadAuth(empleado, estado, extra = {}) {
  return {
    id_empleado: empleado.id_empleado,
    version_credencial_observada: Number(empleado.version_credencial || 1),
    epoch_observado: Number(estado.epoch || 1),
    ...extra,
  };
}

async function encolar(client, idEmpleado, tipo, key, payload) {
  await client.query(
    `insert into outbox_sync (id_empleado, idempotency_key, tipo_evento, payload)
     values ($1, $2, $3, $4::jsonb)
     on conflict (idempotency_key) do nothing`,
    [idEmpleado, key, tipo, JSON.stringify(payload)],
  );
}

async function fold(client, empleado, tipo, key, payload) {
  const result = await client.query("select fold_evento($1, $2, $3, $4::jsonb) as r", [
    empleado.id_tienda,
    key,
    tipo,
    JSON.stringify(payload),
  ]);
  return result.rows[0].r;
}

async function fallosLocales(client, idEmpleado, epoch, intentosCanon) {
  const result = await client.query(
    `select
       count(*) filter (where estado in ('PENDIENTE', 'ERROR'))::int as unsent,
       count(*) filter (where estado = 'ENVIADO')::int as sent
     from outbox_sync
     where id_empleado = $1
       and tipo_evento = 'FAIL'
       and coalesce((payload->>'epoch_observado')::bigint, $2) = $2`,
    [idEmpleado, epoch],
  );
  const sent = Number(result.rows[0].sent || 0);
  const unsent = Number(result.rows[0].unsent || 0);
  return Math.max(Number(intentosCanon || 0), sent) + unsent;
}

async function politicaDe(client) {
  const result = await client.query(
    "select intentos_maximos, minutos_bloqueo from politica_acceso where id = 1",
  );
  if (result.rowCount !== 1) throw Object.assign(new Error("politica_acceso"), { status: 500 });
  return {
    intentos: Number(result.rows[0].intentos_maximos),
    minutos: Number(result.rows[0].minutos_bloqueo),
  };
}

async function bloquearProvisional(client, idEmpleado, minutos) {
  const result = await client.query(
    `update control_acceso
     set estado = 'BLOQUEADO',
         bloqueado_hasta = now() + make_interval(mins => $2),
         provisional = true,
         provisional_hasta = null
     where id_empleado = $1
     returning bloqueado_hasta`,
    [idEmpleado, minutos],
  );
  await client.query("update sesion_activa set revocada = true where id_empleado = $1 and revocada = false", [idEmpleado]);
  return result.rows[0].bloqueado_hasta;
}

function bloqueo(hasta, provisional) {
  const valor = iso(hasta);
  return fail(401, "CUENTA_BLOQUEADA", `cuenta bloqueada hasta ${valor}`, {
    bloqueado_hasta: valor,
    provisional: Boolean(provisional),
  });
}

function redEstado() {
  return {
    estado_real: estadoReal(),
    forzado: link.force,
    ultima_sync: link.ultimaSync,
  };
}

export async function login({ nodo, usuario, password, idempotencyKey }) {
  const node = NODE[nodo];
  if (!node) return fail(404, "NODO", "Nodo no disponible");
  const key = Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey;
  if (!key) return fail(400, "IDEMPOTENCY", "Falta Idempotency-Key");
  if (!UUID_RE.test(String(key))) return fail(400, "IDEMPOTENCY", "Idempotency-Key no es UUID");
  if (nodo === "central" && estadoReal() === "offline") {
    return fail(503, "SIN_CONEXION", "sin conexión con el nodo central", redEstado());
  }

  const usuarioLimpio = String(usuario || "").trim();
  const hmac = payloadHmac(usuarioLimpio, `login:${nodo}`, runtime.tiendaId, String(password || ""));

  return withTx(node.pool, async (client) => {
    const previo = await client.query("select * from auth_operacion where idempotency_key = $1", [key]);
    if (previo.rowCount > 0) {
      if (previo.rows[0].payload_hmac !== hmac) {
        return fail(409, "IDEMPOTENCY_CONFLICT", "La clave ya se usó con otros datos");
      }
      const body = { ...previo.rows[0].cuerpo_json };
      if (previo.rows[0].token_entrega) body.token = previo.rows[0].token_entrega;
      return { status: previo.rows[0].resultado_http, body };
    }

    if (!usuarioLimpio || usuarioLimpio.length > 60) {
      return guardar(client, key, hmac, fail(401, "CREDENCIALES", "credenciales inválidas"));
    }

    const encontrados = await client.query(
      `select id_empleado, id_rol, id_tienda, nombre_completo, usuario, activo, contrasena_hash,
              version_credencial, fecha_baja
       from ${node.empleado}
       where usuario = $1`,
      [usuarioLimpio],
    );
    if (encontrados.rowCount > 1) {
      return guardar(client, key, hmac, fail(409, "CONFLICTO_REPLICA", "Conflicto de réplica: usuario duplicado"));
    }
    if (encontrados.rowCount === 0) {
      await client.query(
        `insert into intento_acceso (idempotency_key, usuario_intentado, resultado, detalle)
         values ($1, $2, 'DESCONOCIDO', 'usuario no replicado en este nodo')
         on conflict (idempotency_key) do nothing`,
        [key, usuarioLimpio],
      );
      if (node.actividadEmpleadoNullable) {
        await auditar(client, node, null, "INTENTO_FALLIDO", "usuario desconocido");
      }
      return guardar(client, key, hmac, fail(401, "CREDENCIALES", "credenciales inválidas"));
    }

    const empleado = encontrados.rows[0];
    if (nodo === "local" && Number(empleado.id_tienda) !== Number(runtime.tiendaId)) {
      return guardar(client, key, hmac, fail(409, "CONFLICTO_REPLICA", "El empleado no pertenece a esta tienda"));
    }
    if (!empleado.contrasena_hash) {
      return guardar(client, key, hmac, fail(401, "CREDENCIAL_NO_SINCRONIZADA", "credenciales no disponibles en esta tienda"));
    }
    if (!empleado.activo || empleado.fecha_baja) {
      await auditar(client, node, empleado.id_empleado, "INTENTO_FALLIDO", "cuenta inactiva");
      return guardar(client, key, hmac, fail(401, "CUENTA_INACTIVA", "cuenta inactiva"));
    }

    const estado = await controlDe(client, empleado.id_empleado);
    if (estado.sigue_bloqueado) {
      return guardar(client, key, hmac, bloqueo(estado.bloqueado_hasta, estado.provisional));
    }

    const ok = verifyPassword(password, empleado.contrasena_hash);
    if (!ok) {
      const epoch = Number(estado.epoch);
      const politica = await politicaDe(client);
      const previos = nodo === "local" ? await fallosLocales(client, empleado.id_empleado, epoch, estado.intentos_en_epoch) : Number(estado.intentos_en_epoch);
      const payload = payloadAuth(empleado, estado, { observo_expiracion: Boolean(estado.expiro) });
      if (nodo === "local") {
        await encolar(client, empleado.id_empleado, "FAIL", key, payload);
        if (previos + 1 >= politica.intentos) {
          const hasta = await bloquearProvisional(client, empleado.id_empleado, politica.minutos);
          await auditar(client, node, empleado.id_empleado, "CUENTA_BLOQUEADA", "quinto intento fallido");
          return guardar(client, key, hmac, bloqueo(hasta, true));
        }
      } else {
        const folded = await fold(client, empleado, "FAIL", key, payload);
        if (folded?.bloqueado) {
          await auditar(client, node, empleado.id_empleado, "CUENTA_BLOQUEADA", "quinto intento fallido");
          return guardar(client, key, hmac, bloqueo(folded.bloqueado_hasta, false));
        }
        if (folded?.ya_bloqueado) {
          return guardar(client, key, hmac, bloqueo(folded.bloqueado_hasta, false));
        }
      }
      await auditar(client, node, empleado.id_empleado, "INTENTO_FALLIDO", "credenciales inválidas");
      await client.query(
        `insert into intento_acceso (idempotency_key, usuario_intentado, id_empleado, resultado)
         values ($1, $2, $3, 'INTENTO_FALLIDO')
         on conflict (idempotency_key) do nothing`,
        [key, usuarioLimpio, empleado.id_empleado],
      );
      return guardar(client, key, hmac, fail(401, "CREDENCIALES", "credenciales inválidas"));
    }

    const acceso = await permisosDe(client, node, empleado.id_empleado);
    if (nodo === "central" && !acceso.permisos.some((codigo) => codigo === "RED_VISIBILIDAD" || codigo === "RED_CONTROL")) {
      await auditar(client, node, empleado.id_empleado, "ACCESO_DENEGADO", "consola de red sin permiso");
      return guardar(
        client,
        key,
        hmac,
        fail(403, "SIN_PERMISO_RED", "Esta consola es solo para la administración de la red. Use el punto de venta de su tienda."),
      );
    }

    const payload = payloadAuth(empleado, estado, { observo_expiracion: Boolean(estado.expiro) });
    if (nodo === "local") {
      if (estado.expiro) await encolar(client, empleado.id_empleado, "EXPIRADO", derivedUuid(key, "expirado"), payload);
      else await encolar(client, empleado.id_empleado, "SUCCESS", key, payload);
    } else if (estado.expiro) {
      await fold(client, empleado, "EXPIRADO", derivedUuid(key, "expirado"), payload);
    } else {
      const folded = await fold(client, empleado, "SUCCESS", key, payload);
      if (folded?.sin_reset) {
        return guardar(client, key, hmac, bloqueo(folded.bloqueado_hasta, false));
      }
    }

    const tokenPair = crypto.randomBytes(32).toString("base64url");
    const hash = crypto.createHash("sha256").update(tokenPair).digest("hex");
    const sesion = await client.query(
      `insert into sesion_activa (id_sesion, token_hash, id_empleado, id_tienda, nodo_emisor, expira_en)
       values ($1, $2, $3, $4, $5, now() + interval '12 hours')
       returning expira_en`,
      [crypto.randomUUID(), hash, empleado.id_empleado, empleado.id_tienda, nodo],
    );
    await auditar(client, node, empleado.id_empleado, "INICIO_SESION", `nodo ${nodo}`);
    const tienda = await client.query(`select nombre from ${node.tienda} where id_tienda = $1`, [empleado.id_tienda]);
    const body = {
      id_empleado: empleado.id_empleado,
      id_tienda: empleado.id_tienda,
      tienda: tienda.rows[0]?.nombre || "Tienda",
      nombre: empleado.nombre_completo,
      usuario: empleado.usuario,
      rol: acceso.rol,
      rol_etiqueta: ROLE_LABEL[acceso.rol] || acceso.rol,
      permisos: acceso.permisos,
      expira_en: iso(sesion.rows[0].expira_en),
      nodo,
      ...redEstado(),
    };
    const stored = { ...body };
    body.token = tokenPair;
    await guardar(client, key, hmac, { status: 200, body: stored }, tokenPair);
    return { status: 200, body };
  });
}

export async function sesionDe(token, nodo) {
  const node = NODE[nodo];
  if (!token || !node) return null;
  const pool = node.pool;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const result = await pool.query(
    `select s.id_sesion, s.id_empleado, s.id_tienda, s.expira_en, e.nombre_completo, e.usuario, t.nombre as tienda
     from sesion_activa s
     join ${node.empleado} e on e.id_empleado = s.id_empleado
     join ${node.tienda} t on t.id_tienda = s.id_tienda
     where s.token_hash = $1
       and s.nodo_emisor = $2
       and s.revocada = false
       and s.expira_en > now()
       and e.activo = true
       and e.fecha_baja is null`,
    [hash, nodo],
  );
  const row = result.rows[0];
  if (!row) return null;
  const acceso = await pool.query(
    `select r.nombre as rol, p.codigo
     from ${node.empleado} e
     join ${node.rol} r on r.id_rol = e.id_rol
     join ${node.rolPermiso} rp on rp.id_rol = e.id_rol
     join ${node.permiso} p on p.id_permiso = rp.id_permiso
     where e.id_empleado = $1
     order by p.codigo`,
    [row.id_empleado],
  );
  return {
    ...row,
    nodo,
    rol: acceso.rows[0]?.rol,
    rol_etiqueta: ROLE_LABEL[acceso.rows[0]?.rol] || acceso.rows[0]?.rol,
    permisos: acceso.rows.map((item) => item.codigo),
  };
}

export async function abrirModulo(token, nodo, codigo) {
  const sesion = await sesionDe(token, nodo);
  if (!sesion) return fail(401, "SESION", "Sesión inválida o expirada");
  const modulo = MODULES[codigo];
  if (!modulo) return fail(404, "MODULO", "Módulo no existe");
  const node = NODE[nodo];
  const pool = node.pool;
  if (!sesion.permisos.includes(codigo)) {
    await pool.query(
      `insert into ${node.actividad} (id_empleado, accion, entidad_afectada, detalle)
       values ($1, 'ACCESO_DENEGADO', 'modulo', $2)`,
      [sesion.id_empleado, codigo.slice(0, 400)],
    );
    return fail(403, "ACCESO_DENEGADO", "Su rol no puede abrir este módulo");
  }
  if (modulo.ambito === "red" && !centralAlcanzable()) {
    return fail(503, "SIN_CONEXION", "sin conexión con el nodo central", redEstado());
  }
  return {
    status: 200,
    body: {
      codigo,
      titulo: modulo.titulo,
      texto: modulo.texto,
      ambito: modulo.ambito,
      tienda: sesion.tienda,
      rol: sesion.rol_etiqueta,
    },
  };
}

// Para rutas de negocio: relee sesión y permiso en cada request (RNF-01). Sin sesión, 401;
// sin permiso, 403 y queda ACCESO_DENEGADO en la auditoría del nodo, antes de cualquier mutación.
export async function autorizar(token, nodo, codigo) {
  const sesion = await sesionDe(token, nodo);
  if (!sesion) throw new ErrorNegocio(401, "SESION", "Sesión inválida o expirada");
  if (!sesion.permisos.includes(codigo)) {
    await NODE[nodo].pool.query(
      `insert into ${NODE[nodo].actividad} (id_empleado, accion, entidad_afectada, detalle)
       values ($1, 'ACCESO_DENEGADO', 'modulo', $2)`,
      [sesion.id_empleado, codigo.slice(0, 400)],
    );
    throw new ErrorNegocio(403, "ACCESO_DENEGADO", "Su rol no tiene permiso para esta acción");
  }
  return sesion;
}

export async function cerrarSesion(token, nodo) {
  if (!token || !NODE[nodo]) return { status: 204, body: {} };
  const pool = NODE[nodo].pool;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await pool.query("update sesion_activa set revocada = true where token_hash = $1", [hash]);
  return { status: 204, body: {} };
}

export function perfil(sesion) {
  return {
    id_empleado: sesion.id_empleado,
    id_tienda: sesion.id_tienda,
    tienda: sesion.tienda,
    nombre: sesion.nombre_completo,
    usuario: sesion.usuario,
    rol: sesion.rol,
    rol_etiqueta: sesion.rol_etiqueta,
    permisos: sesion.permisos,
    nodo: sesion.nodo,
    ...redEstado(),
  };
}

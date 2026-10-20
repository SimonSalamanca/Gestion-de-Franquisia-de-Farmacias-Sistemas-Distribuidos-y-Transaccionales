import { central, local, runtime } from "./db.mjs";

export const link = {
  force: null,
  estado: "online",
  failures: 0,
  openedUntil: 0,
  ultimaSync: null,
  probing: false,
  ultimoProbe: null,
};

export function estadoReal() {
  return link.estado;
}

export function centralAlcanzable() {
  return link.estado !== "offline";
}

export function conectividad() {
  return {
    estado_real: estadoReal(),
    estado: estadoReal(),
    forzado: link.force,
    breaker_abierto: Date.now() < link.openedUntil,
    ultima_sync: link.ultimaSync,
    probe_fallos: link.failures,
    ultimo_probe: link.ultimoProbe,
  };
}

function aplicarResultadoProbe(resultado) {
  if (resultado === "ok" || resultado === "lento") {
    link.failures = 0;
    link.openedUntil = 0;
    link.estado = resultado === "lento" ? "degradado" : "online";
    link.ultimoProbe = link.estado;
    link.ultimaSync = new Date().toISOString();
    return;
  }
  link.failures += 1;
  link.ultimoProbe = "timeout";
  if (link.failures >= 5 || link.estado === "offline") {
    link.estado = "offline";
    link.openedUntil = Date.now() + 30000;
    if (link.failures >= 5) link.failures = 0;
  }
}

export function inyectarProbe(resultado, veces = 1) {
  for (let i = 0; i < veces; i += 1) aplicarResultadoProbe(resultado);
  return conectividad();
}

export async function probeCentral() {
  if (link.probing || Date.now() < link.openedUntil) return estadoReal();
  link.probing = true;
  const started = Date.now();
  const query = central.query("select 1");
  try {
    const first = await Promise.race([
      query.then(() => "ok"),
      new Promise((resolve) => setTimeout(() => resolve("slow"), 3000)),
    ]);
    if (first === "slow") {
      await Promise.race([
        query,
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { timeout: true })), 5000)),
      ]);
      aplicarResultadoProbe("lento");
    } else {
      aplicarResultadoProbe(Date.now() - started > 3000 ? "lento" : "ok");
    }
  } catch {
    aplicarResultadoProbe("timeout");
  } finally {
    link.probing = false;
  }
  return estadoReal();
}

async function dejarConflicto(client, idEmpleado, tipo, detalle) {
  await client.query(
    `insert into sync_conflicto (id_empleado, tipo, detalle) values ($1, $2, $3)`,
    [idEmpleado, tipo, String(detalle || "").slice(0, 400)],
  );
}

async function applyEvent(client, event, idTienda) {
  const payload = event.payload;
  if (event.tipo_evento === "TIENDA_UPSERT") {
    await client.query(
      `insert into tienda_ref (id_tienda, nombre, activa, es_tienda_local)
       values ($1, $2, $3, $4)
       on conflict (id_tienda) do update
       set nombre = excluded.nombre, activa = excluded.activa, es_tienda_local = excluded.es_tienda_local`,
      [payload.id_tienda, payload.nombre, payload.activa, Number(payload.id_tienda) === Number(idTienda)],
    );
    return;
  }
  if (event.tipo_evento === "ROL_UPSERT") {
    await client.query(
      `insert into rol_ref (id_rol, nombre) values ($1, $2)
       on conflict (id_rol) do update set nombre = excluded.nombre`,
      [payload.id_rol, payload.nombre],
    );
    return;
  }
  if (event.tipo_evento === "PERMISO_UPSERT") {
    await client.query(
      `insert into permiso_ref (id_permiso, codigo, descripcion) values ($1, $2, $3)
       on conflict (id_permiso) do update set codigo = excluded.codigo, descripcion = excluded.descripcion`,
      [payload.id_permiso, payload.codigo, payload.descripcion],
    );
    return;
  }
  if (event.tipo_evento === "ROL_PERMISO_SET") {
    await client.query("delete from rol_permiso_ref where id_rol = $1", [payload.id_rol]);
    for (const permiso of payload.permisos || []) {
      await client.query(
        `insert into permiso_ref (id_permiso, codigo) values ($1, $2)
         on conflict (id_permiso) do update set codigo = excluded.codigo`,
        [permiso.id_permiso, permiso.codigo],
      );
      await client.query(
        "insert into rol_permiso_ref (id_rol, id_permiso) values ($1, $2) on conflict do nothing",
        [payload.id_rol, permiso.id_permiso],
      );
    }
    return;
  }
  if (event.tipo_evento === "EMPLEADO_UPSERT") {
    const current = await client.query(
      "select version_credencial from empleado_ref where id_empleado = $1",
      [payload.id_empleado],
    );
    if (current.rowCount > 0 && Number(event.version_credencial) < Number(current.rows[0].version_credencial)) {
      await dejarConflicto(
        client,
        payload.id_empleado,
        "VERSION",
        `empleado version ${event.version_credencial} < local ${current.rows[0].version_credencial}`,
      );
      return;
    }
    const fuera = Number(payload.id_tienda) !== Number(idTienda);
    await client.query(
      `insert into empleado_ref (
         id_empleado, id_rol, id_tienda, nombre_completo, usuario, activo, contrasena_hash, version_credencial, fecha_baja
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id_empleado) do update set
         id_rol = excluded.id_rol,
         id_tienda = excluded.id_tienda,
         nombre_completo = excluded.nombre_completo,
         usuario = excluded.usuario,
         activo = excluded.activo,
         contrasena_hash = excluded.contrasena_hash,
         version_credencial = excluded.version_credencial,
         fecha_baja = excluded.fecha_baja`,
      [
        payload.id_empleado,
        payload.id_rol,
        payload.id_tienda,
        payload.nombre_completo,
        payload.usuario,
        fuera ? false : payload.activo,
        fuera ? null : payload.contrasena_hash,
        payload.version_credencial,
        payload.fecha_baja || null,
      ],
    );
    if (fuera || payload.activo === false || payload.fecha_baja) {
      await client.query("update sesion_activa set revocada = true where id_empleado = $1 and revocada = false", [
        payload.id_empleado,
      ]);
    }
    return;
  }
  if (event.tipo_evento === "CONTROL_ACCESO_SNAPSHOT") {
    const row = await client.query(
      `select c.id_snapshot, c.epoch, c.provisional, c.bloqueado_hasta, e.version_credencial,
              (c.provisional and c.bloqueado_hasta > now()) as provisional_vigente
       from empleado_ref e
       left join control_acceso c on c.id_empleado = e.id_empleado
       where e.id_empleado = $1`,
      [payload.id_empleado],
    );
    if (row.rowCount === 0) return;
    const localRow = row.rows[0];
    if (localRow.id_snapshot != null && Number(payload.id_snapshot) <= Number(localRow.id_snapshot)) return;
    if (Number(event.version_credencial) < Number(localRow.version_credencial)) {
      await dejarConflicto(
        client,
        payload.id_empleado,
        "VERSION",
        `snapshot ${payload.id_snapshot} version ${event.version_credencial} < local ${localRow.version_credencial}`,
      );
      return;
    }
    if (
      localRow.provisional_vigente &&
      payload.estado === "ACTIVO" &&
      Number(payload.epoch) === Number(localRow.epoch)
    ) {
      return;
    }
    await client.query(
      `insert into control_acceso (id_empleado, epoch, intentos_en_epoch, estado, bloqueado_hasta, provisional, provisional_hasta, id_snapshot)
       values ($1, $2, $3, $4, $5, false, null, $6)
       on conflict (id_empleado) do update set
         epoch = excluded.epoch,
         intentos_en_epoch = excluded.intentos_en_epoch,
         estado = excluded.estado,
         bloqueado_hasta = excluded.bloqueado_hasta,
         provisional = false,
         provisional_hasta = null,
         id_snapshot = excluded.id_snapshot`,
      [
        payload.id_empleado,
        payload.epoch,
        payload.intentos_en_epoch,
        payload.estado,
        payload.bloqueado_hasta,
        payload.id_snapshot,
      ],
    );
    return;
  }
  if (event.tipo_evento === "SESION_REVOCAR") {
    await client.query("update sesion_activa set revocada = true where id_empleado = $1 and revocada = false", [
      payload.id_empleado,
    ]);
  }
}

export async function pullReplica(idTienda = runtime.tiendaId) {
  if (!centralAlcanzable()) return { applied: 0, skipped: true };
  const cursor = await local.query("select ultimo_evento_visto from replica_cursor where id_tienda = $1", [idTienda]);
  let seen = Number(cursor.rows[0]?.ultimo_evento_visto || 0);
  const events = await central.query(
    `select id_evento, id_tienda_destino, tipo_evento, version_credencial, payload
     from replica_evento
     where id_evento > $1
     order by id_evento`,
    [seen],
  );
  const client = await local.connect();
  let applied = 0;
  try {
    await client.query("begin");
    for (const event of events.rows) {
      if (Number(event.id_evento) !== seen + 1) break;
      const destino = event.id_tienda_destino;
      if (destino == null || Number(destino) === Number(idTienda)) {
        await applyEvent(client, event, idTienda);
        applied += 1;
      }
      seen = Number(event.id_evento);
    }
    await client.query(
      `insert into replica_cursor (id_tienda, ultimo_evento_visto, ultimo_ack_en)
       values ($1, $2, now())
       on conflict (id_tienda) do update
       set ultimo_evento_visto = excluded.ultimo_evento_visto, ultimo_ack_en = now()`,
      [idTienda, seen],
    );
    await client.query("commit");
    link.ultimaSync = new Date().toISOString();
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { applied, cursor: seen };
}

function escLiteral(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export async function flushOutbox(idTienda = runtime.tiendaId) {
  if (!centralAlcanzable()) return { sent: 0 };
  const allPending = await local.query(
    `select id_outbox, id_empleado, tipo_evento, idempotency_key, payload, (proximo_intento <= now()) as vencio
     from outbox_sync
     where estado in ('PENDIENTE', 'ERROR')
     order by id_outbox`,
  );
  const headManejado = new Set();
  const continuable = new Set();
  const enviables = [];
  for (const event of allPending.rows) {
    const empKey = event.id_empleado == null ? "null" : String(event.id_empleado);
    const due = event.vencio === true;
    if (!headManejado.has(empKey)) {
      headManejado.add(empKey);
      if (due) {
        enviables.push(event);
        continuable.add(empKey);
      }
    } else if (continuable.has(empKey) && due) {
      enviables.push(event);
    } else {
      continuable.delete(empKey);
    }
  }
  if (enviables.length === 0) return { sent: 0 };
  try {
    const sql = enviables
      .map(
        (event) =>
          `select fold_evento(${Number(idTienda)}, ${escLiteral(event.idempotency_key)}, ${escLiteral(event.tipo_evento)}, ${escLiteral(JSON.stringify(event.payload))}::jsonb);`,
      )
      .join("\n");
    await central.query(sql);
    await local.query(
      "update outbox_sync set estado = 'ENVIADO' where id_outbox = any($1::bigint[])",
      [enviables.map((event) => Number(event.id_outbox))],
    );
    return { sent: enviables.length };
  } catch {
    const bloqueados = new Set();
    let sent = 0;
    for (const event of enviables) {
      const empKey = event.id_empleado == null ? "null" : String(event.id_empleado);
      if (bloqueados.has(empKey)) continue;
      try {
        await central.query("select fold_evento($1, $2, $3, $4::jsonb)", [
          idTienda,
          event.idempotency_key,
          event.tipo_evento,
          JSON.stringify(event.payload),
        ]);
        await local.query("update outbox_sync set estado = 'ENVIADO' where id_outbox = $1", [event.id_outbox]);
        sent += 1;
      } catch {
        await local.query(
          `update outbox_sync
           set intentos = intentos + 1,
               proximo_intento = now() + (least(60, power(2, intentos))::int * interval '1 second'),
               estado = case when intentos + 1 >= 20 then 'ERROR' else 'PENDIENTE' end
           where id_outbox = $1`,
          [event.id_outbox],
        );
        bloqueados.add(empKey);
      }
    }
    return { sent };
  }
}

// HU-04: umbrales de stock y de aviso de caducidad. Regla: ningún medicamento activo opera sin umbral en una tienda
// activa (trigger diferido en db/central/09_hu04_umbrales.sql). Estas funciones corren en el central, dentro de la
// transacción del llamador.

export const UMBRAL_DEFECTO = { stock_minimo: 10, dias_alerta_caducidad: 30 };

// Crea el umbral que falte para cada medicamento activo y tienda activa (o solo para `idTienda`). Un umbral existente
// no se toca. `especificos` permite fijar valores distintos al defecto: [{ tienda, codigo, minimo, dias }].
// Devuelve las filas creadas; publicarUmbralesPendientes las envía a las tiendas.
export async function completarUmbrales(client, { idTienda = null, especificos = [], defecto = UMBRAL_DEFECTO } = {}) {
  const creados = await client.query(
    `insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad)
     select t.id_tienda, m.id_medicamento,
            coalesce(e.minimo, $2::int), coalesce(e.dias, $3::int)
     from tienda t
     cross join medicamento m
     left join jsonb_to_recordset($4::jsonb) as e(tienda int, codigo varchar, minimo int, dias int)
            on e.tienda = t.id_tienda and e.codigo = m.codigo_interno
     where t.activa and m.activo and ($1::int is null or t.id_tienda = $1)
     on conflict (id_tienda, id_medicamento) do nothing
     returning id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad`,
    [idTienda, defecto.stock_minimo, defecto.dias_alerta_caducidad, JSON.stringify(especificos)],
  );
  return creados.rows;
}

// Publica a cada tienda los umbrales del central que todavía no tienen evento de réplica (los demo, los cargados a mano
// y los que crea una tienda nueva). Va después de los medicamentos: umbral_stock_ref depende de medicamento_ref.
export async function publicarUmbralesPendientes(client) {
  const pendientes = await client.query(
    `select u.id_tienda, u.id_medicamento, u.stock_minimo, u.dias_alerta_caducidad
     from umbral_stock u
     where not exists (
       select 1 from replica_evento r
       where r.tipo_evento = 'UMBRAL_UPSERT'
         and (r.payload ->> 'id_tienda')::integer = u.id_tienda
         and (r.payload ->> 'id_medicamento')::integer = u.id_medicamento
     )
     order by u.id_tienda, u.id_medicamento`,
  );
  for (const umbral of pendientes.rows) {
    await client.query("select append_replica_evento($1, 'UMBRAL_UPSERT', 1, $2::jsonb)", [umbral.id_tienda, JSON.stringify(umbral)]);
  }
  return pendientes.rowCount;
}

// Medicamentos activos que no tienen umbral en alguna tienda activa: los que la regla de HU-04 no permite.
export async function medicamentosSinUmbral(db) {
  const r = await db.query(
    `select m.id_medicamento, m.codigo_interno, m.nombre_comercial,
            array_agg(t.id_tienda order by t.id_tienda) as tiendas_sin_umbral,
            coalesce((select sum(ic.cantidad_disponible) from inventario_consolidado ic where ic.id_medicamento = m.id_medicamento), 0)::int as unidades_en_red
     from medicamento m
     cross join tienda t
     where m.activo and t.activa
       and not exists (select 1 from umbral_stock u where u.id_tienda = t.id_tienda and u.id_medicamento = m.id_medicamento)
     group by m.id_medicamento, m.codigo_interno, m.nombre_comercial
     order by m.codigo_interno`,
  );
  return r.rows;
}

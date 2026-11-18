-- Esquema del Nodo Local (tienda) (43 tablas)
-- Generado desde la base que crean los scripts db/local/00..20 (modelo relacional refinado, docs/modelo-datos/relaciones.md).
-- Fuente de verdad del esquema: db/<nodo>/*.sql (los aplica apps/api/migrate.mjs). Este archivo es una foto para consulta.


\restrict pbyxJ2NiIttfoTXxCE3t751729vkTgsNZEq3ejrbd0QtYc1IPuYwpgwm0HWitt6

-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';

-- Name: anulacion_periodo_caja(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.anulacion_periodo_caja() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_periodo integer;
BEGIN
    SELECT periodo INTO v_periodo FROM periodo_caja WHERE estado <> 'CERRADO' FOR SHARE;
    IF NOT FOUND THEN
        SELECT periodo INTO v_periodo FROM periodo_caja WHERE estado <> 'CERRADO' FOR SHARE;
    END IF;
    IF v_periodo IS NULL THEN
        RAISE EXCEPTION 'PERIODO_CAJA: no hay periodo vigente' USING ERRCODE = '23514';
    END IF;
    NEW.periodo_caja := v_periodo;
    RETURN NEW;
END;
$$;

-- Name: anulacion_valida(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.anulacion_valida() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_estado text;
BEGIN
    SELECT estado INTO v_estado FROM factura WHERE id_factura = NEW.id_factura FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'La factura % no existe', NEW.id_factura USING ERRCODE = '23503';
    END IF;
    IF v_estado = 'ANULADA' THEN
        RAISE EXCEPTION 'FACTURA_ANULADA: la factura ya fue anulada' USING ERRCODE = '23514';
    END IF;
    IF NEW.tipo = 'ANULACION_TOTAL' AND EXISTS (SELECT 1 FROM anulacion_devolucion WHERE id_factura = NEW.id_factura) THEN
        RAISE EXCEPTION 'FACTURA_CON_DEVOLUCIONES: la factura ya tiene devoluciones, no se puede anular completa' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- Name: auditoria_inmutable(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.auditoria_inmutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.fecha_hora < now()::timestamp - interval '2 years' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'La auditoría no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

-- Name: caja_inmutable(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.caja_inmutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'Un cierre de caja registrado no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

-- Name: cierre_caja_integro(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.cierre_caja_integro() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_calculado numeric;
    v_con_diferencia integer;
    v_incoherentes integer;
BEGIN
    SELECT coalesce(sum(total_calculado_sistema), 0),
           count(*) FILTER (WHERE diferencia <> 0),
           count(*) FILTER (WHERE total_calculado_sistema <> vendido - devuelto OR diferencia <> total_reportado_empleado - total_calculado_sistema)
      INTO v_calculado, v_con_diferencia, v_incoherentes
      FROM cierre_caja_metodo_pago
     WHERE id_cierre = NEW.id_cierre;

    IF v_incoherentes > 0 OR v_calculado <> NEW.total_sistema THEN
        RAISE EXCEPTION 'CIERRE_INCOHERENTE: los métodos de pago del cierre % no suman su total o sus diferencias no cuadran', NEW.id_cierre USING ERRCODE = '23514';
    END IF;
    IF (v_con_diferencia > 0) <> (NEW.estado = 'CON_DIFERENCIA') THEN
        RAISE EXCEPTION 'CIERRE_INCOHERENTE: el estado del cierre % no corresponde a sus diferencias', NEW.id_cierre USING ERRCODE = '23514';
    END IF;
    IF v_con_diferencia > 0 AND char_length(btrim(coalesce(NEW.justificacion, ''))) < 10 THEN
        RAISE EXCEPTION 'CIERRE_SIN_JUSTIFICACION: un cierre con diferencia necesita su justificación' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

-- Name: detalle_factura_exige_receta(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.detalle_factura_exige_receta() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_med integer;
    v_nombre text;
    v_requiere boolean;
    v_cliente_factura integer;
    v_receta record;
BEGIN
    SELECT m.id_medicamento, m.nombre_comercial, m.requiere_receta
      INTO v_med, v_nombre, v_requiere
      FROM lote l
      JOIN medicamento_ref m ON m.id_medicamento = l.id_medicamento
     WHERE l.id_lote = NEW.id_lote;
    IF NOT FOUND OR NOT v_requiere THEN
        RETURN NEW;
    END IF;

    IF NEW.id_receta IS NULL THEN
        RAISE EXCEPTION 'RECETA_REQUERIDA: % requiere receta médica', v_nombre USING ERRCODE = '23514';
    END IF;

    SELECT r.fecha_emision, r.id_cliente, r.origen, r.codigo_receta, r.reservada_hasta,
           rm.cantidad_autorizada, rm.cantidad_dispensada
      INTO v_receta
      FROM receta r
      JOIN receta_medicamento rm ON rm.id_receta = r.id_receta AND rm.id_medicamento = v_med
     WHERE r.id_receta = NEW.id_receta
       FOR UPDATE OF rm;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RECETA_INVALIDA: la receta % no incluye %', NEW.id_receta, v_nombre USING ERRCODE = '23514';
    END IF;

    IF v_receta.origen = 'CENTRAL' THEN
        IF v_receta.reservada_hasta IS NULL OR v_receta.reservada_hasta < now()::timestamp THEN
            RAISE EXCEPTION 'RECETA_RESERVA_VENCIDA: la reserva de la receta % terminó; valídela de nuevo con el central', NEW.id_receta
                USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM detalle_factura d WHERE d.id_receta = NEW.id_receta AND d.id_factura <> NEW.id_factura) THEN
            RAISE EXCEPTION 'RECETA_RECLAMADA: la receta % ya se dispensó en otra factura', NEW.id_receta USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NOT (SELECT permitir_registro_manual FROM politica_sistema WHERE id = 1) THEN
            RAISE EXCEPTION 'RECETA_MANUAL_NO_PERMITIDA: un medicamento controlado exige una receta validada con el central'
                USING ERRCODE = '23514';
        END IF;
        IF NOT receta_vigente(v_receta.fecha_emision) THEN
            RAISE EXCEPTION 'RECETA_VENCIDA: la receta % no está vigente', NEW.id_receta USING ERRCODE = '23514';
        END IF;
    END IF;

    SELECT id_cliente INTO v_cliente_factura FROM factura WHERE id_factura = NEW.id_factura;
    IF v_cliente_factura IS DISTINCT FROM v_receta.id_cliente THEN
        RAISE EXCEPTION 'RECETA_CLIENTE: la receta % es de otro paciente', NEW.id_receta USING ERRCODE = '23514';
    END IF;

    IF v_receta.cantidad_dispensada + NEW.cantidad > v_receta.cantidad_autorizada THEN
        RAISE EXCEPTION 'RECETA_SALDO: la receta % autoriza % de % y ya se dispensaron %',
            NEW.id_receta, v_receta.cantidad_autorizada, v_nombre, v_receta.cantidad_dispensada USING ERRCODE = '23514';
    END IF;

    UPDATE receta_medicamento
       SET cantidad_dispensada = cantidad_dispensada + NEW.cantidad
     WHERE id_receta = NEW.id_receta AND id_medicamento = v_med;

    IF v_receta.origen = 'CENTRAL' THEN
        INSERT INTO outbox_sync (id_empleado, idempotency_key, tipo_evento, payload)
        VALUES (
            NULL, gen_random_uuid(), 'RECETA_DISPENSADA',
            jsonb_build_object(
                'codigo', v_receta.codigo_receta,
                'id_medicamento', v_med,
                'cantidad', NEW.cantidad,
                'id_factura', NEW.id_factura,
                'dispensado_en', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

-- Name: devolucion_linea_valida(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.devolucion_linea_valida() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_factura integer;
    v_vendida integer;
    v_previa bigint;
BEGIN
    SELECT id_factura INTO v_factura FROM anulacion_devolucion WHERE id_anulacion = NEW.id_anulacion;
    PERFORM 1 FROM factura WHERE id_factura = v_factura FOR UPDATE;
    SELECT cantidad INTO v_vendida FROM detalle_factura WHERE id_factura = v_factura AND id_lote = NEW.id_lote;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DEVOLUCION_LINEA: el lote % no pertenece a la factura', NEW.id_lote USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(dd.cantidad_devuelta), 0) INTO v_previa
      FROM detalle_devolucion dd JOIN anulacion_devolucion a ON a.id_anulacion = dd.id_anulacion
     WHERE a.id_factura = v_factura AND dd.id_lote = NEW.id_lote;
    IF v_previa + NEW.cantidad_devuelta > v_vendida THEN
        RAISE EXCEPTION 'DEVOLUCION_EXCEDE: se vendieron % y ya se devolvieron %', v_vendida, v_previa USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- Name: evaluar_alertas(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.evaluar_alertas() RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_medicamentos integer[];
    v_bloqueados integer;
    v_nuevas integer;
    v_resueltas integer;
BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtext('hu04_evaluar_alertas')) THEN
        RETURN jsonb_build_object('omitido', true);
    END IF;

    WITH candidatos AS (
        SELECT id_lote FROM lote
         WHERE fecha_caducidad < current_date AND estado = 'DISPONIBLE'
         ORDER BY id_lote
         FOR NO KEY UPDATE SKIP LOCKED
    ), bloqueados AS (
        UPDATE lote l SET estado = 'BLOQUEADO'
          FROM candidatos c
         WHERE l.id_lote = c.id_lote
        RETURNING l.id_lote, l.id_medicamento, l.numero_lote, l.cantidad_disponible
    ), auditoria AS (
        INSERT INTO registro_actividad (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
        SELECT NULL, 'LOTE_BLOQUEO_AUTOMATICO', 'lote', b.id_lote,
               left('Lote ' || b.numero_lote || ' vencido; ' || b.cantidad_disponible || ' unidad(es) bloqueadas para la venta', 400)
          FROM bloqueados b
        RETURNING 1
    )
    SELECT coalesce(array_agg(DISTINCT id_medicamento), '{}'::integer[]), count(*)
      INTO v_medicamentos, v_bloqueados
      FROM bloqueados;

    WITH aplicadas AS (
        INSERT INTO alerta (tipo, id_medicamento, id_lote, nivel, prioridad, detalle)
        SELECT tipo, id_medicamento, id_lote, nivel, prioridad, detalle FROM alertas_calculadas
        ON CONFLICT (tipo, id_medicamento, (coalesce(id_lote, 0))) WHERE estado = 'ACTIVA'
        DO UPDATE SET nivel = EXCLUDED.nivel, prioridad = EXCLUDED.prioridad, detalle = EXCLUDED.detalle, actualizada_en = now()
         WHERE alerta.nivel IS DISTINCT FROM EXCLUDED.nivel
            OR alerta.prioridad IS DISTINCT FROM EXCLUDED.prioridad
            OR alerta.detalle IS DISTINCT FROM EXCLUDED.detalle
        RETURNING (xmax = 0) AS nueva
    )
    SELECT count(*) FILTER (WHERE nueva) INTO v_nuevas FROM aplicadas;

    UPDATE alerta a
       SET estado = 'RESUELTA', resuelta_en = now(), actualizada_en = now()
     WHERE a.estado = 'ACTIVA'
       AND NOT EXISTS (
           SELECT 1 FROM alertas_calculadas c
            WHERE c.tipo = a.tipo AND c.id_medicamento = a.id_medicamento AND coalesce(c.id_lote, 0) = coalesce(a.id_lote, 0)
       );
    GET DIAGNOSTICS v_resueltas = ROW_COUNT;

    RETURN jsonb_build_object('bloqueados', v_bloqueados, 'medicamentos', to_jsonb(v_medicamentos), 'nuevas', v_nuevas, 'resueltas', v_resueltas);
END;
$$;

-- Name: factura_estado_no_retrocede(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.factura_estado_no_retrocede() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.estado = 'ANULADA' AND NEW.estado <> 'ANULADA' THEN
        RAISE EXCEPTION 'FACTURA_ANULADA: la factura % ya fue anulada', OLD.numero_factura USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- Name: factura_inmutable(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.factura_inmutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Condiciones anidadas: PL/pgSQL no garantiza cortocircuito y detalle_factura no tiene esos campos.
    IF TG_TABLE_NAME = 'factura' AND TG_OP = 'UPDATE' THEN
        IF NEW.numero_factura = OLD.numero_factura
           AND NEW.id_cliente IS NOT DISTINCT FROM OLD.id_cliente
           AND NEW.id_empleado = OLD.id_empleado
           AND NEW.fecha_hora = OLD.fecha_hora
           AND NEW.subtotal = OLD.subtotal
           AND NEW.impuestos = OLD.impuestos
           AND NEW.total = OLD.total THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'Una factura emitida no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

-- Name: factura_integra(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.factura_integra() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_lineas integer;
    v_subtotal numeric;
    v_impuestos numeric;
    v_pagos numeric;
BEGIN
    SELECT count(*), coalesce(sum(subtotal_linea), 0), coalesce(sum(impuesto_linea), 0)
      INTO v_lineas, v_subtotal, v_impuestos
      FROM detalle_factura WHERE id_factura = NEW.id_factura;
    IF v_lineas = 0 OR v_subtotal <> NEW.subtotal OR v_impuestos <> NEW.impuestos THEN
        RAISE EXCEPTION 'FACTURA_INCOMPLETA: las líneas de % no suman su subtotal e impuestos', NEW.numero_factura USING ERRCODE = '23514';
    END IF;

    SELECT coalesce(sum(monto), 0) INTO v_pagos FROM factura_metodo_pago WHERE id_factura = NEW.id_factura;
    IF v_pagos <> NEW.total THEN
        RAISE EXCEPTION 'FACTURA_PAGOS: los pagos de % (%) no suman su total (%)', NEW.numero_factura, v_pagos, NEW.total USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM (SELECT id_lote, sum(cantidad) AS cantidad FROM detalle_factura WHERE id_factura = NEW.id_factura GROUP BY id_lote) d
          FULL JOIN (
              SELECT id_lote, sum(cantidad) AS cantidad
                FROM movimiento_inventario
               WHERE tipo_movimiento = 'VENTA' AND referencia_documento = NEW.numero_factura
               GROUP BY id_lote
          ) m ON m.id_lote = d.id_lote
         WHERE d.cantidad IS DISTINCT FROM m.cantidad
    ) THEN
        RAISE EXCEPTION 'FACTURA_SIN_MOVIMIENTO: el inventario de % no coincide con sus líneas', NEW.numero_factura USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

-- Name: factura_periodo_caja(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.factura_periodo_caja() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v periodo_caja%ROWTYPE;
BEGIN
    SELECT * INTO v FROM periodo_caja WHERE estado <> 'CERRADO' FOR SHARE;
    IF NOT FOUND OR v.estado <> 'ABIERTO' THEN
        RAISE EXCEPTION 'CAJA_CERRADA: la caja está cerrada; un administrador debe abrir un nuevo periodo para vender' USING ERRCODE = '23514';
    END IF;
    NEW.periodo_caja := v.periodo;
    RETURN NEW;
END;
$$;

-- Name: nota_inmutable(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.nota_inmutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'Una anulación o devolución registrada no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

-- Name: nota_integra(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.nota_integra() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_lineas integer;
    v_subtotal numeric;
    v_impuestos numeric;
    v_pagos numeric;
    v_estado text;
BEGIN
    SELECT count(*), COALESCE(sum(subtotal_devuelto), 0), COALESCE(sum(impuesto_devuelto), 0)
      INTO v_lineas, v_subtotal, v_impuestos
      FROM detalle_devolucion WHERE id_anulacion = NEW.id_anulacion;
    IF v_lineas = 0 OR v_subtotal <> NEW.subtotal_devuelto OR v_impuestos <> NEW.impuestos_devueltos THEN
        RAISE EXCEPTION 'NOTA_INCOMPLETA: las líneas de % no suman sus importes', NEW.numero_nota USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(sum(monto), 0) INTO v_pagos FROM devolucion_pago WHERE id_anulacion = NEW.id_anulacion;
    IF v_pagos <> NEW.total_devuelto THEN
        RAISE EXCEPTION 'NOTA_PAGOS: el reintegro de % (%) no suma su total (%)', NEW.numero_nota, v_pagos, NEW.total_devuelto USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM (SELECT id_lote, sum(cantidad_devuelta) AS cantidad FROM detalle_devolucion WHERE id_anulacion = NEW.id_anulacion GROUP BY id_lote) d
          FULL JOIN (
              SELECT id_lote, sum(cantidad) AS cantidad
                FROM movimiento_inventario
               WHERE tipo_movimiento = 'DEVOLUCION' AND referencia_documento = NEW.numero_nota
               GROUP BY id_lote
          ) m ON m.id_lote = d.id_lote
         WHERE d.cantidad IS DISTINCT FROM m.cantidad
    ) THEN
        RAISE EXCEPTION 'NOTA_SIN_MOVIMIENTO: el inventario de % no coincide con sus líneas', NEW.numero_nota USING ERRCODE = '23514';
    END IF;

    SELECT estado INTO v_estado FROM factura WHERE id_factura = NEW.id_factura;
    IF (NEW.tipo = 'ANULACION_TOTAL' AND v_estado <> 'ANULADA') OR (NEW.tipo = 'DEVOLUCION_PARCIAL' AND v_estado <> 'DEVOLUCION_PARCIAL') THEN
        RAISE EXCEPTION 'NOTA_ESTADO: la factura de % quedó en estado %', NEW.numero_nota, v_estado USING ERRCODE = '23514';
    END IF;
    IF NEW.tipo = 'ANULACION_TOTAL' AND EXISTS (
        SELECT 1 FROM detalle_factura f
         WHERE f.id_factura = NEW.id_factura
           AND f.cantidad IS DISTINCT FROM (SELECT sum(cantidad_devuelta) FROM detalle_devolucion d WHERE d.id_anulacion = NEW.id_anulacion AND d.id_lote = f.id_lote)
    ) THEN
        RAISE EXCEPTION 'NOTA_ANULACION: la anulación de % no cubre todas las líneas de la factura', NEW.numero_nota USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

-- Name: pedido_proveedor_activo(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.pedido_proveedor_activo() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM proveedor_ref WHERE id_proveedor = NEW.id_proveedor AND activo) THEN
        RAISE EXCEPTION 'El proveedor % no existe o está inactivo', NEW.id_proveedor USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- Name: pedido_transicion_estado(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.pedido_transicion_estado() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.estado = OLD.estado THEN
        RETURN NEW;
    END IF;
    IF (OLD.estado = 'SOLICITADO' AND NEW.estado IN ('ENVIADO', 'CANCELADO', 'RECIBIDO_PARCIAL', 'RECIBIDO_TOTAL'))
       OR (OLD.estado = 'ENVIADO' AND NEW.estado IN ('CANCELADO', 'RECIBIDO_PARCIAL', 'RECIBIDO_TOTAL'))
       OR (OLD.estado = 'RECIBIDO_PARCIAL' AND NEW.estado = 'RECIBIDO_TOTAL') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Transición de estado no permitida: % -> %', OLD.estado, NEW.estado USING ERRCODE = '23514';
END;
$$;

-- Name: periodo_caja_transicion(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.periodo_caja_transicion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Un periodo de caja no se puede borrar (periodo %)', OLD.periodo USING ERRCODE = '42501';
    END IF;
    IF NEW.periodo <> OLD.periodo THEN
        RAISE EXCEPTION 'El número de un periodo de caja no cambia' USING ERRCODE = '42501';
    END IF;
    IF OLD.estado = 'PENDIENTE' AND NEW.estado = 'ABIERTO' THEN
        RETURN NEW;
    END IF;
    -- Al cerrar, la hora de apertura solo puede completarse si faltaba (periodo inicial, sin apertura registrada).
    IF OLD.estado = 'ABIERTO' AND NEW.estado = 'CERRADO'
       AND (OLD.abierto_en IS NULL OR NEW.abierto_en IS NOT DISTINCT FROM OLD.abierto_en)
       AND NEW.id_empleado_apertura IS NOT DISTINCT FROM OLD.id_empleado_apertura
       AND NEW.turno IS NOT DISTINCT FROM OLD.turno THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Un periodo de caja % no puede pasar de % a % ni editarse', OLD.periodo, OLD.estado, NEW.estado USING ERRCODE = '42501';
END;
$$;

-- Name: precio_vigente(integer, timestamp without time zone); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.precio_vigente(p_medicamento integer, p_instante timestamp without time zone DEFAULT (now())::timestamp without time zone) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
    SELECT precio
    FROM precio_ref
    WHERE id_medicamento = p_medicamento
      AND fecha_inicio_vigencia <= p_instante
    ORDER BY fecha_inicio_vigencia DESC
    LIMIT 1;
$$;

-- Name: recepcion_inmutable(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.recepcion_inmutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'Una recepción registrada no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

-- Name: receta_inmutable(); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.receta_inmutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_TABLE_NAME = 'receta' AND TG_OP = 'UPDATE' THEN
        IF NEW.id_receta = OLD.id_receta
           AND NEW.medico_prescriptor = OLD.medico_prescriptor
           AND NEW.fecha_emision = OLD.fecha_emision
           AND NEW.id_cliente IS NOT DISTINCT FROM OLD.id_cliente
           AND NEW.fecha_registro = OLD.fecha_registro
           AND NEW.id_empleado_registro IS NOT DISTINCT FROM OLD.id_empleado_registro
           AND NEW.codigo_receta IS NOT DISTINCT FROM OLD.codigo_receta
           AND NEW.origen = OLD.origen THEN
            RETURN NEW;
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'receta_medicamento' AND TG_OP = 'UPDATE' THEN
        IF NEW.id_receta = OLD.id_receta
           AND NEW.id_medicamento = OLD.id_medicamento
           AND NEW.cantidad_autorizada = OLD.cantidad_autorizada THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'Una receta registrada no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

-- Name: receta_vigente(date); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.receta_vigente(p_fecha_emision date) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT p_fecha_emision <= current_date
       AND current_date - p_fecha_emision <= (SELECT dias_vigencia FROM politica_sistema WHERE id = 1);
$$;

-- Name: siguiente_numero_factura(integer); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.siguiente_numero_factura(p_tienda integer) RETURNS text
    LANGUAGE sql
    AS $$
    INSERT INTO secuencia_documento AS s (id_tienda, tipo, ultimo) VALUES (p_tienda, 'FACTURA', 1)
    ON CONFLICT (id_tienda, tipo) DO UPDATE SET ultimo = s.ultimo + 1
    RETURNING 'T' || p_tienda::text || '-' || lpad(ultimo::text, 6, '0');
$$;

-- Name: siguiente_numero_nota(integer); Type: FUNCTION; Schema: public; Owner: -

CREATE FUNCTION public.siguiente_numero_nota(p_tienda integer) RETURNS text
    LANGUAGE sql
    AS $$
    INSERT INTO secuencia_documento AS s (id_tienda, tipo, ultimo) VALUES (p_tienda, 'NOTA', 1)
    ON CONFLICT (id_tienda, tipo) DO UPDATE SET ultimo = s.ultimo + 1
    RETURNING 'NC-T' || p_tienda::text || '-' || lpad(ultimo::text, 6, '0');
$$;

-- Name: alerta; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.alerta (
    id_alerta bigint NOT NULL,
    tipo character varying(30) NOT NULL,
    id_medicamento integer NOT NULL,
    id_lote integer,
    nivel character varying(10) NOT NULL,
    prioridad numeric DEFAULT 0 NOT NULL,
    detalle jsonb DEFAULT '{}'::jsonb NOT NULL,
    estado character varying(10) DEFAULT 'ACTIVA'::character varying NOT NULL,
    creada_en timestamp without time zone DEFAULT now() NOT NULL,
    actualizada_en timestamp without time zone DEFAULT now() NOT NULL,
    resuelta_en timestamp without time zone,
    id_empleado_vista integer,
    vista_en timestamp without time zone,
    CONSTRAINT alerta_estado_check CHECK (((estado)::text = ANY ((ARRAY['ACTIVA'::character varying, 'RESUELTA'::character varying])::text[]))),
    CONSTRAINT alerta_nivel_check CHECK (((nivel)::text = ANY ((ARRAY['CRITICA'::character varying, 'ALTA'::character varying, 'MEDIA'::character varying])::text[]))),
    CONSTRAINT alerta_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['LOTE_VENCIDO'::character varying, 'STOCK_AGOTADO'::character varying, 'STOCK_BAJO'::character varying, 'CADUCIDAD_PROXIMA'::character varying, 'SIN_UMBRAL'::character varying])::text[])))
);

-- Name: alerta_id_alerta_seq; Type: SEQUENCE; Schema: public; Owner: -

ALTER TABLE public.alerta ALTER COLUMN id_alerta ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.alerta_id_alerta_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- Name: lote_id_lote_seq; Type: SEQUENCE; Schema: public; Owner: -

CREATE SEQUENCE public.lote_id_lote_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: lote; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.lote (
    id_lote integer DEFAULT nextval('public.lote_id_lote_seq'::regclass) NOT NULL,
    id_medicamento integer NOT NULL,
    id_proveedor integer NOT NULL,
    numero_lote character varying(60) NOT NULL,
    fecha_ingreso date DEFAULT CURRENT_DATE NOT NULL,
    fecha_caducidad date NOT NULL,
    cantidad_inicial integer NOT NULL,
    cantidad_disponible integer NOT NULL,
    estado character varying(15) DEFAULT 'DISPONIBLE'::character varying NOT NULL,
    fecha_registro timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT lote_cantidad_disponible_check CHECK ((cantidad_disponible >= 0)),
    CONSTRAINT lote_cantidad_inicial_check CHECK ((cantidad_inicial >= 0)),
    CONSTRAINT lote_estado_check CHECK (((estado)::text = ANY ((ARRAY['DISPONIBLE'::character varying, 'BLOQUEADO'::character varying, 'AGOTADO'::character varying])::text[])))
);

-- Name: medicamento_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.medicamento_ref (
    id_medicamento integer NOT NULL,
    codigo_interno character varying(40) NOT NULL,
    nombre_comercial character varying(150) NOT NULL,
    principio_activo character varying(150) NOT NULL,
    id_categoria integer,
    requiere_receta boolean DEFAULT false NOT NULL,
    requiere_refrigeracion boolean DEFAULT false NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    tasa_impuesto numeric(5,2) DEFAULT 0 NOT NULL,
    stock_minimo integer,
    dias_alerta_caducidad integer,
    CONSTRAINT medicamento_ref_tasa_impuesto_check CHECK (((tasa_impuesto >= (0)::numeric) AND (tasa_impuesto <= (100)::numeric))),
    CONSTRAINT medicamento_ref_umbral_check CHECK (((stock_minimo IS NULL) = (dias_alerta_caducidad IS NULL)))
);

-- Name: alertas_calculadas; Type: VIEW; Schema: public; Owner: -

CREATE VIEW public.alertas_calculadas AS
 WITH stock AS (
         SELECT m.id_medicamento,
            (COALESCE(sum(l.cantidad_disponible) FILTER (WHERE (((l.estado)::text = 'DISPONIBLE'::text) AND (l.fecha_caducidad >= CURRENT_DATE))), (0)::bigint))::integer AS vendible
           FROM (public.medicamento_ref m
             LEFT JOIN public.lote l ON ((l.id_medicamento = m.id_medicamento)))
          WHERE m.activo
          GROUP BY m.id_medicamento
        )
 SELECT 'LOTE_VENCIDO'::text AS tipo,
    l.id_medicamento,
    l.id_lote,
    'CRITICA'::text AS nivel,
    ((l.fecha_caducidad - CURRENT_DATE))::numeric AS prioridad,
    jsonb_build_object('numero_lote', l.numero_lote, 'cantidad', l.cantidad_disponible, 'fecha_caducidad', (l.fecha_caducidad)::text, 'dias_vencido', (CURRENT_DATE - l.fecha_caducidad)) AS detalle
   FROM (public.lote l
     JOIN public.medicamento_ref m ON (((m.id_medicamento = l.id_medicamento) AND m.activo)))
  WHERE ((l.fecha_caducidad < CURRENT_DATE) AND (l.cantidad_disponible > 0))
UNION ALL
 SELECT 'CADUCIDAD_PROXIMA'::text AS tipo,
    l.id_medicamento,
    l.id_lote,
        CASE
            WHEN ((l.fecha_caducidad - CURRENT_DATE) <= 7) THEN 'ALTA'::text
            ELSE 'MEDIA'::text
        END AS nivel,
    ((l.fecha_caducidad - CURRENT_DATE))::numeric AS prioridad,
    jsonb_build_object('numero_lote', l.numero_lote, 'cantidad', l.cantidad_disponible, 'fecha_caducidad', (l.fecha_caducidad)::text, 'dias_restantes', (l.fecha_caducidad - CURRENT_DATE), 'dias_aviso', COALESCE(m.dias_alerta_caducidad, 30)) AS detalle
   FROM (public.lote l
     JOIN public.medicamento_ref m ON (((m.id_medicamento = l.id_medicamento) AND m.activo)))
  WHERE (((l.estado)::text = 'DISPONIBLE'::text) AND (l.cantidad_disponible > 0) AND (l.fecha_caducidad >= CURRENT_DATE) AND ((l.fecha_caducidad - CURRENT_DATE) <= COALESCE(m.dias_alerta_caducidad, 30)))
UNION ALL
 SELECT
        CASE
            WHEN (s.vendible = 0) THEN 'STOCK_AGOTADO'::text
            ELSE 'STOCK_BAJO'::text
        END AS tipo,
    m.id_medicamento,
    NULL::integer AS id_lote,
        CASE
            WHEN (s.vendible = 0) THEN 'CRITICA'::text
            WHEN ((s.vendible * 2) <= m.stock_minimo) THEN 'ALTA'::text
            ELSE 'MEDIA'::text
        END AS nivel,
        CASE
            WHEN (m.stock_minimo > 0) THEN (((s.vendible)::numeric / (m.stock_minimo)::numeric) * (100)::numeric)
            ELSE (0)::numeric
        END AS prioridad,
    jsonb_build_object('stock', s.vendible, 'stock_minimo', m.stock_minimo) AS detalle
   FROM (public.medicamento_ref m
     JOIN stock s ON ((s.id_medicamento = m.id_medicamento)))
  WHERE (m.activo AND (m.stock_minimo IS NOT NULL) AND ((s.vendible = 0) OR ((m.stock_minimo > 0) AND (s.vendible <= m.stock_minimo))))
UNION ALL
 SELECT 'SIN_UMBRAL'::text AS tipo,
    m.id_medicamento,
    NULL::integer AS id_lote,
    'ALTA'::text AS nivel,
    (0)::numeric AS prioridad,
    '{}'::jsonb AS detalle
   FROM public.medicamento_ref m
  WHERE (m.activo AND (m.stock_minimo IS NULL));

-- Name: anulacion_devolucion_id_anulacion_seq; Type: SEQUENCE; Schema: public; Owner: -

CREATE SEQUENCE public.anulacion_devolucion_id_anulacion_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: anulacion_devolucion; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.anulacion_devolucion (
    id_anulacion integer DEFAULT nextval('public.anulacion_devolucion_id_anulacion_seq'::regclass) NOT NULL,
    id_factura integer NOT NULL,
    tipo character varying(20) NOT NULL,
    motivo character varying(300) NOT NULL,
    id_empleado integer NOT NULL,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    numero_nota character varying(30),
    subtotal_devuelto numeric(14,2) DEFAULT 0 NOT NULL,
    impuestos_devueltos numeric(14,2) DEFAULT 0 NOT NULL,
    total_devuelto numeric(14,2) DEFAULT 0 NOT NULL,
    periodo_caja integer DEFAULT 1 NOT NULL,
    CONSTRAINT anulacion_devolucion_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['ANULACION_TOTAL'::character varying, 'DEVOLUCION_PARCIAL'::character varying])::text[])))
);

-- Name: auth_operacion; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.auth_operacion (
    idempotency_key uuid NOT NULL,
    payload_hmac character(64) NOT NULL,
    resultado_http integer NOT NULL,
    cuerpo_json jsonb NOT NULL,
    token_entrega text,
    creado_en timestamp with time zone DEFAULT now() NOT NULL,
    id_empleado integer
);

-- Name: categoria_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.categoria_ref (
    id_categoria integer NOT NULL,
    nombre character varying(80) NOT NULL
);

-- Name: cierre_caja_id_cierre_seq; Type: SEQUENCE; Schema: public; Owner: -

CREATE SEQUENCE public.cierre_caja_id_cierre_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: cierre_caja; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.cierre_caja (
    id_cierre integer DEFAULT nextval('public.cierre_caja_id_cierre_seq'::regclass) NOT NULL,
    id_empleado integer NOT NULL,
    fecha date NOT NULL,
    turno character varying(20),
    total_sistema numeric(14,2) NOT NULL,
    total_efectivo_contado numeric(14,2) NOT NULL,
    total_vouchers numeric(14,2) NOT NULL,
    diferencia numeric(14,2) DEFAULT 0 NOT NULL,
    estado character varying(20) DEFAULT 'CONCILIADO'::character varying NOT NULL,
    fecha_hora_cierre timestamp without time zone DEFAULT now() NOT NULL,
    periodo_caja integer,
    justificacion character varying(300),
    CONSTRAINT cierre_caja_estado_check CHECK (((estado)::text = ANY ((ARRAY['CONCILIADO'::character varying, 'CON_DIFERENCIA'::character varying])::text[])))
);

-- Name: cierre_caja_empleado; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.cierre_caja_empleado (
    id_cierre integer NOT NULL,
    id_empleado integer NOT NULL,
    id_metodo_pago integer NOT NULL,
    vendido numeric(14,2) DEFAULT 0 NOT NULL,
    devuelto numeric(14,2) DEFAULT 0 NOT NULL
);

-- Name: cierre_caja_metodo_pago; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.cierre_caja_metodo_pago (
    id_cierre integer NOT NULL,
    id_metodo_pago integer NOT NULL,
    total_calculado_sistema numeric(14,2) DEFAULT 0 NOT NULL,
    total_reportado_empleado numeric(14,2) DEFAULT 0 NOT NULL,
    vendido numeric(14,2) DEFAULT 0 NOT NULL,
    devuelto numeric(14,2) DEFAULT 0 NOT NULL,
    diferencia numeric(14,2) DEFAULT 0 NOT NULL
);

-- Name: cliente_id_cliente_seq; Type: SEQUENCE; Schema: public; Owner: -

CREATE SEQUENCE public.cliente_id_cliente_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: cliente; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.cliente (
    id_cliente integer DEFAULT nextval('public.cliente_id_cliente_seq'::regclass) NOT NULL,
    nombre character varying(150) NOT NULL,
    documento_identidad character varying(40),
    telefono character varying(30),
    correo character varying(120),
    documento_hmac character varying(64),
    documento_cifrado text
);

-- Name: control_acceso; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.control_acceso (
    id_empleado integer NOT NULL,
    epoch bigint DEFAULT 1 NOT NULL,
    intentos_en_epoch integer DEFAULT 0 NOT NULL,
    estado character varying(20) DEFAULT 'ACTIVO'::character varying NOT NULL,
    bloqueado_hasta timestamp with time zone,
    provisional boolean DEFAULT false NOT NULL,
    provisional_hasta timestamp with time zone,
    id_snapshot bigint DEFAULT 0 NOT NULL,
    CONSTRAINT control_acceso_estado_check CHECK (((estado)::text = ANY ((ARRAY['ACTIVO'::character varying, 'BLOQUEADO'::character varying])::text[])))
);

-- Name: cursor_sync; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.cursor_sync (
    id_tienda integer NOT NULL,
    ultimo_evento_visto bigint DEFAULT 0 NOT NULL,
    ultimo_ack_en timestamp with time zone,
    ultimo_registro_enviado integer DEFAULT 0 NOT NULL,
    auditoria_enviada_en timestamp with time zone
);

-- Name: detalle_devolucion; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.detalle_devolucion (
    id_anulacion integer NOT NULL,
    id_lote integer NOT NULL,
    cantidad_devuelta integer NOT NULL,
    subtotal_devuelto numeric(14,2) DEFAULT 0 NOT NULL,
    impuesto_devuelto numeric(14,2) DEFAULT 0 NOT NULL,
    CONSTRAINT detalle_devolucion_cantidad_devuelta_check CHECK ((cantidad_devuelta > 0))
);

-- Name: detalle_factura; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.detalle_factura (
    id_factura integer NOT NULL,
    id_lote integer NOT NULL,
    id_receta integer,
    cantidad integer NOT NULL,
    precio_unitario_aplicado numeric(12,2) NOT NULL,
    subtotal_linea numeric(14,2) NOT NULL,
    tasa_impuesto numeric(5,2) DEFAULT 0 NOT NULL,
    impuesto_linea numeric(14,2) DEFAULT 0 NOT NULL,
    CONSTRAINT detalle_factura_cantidad_check CHECK ((cantidad > 0)),
    CONSTRAINT detalle_factura_impuesto_check CHECK ((impuesto_linea >= (0)::numeric)),
    CONSTRAINT detalle_factura_subtotal_check CHECK ((subtotal_linea = ((cantidad)::numeric * precio_unitario_aplicado)))
);

-- Name: detalle_pedido; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.detalle_pedido (
    id_pedido integer NOT NULL,
    id_medicamento integer NOT NULL,
    cantidad_solicitada integer NOT NULL,
    cantidad_recibida integer DEFAULT 0 NOT NULL,
    CONSTRAINT detalle_pedido_cantidad_recibida_check CHECK ((cantidad_recibida >= 0)),
    CONSTRAINT detalle_pedido_cantidad_solicitada_check CHECK ((cantidad_solicitada > 0))
);

-- Name: detalle_recepcion; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.detalle_recepcion (
    id_detalle integer NOT NULL,
    id_recepcion integer NOT NULL,
    id_lote integer NOT NULL,
    cantidad integer NOT NULL,
    CONSTRAINT detalle_recepcion_cantidad_check CHECK ((cantidad > 0))
);

-- Name: detalle_recepcion_id_detalle_seq; Type: SEQUENCE; Schema: public; Owner: -

ALTER TABLE public.detalle_recepcion ALTER COLUMN id_detalle ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.detalle_recepcion_id_detalle_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- Name: devolucion_pago; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.devolucion_pago (
    id_anulacion integer NOT NULL,
    id_metodo_pago integer NOT NULL,
    monto numeric(14,2) NOT NULL,
    CONSTRAINT devolucion_pago_monto_check CHECK ((monto > (0)::numeric))
);

-- Name: diferencia_recepcion; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.diferencia_recepcion (
    id_diferencia integer NOT NULL,
    id_pedido integer NOT NULL,
    id_recepcion integer,
    id_medicamento integer NOT NULL,
    tipo character varying(10) NOT NULL,
    cantidad_solicitada integer NOT NULL,
    cantidad_recibida integer NOT NULL,
    diferencia integer NOT NULL,
    motivo character varying(300) NOT NULL,
    id_empleado integer NOT NULL,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT diferencia_recepcion_cuadra_check CHECK ((diferencia = (cantidad_recibida - cantidad_solicitada))),
    CONSTRAINT diferencia_recepcion_motivo_check CHECK ((char_length(btrim((motivo)::text)) >= 5)),
    CONSTRAINT diferencia_recepcion_tipo_check CHECK (((((tipo)::text = 'FALTANTE'::text) AND (diferencia < 0)) OR (((tipo)::text = 'SOBRANTE'::text) AND (diferencia > 0))))
);

-- Name: diferencia_recepcion_id_diferencia_seq; Type: SEQUENCE; Schema: public; Owner: -

ALTER TABLE public.diferencia_recepcion ALTER COLUMN id_diferencia ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.diferencia_recepcion_id_diferencia_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- Name: empleado_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.empleado_ref (
    id_empleado integer NOT NULL,
    id_rol integer NOT NULL,
    nombre_completo character varying(150) NOT NULL,
    usuario character varying(60) NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    contrasena_hash character varying(255),
    id_tienda integer,
    version_credencial bigint DEFAULT 1 NOT NULL,
    fecha_baja timestamp without time zone
);

-- Name: factura_id_factura_seq; Type: SEQUENCE; Schema: public; Owner: -

CREATE SEQUENCE public.factura_id_factura_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: factura; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.factura (
    id_factura integer DEFAULT nextval('public.factura_id_factura_seq'::regclass) NOT NULL,
    numero_factura character varying(30) NOT NULL,
    id_cliente integer,
    id_empleado integer NOT NULL,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    subtotal numeric(14,2) NOT NULL,
    impuestos numeric(14,2) NOT NULL,
    total numeric(14,2) NOT NULL,
    estado character varying(20) DEFAULT 'EMITIDA'::character varying NOT NULL,
    periodo_caja integer DEFAULT 1 NOT NULL,
    CONSTRAINT factura_estado_check CHECK (((estado)::text = ANY ((ARRAY['EMITIDA'::character varying, 'ANULADA'::character varying, 'DEVOLUCION_PARCIAL'::character varying])::text[]))),
    CONSTRAINT factura_impuestos_check CHECK ((impuestos >= (0)::numeric)),
    CONSTRAINT factura_subtotal_check CHECK ((subtotal >= (0)::numeric)),
    CONSTRAINT factura_total_check CHECK ((total >= (0)::numeric)),
    CONSTRAINT factura_total_integridad_check CHECK ((total = (subtotal + impuestos)))
);

-- Name: factura_metodo_pago; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.factura_metodo_pago (
    id_factura integer NOT NULL,
    id_metodo_pago integer NOT NULL,
    monto numeric(14,2) NOT NULL,
    CONSTRAINT factura_metodo_pago_monto_check CHECK ((monto > (0)::numeric))
);

-- Name: intento_acceso; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.intento_acceso (
    id_intento bigint NOT NULL,
    idempotency_key uuid NOT NULL,
    usuario_intentado character varying(60) NOT NULL,
    id_empleado integer,
    resultado character varying(40) NOT NULL,
    fecha_hora timestamp with time zone DEFAULT now() NOT NULL,
    detalle character varying(400)
);

-- Name: intento_acceso_id_intento_seq; Type: SEQUENCE; Schema: public; Owner: -

ALTER TABLE public.intento_acceso ALTER COLUMN id_intento ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.intento_acceso_id_intento_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- Name: medicamento_proveedor_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.medicamento_proveedor_ref (
    id_proveedor integer NOT NULL,
    id_medicamento integer NOT NULL
);

-- Name: metodo_pago_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.metodo_pago_ref (
    id_metodo_pago integer NOT NULL,
    nombre character varying(40) NOT NULL,
    activo boolean DEFAULT true NOT NULL
);

-- Name: movimiento_inventario_id_movimiento_seq; Type: SEQUENCE; Schema: public; Owner: -

CREATE SEQUENCE public.movimiento_inventario_id_movimiento_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: movimiento_inventario; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.movimiento_inventario (
    id_movimiento integer DEFAULT nextval('public.movimiento_inventario_id_movimiento_seq'::regclass) NOT NULL,
    id_lote integer NOT NULL,
    tipo_movimiento character varying(20) NOT NULL,
    cantidad integer NOT NULL,
    id_empleado integer,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    referencia_documento character varying(60),
    id_traslado integer,
    rol_tienda_traslado character varying(10),
    observaciones character varying(300),
    sentido smallint NOT NULL,
    CONSTRAINT movimiento_cantidad_check CHECK ((cantidad > 0)),
    CONSTRAINT movimiento_inventario_tipo_movimiento_check CHECK (((tipo_movimiento)::text = ANY ((ARRAY['ENTRADA'::character varying, 'VENTA'::character varying, 'AJUSTE'::character varying, 'DEVOLUCION'::character varying, 'TRASLADO_SALIDA'::character varying, 'TRASLADO_ENTRADA'::character varying])::text[]))),
    CONSTRAINT movimiento_sentido_check CHECK (((sentido = ANY (ARRAY['-1'::integer, 1])) AND (((tipo_movimiento)::text = 'AJUSTE'::text) OR (((tipo_movimiento)::text = ANY ((ARRAY['ENTRADA'::character varying, 'DEVOLUCION'::character varying, 'TRASLADO_ENTRADA'::character varying])::text[])) AND (sentido = 1)) OR (((tipo_movimiento)::text = ANY ((ARRAY['VENTA'::character varying, 'TRASLADO_SALIDA'::character varying])::text[])) AND (sentido = '-1'::integer)))))
);

-- Name: outbox_sync; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.outbox_sync (
    id_outbox bigint NOT NULL,
    id_empleado integer,
    idempotency_key uuid NOT NULL,
    tipo_evento character varying(40) NOT NULL,
    payload jsonb NOT NULL,
    estado character varying(20) DEFAULT 'PENDIENTE'::character varying NOT NULL,
    intentos integer DEFAULT 0 NOT NULL,
    proximo_intento timestamp with time zone DEFAULT now() NOT NULL,
    creado_en timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_sync_estado_check CHECK (((estado)::text = ANY ((ARRAY['PENDIENTE'::character varying, 'ENVIADO'::character varying, 'ERROR'::character varying])::text[])))
);

-- Name: outbox_sync_id_outbox_seq; Type: SEQUENCE; Schema: public; Owner: -

ALTER TABLE public.outbox_sync ALTER COLUMN id_outbox ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.outbox_sync_id_outbox_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- Name: pedido_id_pedido_seq; Type: SEQUENCE; Schema: public; Owner: -

CREATE SEQUENCE public.pedido_id_pedido_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: pedido; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.pedido (
    id_pedido integer DEFAULT nextval('public.pedido_id_pedido_seq'::regclass) NOT NULL,
    id_proveedor integer NOT NULL,
    id_empleado_solicitante integer NOT NULL,
    origen_solicitud character varying(20) NOT NULL,
    fecha_solicitud timestamp without time zone DEFAULT now() NOT NULL,
    estado character varying(20) DEFAULT 'SOLICITADO'::character varying NOT NULL,
    fecha_recepcion timestamp without time zone,
    id_alerta bigint,
    fecha_envio timestamp without time zone,
    observaciones character varying(300),
    con_diferencia boolean DEFAULT false NOT NULL,
    CONSTRAINT pedido_estado_check CHECK (((estado)::text = ANY ((ARRAY['SOLICITADO'::character varying, 'ENVIADO'::character varying, 'RECIBIDO_PARCIAL'::character varying, 'RECIBIDO_TOTAL'::character varying, 'CANCELADO'::character varying])::text[]))),
    CONSTRAINT pedido_origen_solicitud_check CHECK (((origen_solicitud)::text = ANY ((ARRAY['ALERTA_AUTOMATICA'::character varying, 'MANUAL'::character varying])::text[])))
);

-- Name: periodo_caja; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.periodo_caja (
    periodo integer NOT NULL,
    estado character varying(10) NOT NULL,
    abierto_en timestamp without time zone,
    id_empleado_apertura integer,
    turno character varying(20),
    CONSTRAINT periodo_caja_estado_check CHECK (((estado)::text = ANY ((ARRAY['PENDIENTE'::character varying, 'ABIERTO'::character varying, 'CERRADO'::character varying])::text[]))),
    CONSTRAINT periodo_caja_pendiente_check CHECK ((((estado)::text <> 'PENDIENTE'::text) OR ((abierto_en IS NULL) AND (id_empleado_apertura IS NULL))))
);

-- Name: permiso_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.permiso_ref (
    id_permiso integer NOT NULL,
    codigo character varying(60) NOT NULL,
    descripcion character varying(200)
);

-- Name: politica_sistema; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.politica_sistema (
    id integer NOT NULL,
    intentos_maximos integer NOT NULL,
    minutos_bloqueo integer NOT NULL,
    dias_vigencia integer DEFAULT 30 NOT NULL,
    permitir_registro_manual boolean DEFAULT false NOT NULL,
    CONSTRAINT politica_sistema_dias_check CHECK ((dias_vigencia > 0)),
    CONSTRAINT politica_sistema_id_check CHECK ((id = 1)),
    CONSTRAINT politica_sistema_intentos_check CHECK ((intentos_maximos > 0)),
    CONSTRAINT politica_sistema_minutos_check CHECK ((minutos_bloqueo > 0))
);

-- Name: precio_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.precio_ref (
    id_precio integer NOT NULL,
    id_medicamento integer NOT NULL,
    precio numeric(12,2) NOT NULL,
    fecha_inicio_vigencia timestamp without time zone NOT NULL,
    fecha_fin_vigencia timestamp without time zone,
    id_empleado_registro integer,
    registrado_por character varying(150),
    CONSTRAINT precio_ref_precio_check CHECK ((precio >= (0)::numeric))
);

-- Name: proveedor_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.proveedor_ref (
    id_proveedor integer NOT NULL,
    nombre_empresa character varying(150) NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    nit character varying(40),
    telefono character varying(30),
    correo character varying(120),
    direccion character varying(200)
);

-- Name: recepcion; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.recepcion (
    id_recepcion integer NOT NULL,
    id_pedido integer NOT NULL,
    id_empleado integer NOT NULL,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    documento_proveedor character varying(60),
    observaciones character varying(300)
);

-- Name: recepcion_id_recepcion_seq; Type: SEQUENCE; Schema: public; Owner: -

ALTER TABLE public.recepcion ALTER COLUMN id_recepcion ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.recepcion_id_recepcion_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- Name: receta_id_receta_seq; Type: SEQUENCE; Schema: public; Owner: -

CREATE SEQUENCE public.receta_id_receta_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: receta; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.receta (
    id_receta integer DEFAULT nextval('public.receta_id_receta_seq'::regclass) NOT NULL,
    medico_prescriptor character varying(150) NOT NULL,
    fecha_emision date NOT NULL,
    id_cliente integer,
    fecha_registro timestamp without time zone DEFAULT now() NOT NULL,
    id_empleado_registro integer,
    codigo_receta character varying(40),
    origen character varying(10) DEFAULT 'MANUAL'::character varying NOT NULL,
    reservada_hasta timestamp without time zone,
    CONSTRAINT receta_origen_check CHECK (((origen)::text = ANY ((ARRAY['MANUAL'::character varying, 'CENTRAL'::character varying])::text[])))
);

-- Name: receta_medicamento; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.receta_medicamento (
    id_receta integer NOT NULL,
    id_medicamento integer NOT NULL,
    cantidad_autorizada integer NOT NULL,
    cantidad_dispensada integer DEFAULT 0 NOT NULL,
    CONSTRAINT receta_medicamento_cantidad_autorizada_check CHECK ((cantidad_autorizada > 0)),
    CONSTRAINT receta_medicamento_dispensada_check CHECK (((cantidad_dispensada >= 0) AND (cantidad_dispensada <= cantidad_autorizada)))
);

-- Name: registro_actividad_id_registro_seq; Type: SEQUENCE; Schema: public; Owner: -

CREATE SEQUENCE public.registro_actividad_id_registro_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: registro_actividad; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.registro_actividad (
    id_registro integer DEFAULT nextval('public.registro_actividad_id_registro_seq'::regclass) NOT NULL,
    id_empleado integer,
    accion character varying(80) NOT NULL,
    entidad_afectada character varying(60) NOT NULL,
    id_entidad_afectada integer,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    detalle character varying(400)
);

-- Name: rol_permiso_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.rol_permiso_ref (
    id_rol integer NOT NULL,
    id_permiso integer NOT NULL
);

-- Name: rol_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.rol_ref (
    id_rol integer NOT NULL,
    nombre character varying(40) NOT NULL
);

-- Name: secuencia_documento; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.secuencia_documento (
    tipo character varying(10) NOT NULL,
    ultimo bigint DEFAULT 0 NOT NULL,
    id_tienda integer NOT NULL,
    CONSTRAINT secuencia_documento_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['FACTURA'::character varying, 'NOTA'::character varying])::text[])))
);

-- Name: sesion_activa; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.sesion_activa (
    id_sesion uuid NOT NULL,
    token_hash character(64) NOT NULL,
    id_empleado integer NOT NULL,
    id_tienda integer NOT NULL,
    nodo_emisor character varying(10) NOT NULL,
    expira_en timestamp with time zone NOT NULL,
    revocada boolean DEFAULT false NOT NULL,
    creado_en timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: sync_conflicto; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.sync_conflicto (
    id_conflicto bigint NOT NULL,
    id_empleado integer,
    tipo character varying(40) NOT NULL,
    detalle character varying(400) NOT NULL,
    creado_en timestamp with time zone DEFAULT now() NOT NULL,
    resuelto boolean DEFAULT false NOT NULL,
    payload jsonb
);

-- Name: sync_conflicto_id_conflicto_seq; Type: SEQUENCE; Schema: public; Owner: -

ALTER TABLE public.sync_conflicto ALTER COLUMN id_conflicto ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sync_conflicto_id_conflicto_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- Name: tienda_ref; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.tienda_ref (
    id_tienda integer NOT NULL,
    nombre character varying(120) NOT NULL,
    activa boolean DEFAULT true NOT NULL,
    es_tienda_local boolean DEFAULT false NOT NULL,
    id_politica integer DEFAULT 1 NOT NULL
);

-- Name: traslado_local; Type: TABLE; Schema: public; Owner: -

CREATE TABLE public.traslado_local (
    id_traslado integer NOT NULL,
    rol_tienda character varying(10) NOT NULL,
    id_tienda_origen integer NOT NULL,
    id_tienda_destino integer NOT NULL,
    estado_local character varying(20) NOT NULL,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    estado_red character varying(20),
    motivo character varying(300),
    solicitante character varying(150),
    actualizado_en timestamp without time zone,
    id_medicamento integer NOT NULL,
    cantidad integer NOT NULL,
    CONSTRAINT traslado_local_cantidad_check CHECK ((cantidad > 0)),
    CONSTRAINT traslado_local_check CHECK ((id_tienda_origen <> id_tienda_destino)),
    CONSTRAINT traslado_local_estado_local_check CHECK (((estado_local)::text = ANY ((ARRAY['PENDIENTE'::character varying, 'DESCONTADO'::character varying, 'RECIBIDO'::character varying, 'COMPENSADO'::character varying, 'RECHAZADO'::character varying, 'FALLIDO'::character varying])::text[]))),
    CONSTRAINT traslado_local_rol_tienda_check CHECK (((rol_tienda)::text = ANY ((ARRAY['ORIGEN'::character varying, 'DESTINO'::character varying])::text[])))
);

-- Name: alerta alerta_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.alerta
    ADD CONSTRAINT alerta_pkey PRIMARY KEY (id_alerta);

-- Name: anulacion_devolucion anulacion_devolucion_motivo_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE public.anulacion_devolucion
    ADD CONSTRAINT anulacion_devolucion_motivo_check CHECK ((char_length(btrim((motivo)::text)) >= 5)) NOT VALID;

-- Name: anulacion_devolucion anulacion_devolucion_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.anulacion_devolucion
    ADD CONSTRAINT anulacion_devolucion_pkey PRIMARY KEY (id_anulacion);

-- Name: anulacion_devolucion anulacion_devolucion_total_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE public.anulacion_devolucion
    ADD CONSTRAINT anulacion_devolucion_total_check CHECK (((total_devuelto = (subtotal_devuelto + impuestos_devueltos)) AND (total_devuelto >= (0)::numeric))) NOT VALID;

-- Name: auth_operacion auth_operacion_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.auth_operacion
    ADD CONSTRAINT auth_operacion_pkey PRIMARY KEY (idempotency_key);

-- Name: categoria_ref categoria_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.categoria_ref
    ADD CONSTRAINT categoria_ref_pkey PRIMARY KEY (id_categoria);

-- Name: cierre_caja_empleado cierre_caja_empleado_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja_empleado
    ADD CONSTRAINT cierre_caja_empleado_pkey PRIMARY KEY (id_cierre, id_empleado, id_metodo_pago);

-- Name: cierre_caja cierre_caja_justificacion_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE public.cierre_caja
    ADD CONSTRAINT cierre_caja_justificacion_check CHECK ((((estado)::text = 'CONCILIADO'::text) OR (char_length(btrim((COALESCE(justificacion, ''::character varying))::text)) >= 10))) NOT VALID;

-- Name: cierre_caja_metodo_pago cierre_caja_metodo_pago_calculo_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE public.cierre_caja_metodo_pago
    ADD CONSTRAINT cierre_caja_metodo_pago_calculo_check CHECK (((total_calculado_sistema = (vendido - devuelto)) AND (diferencia = (total_reportado_empleado - total_calculado_sistema)))) NOT VALID;

-- Name: cierre_caja_metodo_pago cierre_caja_metodo_pago_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja_metodo_pago
    ADD CONSTRAINT cierre_caja_metodo_pago_pkey PRIMARY KEY (id_cierre, id_metodo_pago);

-- Name: cierre_caja cierre_caja_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja
    ADD CONSTRAINT cierre_caja_pkey PRIMARY KEY (id_cierre);

-- Name: cliente cliente_documento_cifrado_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE public.cliente
    ADD CONSTRAINT cliente_documento_cifrado_check CHECK (((documento_identidad IS NULL) OR (documento_cifrado IS NOT NULL))) NOT VALID;

-- Name: cliente cliente_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cliente
    ADD CONSTRAINT cliente_pkey PRIMARY KEY (id_cliente);

-- Name: control_acceso control_acceso_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.control_acceso
    ADD CONSTRAINT control_acceso_pkey PRIMARY KEY (id_empleado);

-- Name: cursor_sync cursor_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cursor_sync
    ADD CONSTRAINT cursor_sync_pkey PRIMARY KEY (id_tienda);

-- Name: detalle_devolucion detalle_devolucion_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_devolucion
    ADD CONSTRAINT detalle_devolucion_pkey PRIMARY KEY (id_anulacion, id_lote);

-- Name: detalle_factura detalle_factura_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_factura
    ADD CONSTRAINT detalle_factura_pkey PRIMARY KEY (id_factura, id_lote);

-- Name: detalle_pedido detalle_pedido_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_pedido
    ADD CONSTRAINT detalle_pedido_pkey PRIMARY KEY (id_pedido, id_medicamento);

-- Name: detalle_recepcion detalle_recepcion_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_recepcion
    ADD CONSTRAINT detalle_recepcion_pkey PRIMARY KEY (id_detalle);

-- Name: devolucion_pago devolucion_pago_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.devolucion_pago
    ADD CONSTRAINT devolucion_pago_pkey PRIMARY KEY (id_anulacion, id_metodo_pago);

-- Name: diferencia_recepcion diferencia_recepcion_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.diferencia_recepcion
    ADD CONSTRAINT diferencia_recepcion_pkey PRIMARY KEY (id_diferencia);

-- Name: empleado_ref empleado_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.empleado_ref
    ADD CONSTRAINT empleado_ref_pkey PRIMARY KEY (id_empleado);

-- Name: factura_metodo_pago factura_metodo_pago_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.factura_metodo_pago
    ADD CONSTRAINT factura_metodo_pago_pkey PRIMARY KEY (id_factura, id_metodo_pago);

-- Name: factura factura_numero_factura_key; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.factura
    ADD CONSTRAINT factura_numero_factura_key UNIQUE (numero_factura);

-- Name: factura factura_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.factura
    ADD CONSTRAINT factura_pkey PRIMARY KEY (id_factura);

-- Name: intento_acceso intento_acceso_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.intento_acceso
    ADD CONSTRAINT intento_acceso_idempotency_key_key UNIQUE (idempotency_key);

-- Name: intento_acceso intento_acceso_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.intento_acceso
    ADD CONSTRAINT intento_acceso_pkey PRIMARY KEY (id_intento);

-- Name: lote lote_id_lote_id_medicamento_key; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.lote
    ADD CONSTRAINT lote_id_lote_id_medicamento_key UNIQUE (id_lote, id_medicamento);

-- Name: lote lote_id_medicamento_id_proveedor_numero_lote_key; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.lote
    ADD CONSTRAINT lote_id_medicamento_id_proveedor_numero_lote_key UNIQUE (id_medicamento, id_proveedor, numero_lote);

-- Name: lote lote_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.lote
    ADD CONSTRAINT lote_pkey PRIMARY KEY (id_lote);

-- Name: medicamento_proveedor_ref medicamento_proveedor_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.medicamento_proveedor_ref
    ADD CONSTRAINT medicamento_proveedor_ref_pkey PRIMARY KEY (id_proveedor, id_medicamento);

-- Name: medicamento_ref medicamento_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.medicamento_ref
    ADD CONSTRAINT medicamento_ref_pkey PRIMARY KEY (id_medicamento);

-- Name: metodo_pago_ref metodo_pago_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.metodo_pago_ref
    ADD CONSTRAINT metodo_pago_ref_pkey PRIMARY KEY (id_metodo_pago);

-- Name: movimiento_inventario movimiento_inventario_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.movimiento_inventario
    ADD CONSTRAINT movimiento_inventario_pkey PRIMARY KEY (id_movimiento);

-- Name: outbox_sync outbox_sync_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.outbox_sync
    ADD CONSTRAINT outbox_sync_idempotency_key_key UNIQUE (idempotency_key);

-- Name: outbox_sync outbox_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.outbox_sync
    ADD CONSTRAINT outbox_sync_pkey PRIMARY KEY (id_outbox);

-- Name: pedido pedido_alerta_origen_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE public.pedido
    ADD CONSTRAINT pedido_alerta_origen_check CHECK ((((origen_solicitud)::text = 'ALERTA_AUTOMATICA'::text) = (id_alerta IS NOT NULL))) NOT VALID;

-- Name: pedido pedido_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.pedido
    ADD CONSTRAINT pedido_pkey PRIMARY KEY (id_pedido);

-- Name: periodo_caja periodo_caja_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.periodo_caja
    ADD CONSTRAINT periodo_caja_pkey PRIMARY KEY (periodo);

-- Name: permiso_ref permiso_ref_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.permiso_ref
    ADD CONSTRAINT permiso_ref_codigo_key UNIQUE (codigo);

-- Name: permiso_ref permiso_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.permiso_ref
    ADD CONSTRAINT permiso_ref_pkey PRIMARY KEY (id_permiso);

-- Name: politica_sistema politica_sistema_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.politica_sistema
    ADD CONSTRAINT politica_sistema_pkey PRIMARY KEY (id);

-- Name: precio_ref precio_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.precio_ref
    ADD CONSTRAINT precio_ref_pkey PRIMARY KEY (id_precio);

-- Name: proveedor_ref proveedor_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.proveedor_ref
    ADD CONSTRAINT proveedor_ref_pkey PRIMARY KEY (id_proveedor);

-- Name: recepcion recepcion_id_recepcion_id_pedido_key; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.recepcion
    ADD CONSTRAINT recepcion_id_recepcion_id_pedido_key UNIQUE (id_recepcion, id_pedido);

-- Name: recepcion recepcion_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.recepcion
    ADD CONSTRAINT recepcion_pkey PRIMARY KEY (id_recepcion);

-- Name: receta_medicamento receta_medicamento_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.receta_medicamento
    ADD CONSTRAINT receta_medicamento_pkey PRIMARY KEY (id_receta, id_medicamento);

-- Name: receta receta_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.receta
    ADD CONSTRAINT receta_pkey PRIMARY KEY (id_receta);

-- Name: registro_actividad registro_actividad_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.registro_actividad
    ADD CONSTRAINT registro_actividad_pkey PRIMARY KEY (id_registro);

-- Name: rol_permiso_ref rol_permiso_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.rol_permiso_ref
    ADD CONSTRAINT rol_permiso_ref_pkey PRIMARY KEY (id_rol, id_permiso);

-- Name: rol_ref rol_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.rol_ref
    ADD CONSTRAINT rol_ref_pkey PRIMARY KEY (id_rol);

-- Name: secuencia_documento secuencia_documento_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.secuencia_documento
    ADD CONSTRAINT secuencia_documento_pkey PRIMARY KEY (id_tienda, tipo);

-- Name: sesion_activa sesion_activa_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.sesion_activa
    ADD CONSTRAINT sesion_activa_pkey PRIMARY KEY (id_sesion);

-- Name: sesion_activa sesion_activa_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.sesion_activa
    ADD CONSTRAINT sesion_activa_token_hash_key UNIQUE (token_hash);

-- Name: sync_conflicto sync_conflicto_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.sync_conflicto
    ADD CONSTRAINT sync_conflicto_pkey PRIMARY KEY (id_conflicto);

-- Name: tienda_ref tienda_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.tienda_ref
    ADD CONSTRAINT tienda_ref_pkey PRIMARY KEY (id_tienda);

-- Name: traslado_local traslado_local_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.traslado_local
    ADD CONSTRAINT traslado_local_pkey PRIMARY KEY (id_traslado, rol_tienda);

-- Name: idx_alerta_estado; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_alerta_estado ON public.alerta USING btree (estado, nivel);

-- Name: idx_anulacion_factura; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_anulacion_factura ON public.anulacion_devolucion USING btree (id_factura);

-- Name: idx_anulacion_fecha; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_anulacion_fecha ON public.anulacion_devolucion USING btree (fecha_hora);

-- Name: idx_anulacion_periodo_caja; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_anulacion_periodo_caja ON public.anulacion_devolucion USING btree (periodo_caja);

-- Name: idx_cierre_caja_fecha; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_cierre_caja_fecha ON public.cierre_caja USING btree (fecha_hora_cierre);

-- Name: idx_cliente_nombre_trgm; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_cliente_nombre_trgm ON public.cliente USING gin (lower((nombre)::text) public.gin_trgm_ops);

-- Name: idx_detalle_factura_factura; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_detalle_factura_factura ON public.detalle_factura USING btree (id_factura);

-- Name: idx_detalle_factura_receta; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_detalle_factura_receta ON public.detalle_factura USING btree (id_receta) WHERE (id_receta IS NOT NULL);

-- Name: idx_detalle_recepcion_recepcion; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_detalle_recepcion_recepcion ON public.detalle_recepcion USING btree (id_recepcion);

-- Name: idx_diferencia_recepcion_pedido; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_diferencia_recepcion_pedido ON public.diferencia_recepcion USING btree (id_pedido);

-- Name: idx_factura_cliente; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_factura_cliente ON public.factura USING btree (id_cliente);

-- Name: idx_factura_cliente_fecha; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_factura_cliente_fecha ON public.factura USING btree (id_cliente, fecha_hora DESC, id_factura DESC);

-- Name: idx_factura_fecha; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_factura_fecha ON public.factura USING btree (fecha_hora);

-- Name: idx_factura_fecha_id; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_factura_fecha_id ON public.factura USING btree (fecha_hora DESC, id_factura DESC);

-- Name: idx_factura_metodo_pago_factura; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_factura_metodo_pago_factura ON public.factura_metodo_pago USING btree (id_factura);

-- Name: idx_factura_numero_prefijo; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_factura_numero_prefijo ON public.factura USING btree (numero_factura varchar_pattern_ops);

-- Name: idx_factura_periodo_caja; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_factura_periodo_caja ON public.factura USING btree (periodo_caja);

-- Name: idx_lote_caducidad; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_lote_caducidad ON public.lote USING btree (fecha_caducidad);

-- Name: idx_lote_estado; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_lote_estado ON public.lote USING btree (estado);

-- Name: idx_lote_medicamento; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_lote_medicamento ON public.lote USING btree (id_medicamento);

-- Name: idx_medicamento_proveedor_ref_medicamento; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_medicamento_proveedor_ref_medicamento ON public.medicamento_proveedor_ref USING btree (id_medicamento);

-- Name: idx_medicamento_ref_nombre; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_medicamento_ref_nombre ON public.medicamento_ref USING btree (nombre_comercial);

-- Name: idx_medicamento_ref_principio; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_medicamento_ref_principio ON public.medicamento_ref USING btree (principio_activo);

-- Name: idx_movimiento_fecha; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_movimiento_fecha ON public.movimiento_inventario USING btree (fecha_hora);

-- Name: idx_movimiento_lote; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_movimiento_lote ON public.movimiento_inventario USING btree (id_lote);

-- Name: idx_movimiento_traslado; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_movimiento_traslado ON public.movimiento_inventario USING btree (id_traslado, rol_tienda_traslado);

-- Name: idx_pedido_estado; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_pedido_estado ON public.pedido USING btree (estado, fecha_solicitud);

-- Name: idx_precio_ref_vigencia; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_precio_ref_vigencia ON public.precio_ref USING btree (id_medicamento, fecha_inicio_vigencia);

-- Name: idx_recepcion_pedido; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_recepcion_pedido ON public.recepcion USING btree (id_pedido, fecha_hora);

-- Name: idx_receta_cliente; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_receta_cliente ON public.receta USING btree (id_cliente);

-- Name: idx_registro_actividad_empleado; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_registro_actividad_empleado ON public.registro_actividad USING btree (id_empleado);

-- Name: idx_registro_actividad_fecha; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_registro_actividad_fecha ON public.registro_actividad USING btree (fecha_hora);

-- Name: idx_traslado_local_fecha; Type: INDEX; Schema: public; Owner: -

CREATE INDEX idx_traslado_local_fecha ON public.traslado_local USING btree (fecha_hora);

-- Name: uq_alerta_activa; Type: INDEX; Schema: public; Owner: -

CREATE UNIQUE INDEX uq_alerta_activa ON public.alerta USING btree (tipo, id_medicamento, COALESCE(id_lote, 0)) WHERE ((estado)::text = 'ACTIVA'::text);

-- Name: uq_cliente_documento_hmac; Type: INDEX; Schema: public; Owner: -

CREATE UNIQUE INDEX uq_cliente_documento_hmac ON public.cliente USING btree (documento_hmac) WHERE (documento_hmac IS NOT NULL);

-- Name: uq_pedido_alerta_abierta; Type: INDEX; Schema: public; Owner: -

CREATE UNIQUE INDEX uq_pedido_alerta_abierta ON public.pedido USING btree (id_alerta) WHERE ((id_alerta IS NOT NULL) AND ((estado)::text = ANY ((ARRAY['SOLICITADO'::character varying, 'ENVIADO'::character varying, 'RECIBIDO_PARCIAL'::character varying])::text[])));

-- Name: uq_receta_codigo; Type: INDEX; Schema: public; Owner: -

CREATE UNIQUE INDEX uq_receta_codigo ON public.receta USING btree (codigo_receta) WHERE (codigo_receta IS NOT NULL);

-- Name: ux_anulacion_numero_nota; Type: INDEX; Schema: public; Owner: -

CREATE UNIQUE INDEX ux_anulacion_numero_nota ON public.anulacion_devolucion USING btree (numero_nota) WHERE (numero_nota IS NOT NULL);

-- Name: ux_anulacion_total_por_factura; Type: INDEX; Schema: public; Owner: -

CREATE UNIQUE INDEX ux_anulacion_total_por_factura ON public.anulacion_devolucion USING btree (id_factura) WHERE ((tipo)::text = 'ANULACION_TOTAL'::text);

-- Name: ux_cierre_caja_periodo; Type: INDEX; Schema: public; Owner: -

CREATE UNIQUE INDEX ux_cierre_caja_periodo ON public.cierre_caja USING btree (periodo_caja) WHERE (periodo_caja IS NOT NULL);

-- Name: ux_periodo_caja_vigente; Type: INDEX; Schema: public; Owner: -

CREATE UNIQUE INDEX ux_periodo_caja_vigente ON public.periodo_caja USING btree ((true)) WHERE ((estado)::text <> 'CERRADO'::text);

-- Name: anulacion_devolucion anulacion_inmutable; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER anulacion_inmutable BEFORE DELETE OR UPDATE ON public.anulacion_devolucion FOR EACH ROW EXECUTE FUNCTION public.nota_inmutable();

-- Name: anulacion_devolucion anulacion_periodo_caja_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER anulacion_periodo_caja_trg BEFORE INSERT ON public.anulacion_devolucion FOR EACH ROW EXECUTE FUNCTION public.anulacion_periodo_caja();

-- Name: anulacion_devolucion anulacion_valida; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER anulacion_valida BEFORE INSERT ON public.anulacion_devolucion FOR EACH ROW EXECUTE FUNCTION public.anulacion_valida();

-- Name: cierre_caja_empleado cierre_caja_empleado_inmutable_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER cierre_caja_empleado_inmutable_trg BEFORE DELETE OR UPDATE ON public.cierre_caja_empleado FOR EACH ROW EXECUTE FUNCTION public.caja_inmutable();

-- Name: cierre_caja cierre_caja_inmutable_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER cierre_caja_inmutable_trg BEFORE DELETE OR UPDATE ON public.cierre_caja FOR EACH ROW EXECUTE FUNCTION public.caja_inmutable();

-- Name: cierre_caja cierre_caja_integro_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE CONSTRAINT TRIGGER cierre_caja_integro_trg AFTER INSERT ON public.cierre_caja DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.cierre_caja_integro();

-- Name: cierre_caja_metodo_pago cierre_caja_metodo_pago_inmutable_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER cierre_caja_metodo_pago_inmutable_trg BEFORE DELETE OR UPDATE ON public.cierre_caja_metodo_pago FOR EACH ROW EXECUTE FUNCTION public.caja_inmutable();

-- Name: detalle_devolucion detalle_devolucion_inmutable; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER detalle_devolucion_inmutable BEFORE DELETE OR UPDATE ON public.detalle_devolucion FOR EACH ROW EXECUTE FUNCTION public.nota_inmutable();

-- Name: detalle_factura detalle_factura_inmutable; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER detalle_factura_inmutable BEFORE DELETE OR UPDATE ON public.detalle_factura FOR EACH ROW EXECUTE FUNCTION public.factura_inmutable();

-- Name: detalle_factura detalle_factura_receta; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER detalle_factura_receta BEFORE INSERT ON public.detalle_factura FOR EACH ROW EXECUTE FUNCTION public.detalle_factura_exige_receta();

-- Name: detalle_recepcion detalle_recepcion_inmutable_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER detalle_recepcion_inmutable_trg BEFORE DELETE OR UPDATE ON public.detalle_recepcion FOR EACH ROW EXECUTE FUNCTION public.recepcion_inmutable();

-- Name: detalle_devolucion devolucion_linea_valida; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER devolucion_linea_valida BEFORE INSERT ON public.detalle_devolucion FOR EACH ROW EXECUTE FUNCTION public.devolucion_linea_valida();

-- Name: devolucion_pago devolucion_pago_inmutable; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER devolucion_pago_inmutable BEFORE DELETE OR UPDATE ON public.devolucion_pago FOR EACH ROW EXECUTE FUNCTION public.nota_inmutable();

-- Name: diferencia_recepcion diferencia_recepcion_inmutable_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER diferencia_recepcion_inmutable_trg BEFORE DELETE OR UPDATE ON public.diferencia_recepcion FOR EACH ROW EXECUTE FUNCTION public.recepcion_inmutable();

-- Name: factura factura_completa; Type: TRIGGER; Schema: public; Owner: -

CREATE CONSTRAINT TRIGGER factura_completa AFTER INSERT ON public.factura DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.factura_integra();

-- Name: factura factura_emitida_inmutable; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER factura_emitida_inmutable BEFORE DELETE OR UPDATE ON public.factura FOR EACH ROW EXECUTE FUNCTION public.factura_inmutable();

-- Name: factura factura_estado_no_retrocede; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER factura_estado_no_retrocede BEFORE UPDATE ON public.factura FOR EACH ROW EXECUTE FUNCTION public.factura_estado_no_retrocede();

-- Name: factura factura_periodo_caja_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER factura_periodo_caja_trg BEFORE INSERT ON public.factura FOR EACH ROW EXECUTE FUNCTION public.factura_periodo_caja();

-- Name: anulacion_devolucion nota_completa; Type: TRIGGER; Schema: public; Owner: -

CREATE CONSTRAINT TRIGGER nota_completa AFTER INSERT ON public.anulacion_devolucion DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.nota_integra();

-- Name: pedido pedido_proveedor_activo_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER pedido_proveedor_activo_trg BEFORE INSERT ON public.pedido FOR EACH ROW EXECUTE FUNCTION public.pedido_proveedor_activo();

-- Name: pedido pedido_transicion_estado_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER pedido_transicion_estado_trg BEFORE UPDATE OF estado ON public.pedido FOR EACH ROW EXECUTE FUNCTION public.pedido_transicion_estado();

-- Name: periodo_caja periodo_caja_transicion_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER periodo_caja_transicion_trg BEFORE DELETE OR UPDATE ON public.periodo_caja FOR EACH ROW EXECUTE FUNCTION public.periodo_caja_transicion();

-- Name: recepcion recepcion_inmutable_trg; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER recepcion_inmutable_trg BEFORE DELETE OR UPDATE ON public.recepcion FOR EACH ROW EXECUTE FUNCTION public.recepcion_inmutable();

-- Name: receta_medicamento receta_medicamento_registrada_inmutable; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER receta_medicamento_registrada_inmutable BEFORE DELETE OR UPDATE ON public.receta_medicamento FOR EACH ROW EXECUTE FUNCTION public.receta_inmutable();

-- Name: receta receta_registrada_inmutable; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER receta_registrada_inmutable BEFORE DELETE OR UPDATE ON public.receta FOR EACH ROW EXECUTE FUNCTION public.receta_inmutable();

-- Name: registro_actividad registro_actividad_inmutable; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER registro_actividad_inmutable BEFORE DELETE OR UPDATE ON public.registro_actividad FOR EACH ROW EXECUTE FUNCTION public.auditoria_inmutable();

-- Name: registro_actividad registro_actividad_sin_truncate; Type: TRIGGER; Schema: public; Owner: -

CREATE TRIGGER registro_actividad_sin_truncate BEFORE TRUNCATE ON public.registro_actividad FOR EACH STATEMENT EXECUTE FUNCTION public.auditoria_inmutable();

-- Name: alerta alerta_id_empleado_vista_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.alerta
    ADD CONSTRAINT alerta_id_empleado_vista_fkey FOREIGN KEY (id_empleado_vista) REFERENCES public.empleado_ref(id_empleado);

-- Name: alerta alerta_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.alerta
    ADD CONSTRAINT alerta_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento_ref(id_medicamento);

-- Name: alerta alerta_lote_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.alerta
    ADD CONSTRAINT alerta_lote_fkey FOREIGN KEY (id_lote, id_medicamento) REFERENCES public.lote(id_lote, id_medicamento);

-- Name: anulacion_devolucion anulacion_devolucion_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.anulacion_devolucion
    ADD CONSTRAINT anulacion_devolucion_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: anulacion_devolucion anulacion_devolucion_id_factura_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.anulacion_devolucion
    ADD CONSTRAINT anulacion_devolucion_id_factura_fkey FOREIGN KEY (id_factura) REFERENCES public.factura(id_factura);

-- Name: anulacion_devolucion anulacion_devolucion_periodo_caja_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.anulacion_devolucion
    ADD CONSTRAINT anulacion_devolucion_periodo_caja_fkey FOREIGN KEY (periodo_caja) REFERENCES public.periodo_caja(periodo);

-- Name: auth_operacion auth_operacion_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.auth_operacion
    ADD CONSTRAINT auth_operacion_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: cierre_caja_empleado cierre_caja_empleado_id_cierre_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja_empleado
    ADD CONSTRAINT cierre_caja_empleado_id_cierre_fkey FOREIGN KEY (id_cierre) REFERENCES public.cierre_caja(id_cierre);

-- Name: cierre_caja_empleado cierre_caja_empleado_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja_empleado
    ADD CONSTRAINT cierre_caja_empleado_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: cierre_caja_empleado cierre_caja_empleado_id_metodo_pago_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja_empleado
    ADD CONSTRAINT cierre_caja_empleado_id_metodo_pago_fkey FOREIGN KEY (id_metodo_pago) REFERENCES public.metodo_pago_ref(id_metodo_pago);

-- Name: cierre_caja cierre_caja_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja
    ADD CONSTRAINT cierre_caja_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: cierre_caja_metodo_pago cierre_caja_metodo_pago_id_cierre_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja_metodo_pago
    ADD CONSTRAINT cierre_caja_metodo_pago_id_cierre_fkey FOREIGN KEY (id_cierre) REFERENCES public.cierre_caja(id_cierre) ON DELETE CASCADE;

-- Name: cierre_caja_metodo_pago cierre_caja_metodo_pago_id_metodo_pago_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja_metodo_pago
    ADD CONSTRAINT cierre_caja_metodo_pago_id_metodo_pago_fkey FOREIGN KEY (id_metodo_pago) REFERENCES public.metodo_pago_ref(id_metodo_pago);

-- Name: cierre_caja cierre_caja_periodo_caja_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cierre_caja
    ADD CONSTRAINT cierre_caja_periodo_caja_fkey FOREIGN KEY (periodo_caja) REFERENCES public.periodo_caja(periodo);

-- Name: control_acceso control_acceso_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.control_acceso
    ADD CONSTRAINT control_acceso_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: cursor_sync cursor_sync_id_tienda_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.cursor_sync
    ADD CONSTRAINT cursor_sync_id_tienda_fkey FOREIGN KEY (id_tienda) REFERENCES public.tienda_ref(id_tienda);

-- Name: detalle_devolucion detalle_devolucion_id_anulacion_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_devolucion
    ADD CONSTRAINT detalle_devolucion_id_anulacion_fkey FOREIGN KEY (id_anulacion) REFERENCES public.anulacion_devolucion(id_anulacion) ON DELETE CASCADE;

-- Name: detalle_devolucion detalle_devolucion_id_lote_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_devolucion
    ADD CONSTRAINT detalle_devolucion_id_lote_fkey FOREIGN KEY (id_lote) REFERENCES public.lote(id_lote);

-- Name: detalle_factura detalle_factura_id_factura_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_factura
    ADD CONSTRAINT detalle_factura_id_factura_fkey FOREIGN KEY (id_factura) REFERENCES public.factura(id_factura) ON DELETE CASCADE;

-- Name: detalle_factura detalle_factura_id_lote_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_factura
    ADD CONSTRAINT detalle_factura_id_lote_fkey FOREIGN KEY (id_lote) REFERENCES public.lote(id_lote);

-- Name: detalle_factura detalle_factura_id_receta_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_factura
    ADD CONSTRAINT detalle_factura_id_receta_fkey FOREIGN KEY (id_receta) REFERENCES public.receta(id_receta);

-- Name: detalle_pedido detalle_pedido_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_pedido
    ADD CONSTRAINT detalle_pedido_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento_ref(id_medicamento);

-- Name: detalle_pedido detalle_pedido_id_pedido_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_pedido
    ADD CONSTRAINT detalle_pedido_id_pedido_fkey FOREIGN KEY (id_pedido) REFERENCES public.pedido(id_pedido) ON DELETE CASCADE;

-- Name: detalle_recepcion detalle_recepcion_id_lote_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_recepcion
    ADD CONSTRAINT detalle_recepcion_id_lote_fkey FOREIGN KEY (id_lote) REFERENCES public.lote(id_lote);

-- Name: detalle_recepcion detalle_recepcion_id_recepcion_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.detalle_recepcion
    ADD CONSTRAINT detalle_recepcion_id_recepcion_fkey FOREIGN KEY (id_recepcion) REFERENCES public.recepcion(id_recepcion);

-- Name: devolucion_pago devolucion_pago_id_anulacion_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.devolucion_pago
    ADD CONSTRAINT devolucion_pago_id_anulacion_fkey FOREIGN KEY (id_anulacion) REFERENCES public.anulacion_devolucion(id_anulacion);

-- Name: devolucion_pago devolucion_pago_id_metodo_pago_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.devolucion_pago
    ADD CONSTRAINT devolucion_pago_id_metodo_pago_fkey FOREIGN KEY (id_metodo_pago) REFERENCES public.metodo_pago_ref(id_metodo_pago);

-- Name: diferencia_recepcion diferencia_recepcion_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.diferencia_recepcion
    ADD CONSTRAINT diferencia_recepcion_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: diferencia_recepcion diferencia_recepcion_linea_pedido_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.diferencia_recepcion
    ADD CONSTRAINT diferencia_recepcion_linea_pedido_fkey FOREIGN KEY (id_pedido, id_medicamento) REFERENCES public.detalle_pedido(id_pedido, id_medicamento);

-- Name: diferencia_recepcion diferencia_recepcion_recepcion_pedido_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.diferencia_recepcion
    ADD CONSTRAINT diferencia_recepcion_recepcion_pedido_fkey FOREIGN KEY (id_recepcion, id_pedido) REFERENCES public.recepcion(id_recepcion, id_pedido);

-- Name: empleado_ref empleado_ref_id_rol_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.empleado_ref
    ADD CONSTRAINT empleado_ref_id_rol_fkey FOREIGN KEY (id_rol) REFERENCES public.rol_ref(id_rol);

-- Name: empleado_ref empleado_ref_id_tienda_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.empleado_ref
    ADD CONSTRAINT empleado_ref_id_tienda_fkey FOREIGN KEY (id_tienda) REFERENCES public.tienda_ref(id_tienda);

-- Name: factura factura_id_cliente_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.factura
    ADD CONSTRAINT factura_id_cliente_fkey FOREIGN KEY (id_cliente) REFERENCES public.cliente(id_cliente);

-- Name: factura factura_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.factura
    ADD CONSTRAINT factura_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: factura_metodo_pago factura_metodo_pago_id_factura_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.factura_metodo_pago
    ADD CONSTRAINT factura_metodo_pago_id_factura_fkey FOREIGN KEY (id_factura) REFERENCES public.factura(id_factura) ON DELETE CASCADE;

-- Name: factura_metodo_pago factura_metodo_pago_id_metodo_pago_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.factura_metodo_pago
    ADD CONSTRAINT factura_metodo_pago_id_metodo_pago_fkey FOREIGN KEY (id_metodo_pago) REFERENCES public.metodo_pago_ref(id_metodo_pago);

-- Name: factura factura_periodo_caja_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.factura
    ADD CONSTRAINT factura_periodo_caja_fkey FOREIGN KEY (periodo_caja) REFERENCES public.periodo_caja(periodo);

-- Name: movimiento_inventario fk_movimiento_traslado; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.movimiento_inventario
    ADD CONSTRAINT fk_movimiento_traslado FOREIGN KEY (id_traslado, rol_tienda_traslado) REFERENCES public.traslado_local(id_traslado, rol_tienda);

-- Name: intento_acceso intento_acceso_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.intento_acceso
    ADD CONSTRAINT intento_acceso_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: lote lote_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.lote
    ADD CONSTRAINT lote_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento_ref(id_medicamento);

-- Name: lote lote_id_proveedor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.lote
    ADD CONSTRAINT lote_id_proveedor_fkey FOREIGN KEY (id_proveedor) REFERENCES public.proveedor_ref(id_proveedor);

-- Name: medicamento_proveedor_ref medicamento_proveedor_ref_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.medicamento_proveedor_ref
    ADD CONSTRAINT medicamento_proveedor_ref_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento_ref(id_medicamento);

-- Name: medicamento_proveedor_ref medicamento_proveedor_ref_id_proveedor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.medicamento_proveedor_ref
    ADD CONSTRAINT medicamento_proveedor_ref_id_proveedor_fkey FOREIGN KEY (id_proveedor) REFERENCES public.proveedor_ref(id_proveedor);

-- Name: medicamento_ref medicamento_ref_id_categoria_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.medicamento_ref
    ADD CONSTRAINT medicamento_ref_id_categoria_fkey FOREIGN KEY (id_categoria) REFERENCES public.categoria_ref(id_categoria);

-- Name: movimiento_inventario movimiento_inventario_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.movimiento_inventario
    ADD CONSTRAINT movimiento_inventario_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: movimiento_inventario movimiento_inventario_id_lote_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.movimiento_inventario
    ADD CONSTRAINT movimiento_inventario_id_lote_fkey FOREIGN KEY (id_lote) REFERENCES public.lote(id_lote);

-- Name: outbox_sync outbox_sync_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.outbox_sync
    ADD CONSTRAINT outbox_sync_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: pedido pedido_id_alerta_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.pedido
    ADD CONSTRAINT pedido_id_alerta_fkey FOREIGN KEY (id_alerta) REFERENCES public.alerta(id_alerta);

-- Name: pedido pedido_id_empleado_solicitante_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.pedido
    ADD CONSTRAINT pedido_id_empleado_solicitante_fkey FOREIGN KEY (id_empleado_solicitante) REFERENCES public.empleado_ref(id_empleado);

-- Name: pedido pedido_id_proveedor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.pedido
    ADD CONSTRAINT pedido_id_proveedor_fkey FOREIGN KEY (id_proveedor) REFERENCES public.proveedor_ref(id_proveedor);

-- Name: periodo_caja periodo_caja_id_empleado_apertura_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.periodo_caja
    ADD CONSTRAINT periodo_caja_id_empleado_apertura_fkey FOREIGN KEY (id_empleado_apertura) REFERENCES public.empleado_ref(id_empleado);

-- Name: precio_ref precio_ref_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.precio_ref
    ADD CONSTRAINT precio_ref_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento_ref(id_medicamento);

-- Name: recepcion recepcion_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.recepcion
    ADD CONSTRAINT recepcion_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: recepcion recepcion_id_pedido_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.recepcion
    ADD CONSTRAINT recepcion_id_pedido_fkey FOREIGN KEY (id_pedido) REFERENCES public.pedido(id_pedido);

-- Name: receta receta_id_cliente_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.receta
    ADD CONSTRAINT receta_id_cliente_fkey FOREIGN KEY (id_cliente) REFERENCES public.cliente(id_cliente);

-- Name: receta receta_id_empleado_registro_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.receta
    ADD CONSTRAINT receta_id_empleado_registro_fkey FOREIGN KEY (id_empleado_registro) REFERENCES public.empleado_ref(id_empleado);

-- Name: receta_medicamento receta_medicamento_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.receta_medicamento
    ADD CONSTRAINT receta_medicamento_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento_ref(id_medicamento);

-- Name: receta_medicamento receta_medicamento_id_receta_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.receta_medicamento
    ADD CONSTRAINT receta_medicamento_id_receta_fkey FOREIGN KEY (id_receta) REFERENCES public.receta(id_receta) ON DELETE CASCADE;

-- Name: registro_actividad registro_actividad_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.registro_actividad
    ADD CONSTRAINT registro_actividad_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: rol_permiso_ref rol_permiso_ref_id_permiso_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.rol_permiso_ref
    ADD CONSTRAINT rol_permiso_ref_id_permiso_fkey FOREIGN KEY (id_permiso) REFERENCES public.permiso_ref(id_permiso);

-- Name: rol_permiso_ref rol_permiso_ref_id_rol_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.rol_permiso_ref
    ADD CONSTRAINT rol_permiso_ref_id_rol_fkey FOREIGN KEY (id_rol) REFERENCES public.rol_ref(id_rol);

-- Name: secuencia_documento secuencia_documento_id_tienda_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.secuencia_documento
    ADD CONSTRAINT secuencia_documento_id_tienda_fkey FOREIGN KEY (id_tienda) REFERENCES public.tienda_ref(id_tienda);

-- Name: sesion_activa sesion_activa_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.sesion_activa
    ADD CONSTRAINT sesion_activa_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: sync_conflicto sync_conflicto_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.sync_conflicto
    ADD CONSTRAINT sync_conflicto_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado_ref(id_empleado);

-- Name: tienda_ref tienda_ref_id_politica_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.tienda_ref
    ADD CONSTRAINT tienda_ref_id_politica_fkey FOREIGN KEY (id_politica) REFERENCES public.politica_sistema(id);

-- Name: traslado_local traslado_local_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.traslado_local
    ADD CONSTRAINT traslado_local_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento_ref(id_medicamento);

-- Name: traslado_local traslado_local_id_tienda_destino_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.traslado_local
    ADD CONSTRAINT traslado_local_id_tienda_destino_fkey FOREIGN KEY (id_tienda_destino) REFERENCES public.tienda_ref(id_tienda);

-- Name: traslado_local traslado_local_id_tienda_origen_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY public.traslado_local
    ADD CONSTRAINT traslado_local_id_tienda_origen_fkey FOREIGN KEY (id_tienda_origen) REFERENCES public.tienda_ref(id_tienda);

\unrestrict pbyxJ2NiIttfoTXxCE3t751729vkTgsNZEq3ejrbd0QtYc1IPuYwpgwm0HWitt6


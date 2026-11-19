-- ============================================================================
--  SCRIPT DE CREACIÓN - BASE DE DATOS DEL NODO CENTRAL (catálogo corporativo, consolidación y reglas de la red)
--  Proyecto: Sistema de Gestión de Franquicia de Farmacias (FarmaHub)
--  Modelo relacional refinado: 27 tablas, todas relacionadas y sin ciclos (docs/modelo-datos/relaciones.md).
--
--  Uso: sobre una base VACÍA (en Neon la base ya existe; este script no la crea):
--      psql "<cadena de conexión del nodo>" -v ON_ERROR_STOP=1 -f <este archivo>
--
--  Generado desde la base que crean los scripts db/central/00..20 (los que aplica apps/api/migrate.mjs al arrancar),
--  con pg_dump: tablas, llaves, índices, funciones, vistas, disparadores y los datos base del sistema (roles, permisos,
--  métodos de pago, parámetros). No incluye datos de negocio ni cuentas. Tras correrlo, el arranque de la API no cambia
--  el esquema.
-- ============================================================================

BEGIN;

--
-- PostgreSQL database dump
--

\restrict tfnRnr9WXWRQHIrfdAyg4vbnJogv2fMk1xWRKL2Sj4quL2FehOw5CJ3OiYQ1B1d

-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: append_replica_evento(integer, character varying, bigint, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.append_replica_evento(p_destino integer, p_tipo character varying, p_version bigint, p_payload jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_id bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(814206);
    SELECT COALESCE(MAX(id_evento), 0) + 1 INTO v_id FROM replica_evento;
    INSERT INTO replica_evento (id_evento, id_tienda_destino, tipo_evento, version_credencial, payload)
    VALUES (v_id, p_destino, p_tipo, p_version, p_payload);
    RETURN v_id;
END;
$$;


--
-- Name: auditoria_inmutable(); Type: FUNCTION; Schema: public; Owner: -
--

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


--
-- Name: exigir_umbral_medicamento(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.exigir_umbral_medicamento() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.activo AND EXISTS (
        SELECT 1 FROM tienda t
         WHERE t.activa
           AND NOT EXISTS (SELECT 1 FROM medicamento_tienda u
                            WHERE u.id_tienda = t.id_tienda AND u.id_medicamento = NEW.id_medicamento AND u.stock_minimo IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'MEDICAMENTO_SIN_UMBRAL: % necesita stock mínimo y días de aviso en cada tienda activa', NEW.nombre_comercial
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: exigir_umbral_tienda(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.exigir_umbral_tienda() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.activa AND EXISTS (
        SELECT 1 FROM medicamento m
         WHERE m.activo
           AND NOT EXISTS (SELECT 1 FROM medicamento_tienda u
                            WHERE u.id_tienda = NEW.id_tienda AND u.id_medicamento = m.id_medicamento AND u.stock_minimo IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'TIENDA_SIN_UMBRALES: la tienda % necesita un umbral para cada medicamento activo', NEW.nombre
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: fold_evento(integer, uuid, character varying, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fold_evento(p_origen integer, p_key uuid, p_tipo character varying, p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_inserted integer;
    v_emp integer;
    v_obs bigint;
    v_actual bigint;
    v_epoch_obs bigint;
    v_state control_acceso%ROWTYPE;
    v_intentos integer;
    v_until timestamp with time zone;
    v_observo boolean;
    v_max integer;
    v_min integer;
BEGIN
    INSERT INTO inbox_sync (id_tienda_origen, idempotency_key, tipo_evento, payload)
    VALUES (p_origen, p_key, p_tipo, p_payload)
    ON CONFLICT (id_tienda_origen, idempotency_key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
        RETURN jsonb_build_object('duplicado', true);
    END IF;

    SELECT intentos_maximos, minutos_bloqueo INTO v_max, v_min
    FROM politica_sistema WHERE id = 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'politica_sistema ausente';
    END IF;

    v_emp := (p_payload ->> 'id_empleado')::integer;
    IF v_emp IS NULL THEN
        RETURN jsonb_build_object('ignorado', true);
    END IF;

    INSERT INTO control_acceso (id_empleado) VALUES (v_emp) ON CONFLICT DO NOTHING;
    SELECT * INTO v_state FROM control_acceso WHERE id_empleado = v_emp FOR UPDATE;
    SELECT version_credencial INTO v_actual FROM empleado WHERE id_empleado = v_emp;
    IF v_actual IS NULL THEN
        RAISE EXCEPTION 'empleado % no existe', v_emp;
    END IF;

    v_obs := (p_payload ->> 'version_credencial_observada')::bigint;
    v_epoch_obs := (p_payload ->> 'epoch_observado')::bigint;
    v_observo := COALESCE((p_payload ->> 'observo_expiracion')::boolean, false);

    IF v_obs IS NOT NULL AND v_obs < v_actual THEN
        INSERT INTO registro_actividad_central (id_empleado, accion, entidad_afectada, detalle)
        VALUES (
            v_emp,
            'CREDENCIAL_OBSOLETA',
            'sesion',
            left('version observada ' || v_obs || ' < ' || v_actual, 400)
        );
        PERFORM publicar_snapshot(v_emp, true);
        RETURN jsonb_build_object('obsoleto', true);
    END IF;

    IF p_tipo = 'EXPIRADO' THEN
        IF v_epoch_obs IS NOT NULL
           AND v_epoch_obs = v_state.epoch
           AND v_state.estado = 'BLOQUEADO' THEN
            UPDATE control_acceso
            SET epoch = epoch + 1,
                intentos_en_epoch = 0,
                estado = 'ACTIVO',
                bloqueado_hasta = NULL,
                provisional = false,
                provisional_hasta = NULL
            WHERE id_empleado = v_emp;
            PERFORM publicar_snapshot(v_emp, false);
        END IF;
        RETURN jsonb_build_object('expirado', true);
    END IF;

    IF v_state.estado = 'BLOQUEADO'
       AND v_state.bloqueado_hasta IS NOT NULL
       AND v_state.bloqueado_hasta <= now() THEN
        UPDATE control_acceso
        SET epoch = epoch + 1,
            intentos_en_epoch = 0,
            estado = 'ACTIVO',
            bloqueado_hasta = NULL,
            provisional = false,
            provisional_hasta = NULL
        WHERE id_empleado = v_emp;
        PERFORM publicar_snapshot(v_emp, false);
        SELECT * INTO v_state FROM control_acceso WHERE id_empleado = v_emp FOR UPDATE;
        IF p_tipo = 'SUCCESS' THEN
            RETURN jsonb_build_object('expirado', true, 'epoch', v_state.epoch);
        END IF;
    ELSIF v_observo
          AND p_tipo = 'FAIL'
          AND v_state.estado = 'BLOQUEADO'
          AND v_epoch_obs IS NOT NULL
          AND v_epoch_obs = v_state.epoch THEN
        UPDATE control_acceso
        SET epoch = epoch + 1,
            intentos_en_epoch = 0,
            estado = 'ACTIVO',
            bloqueado_hasta = NULL,
            provisional = false,
            provisional_hasta = NULL
        WHERE id_empleado = v_emp;
        PERFORM publicar_snapshot(v_emp, false);
        SELECT * INTO v_state FROM control_acceso WHERE id_empleado = v_emp FOR UPDATE;
    END IF;

    IF p_tipo = 'SUCCESS' THEN
        IF v_state.estado = 'BLOQUEADO' THEN
            UPDATE sesion_activa SET revocada = true WHERE id_empleado = v_emp AND revocada = false;
            PERFORM append_replica_evento(
                (SELECT id_tienda FROM empleado WHERE id_empleado = v_emp),
                'SESION_REVOCAR',
                v_actual,
                jsonb_build_object('id_empleado', v_emp)
            );
            RETURN jsonb_build_object('sin_reset', true, 'bloqueado_hasta', v_state.bloqueado_hasta);
        END IF;
        UPDATE control_acceso
        SET epoch = epoch + 1,
            intentos_en_epoch = 0,
            estado = 'ACTIVO',
            bloqueado_hasta = NULL,
            provisional = false,
            provisional_hasta = NULL
        WHERE id_empleado = v_emp AND estado = 'ACTIVO';
        PERFORM publicar_snapshot(v_emp, false);
        RETURN jsonb_build_object('ok', true);
    END IF;

    IF p_tipo = 'FAIL' THEN
        IF v_epoch_obs IS NOT NULL AND v_epoch_obs < v_state.epoch AND NOT v_observo THEN
            RETURN jsonb_build_object('fail_viejo', true);
        END IF;
        IF v_state.estado = 'BLOQUEADO'
           AND v_state.bloqueado_hasta IS NOT NULL
           AND v_state.bloqueado_hasta > now() THEN
            RETURN jsonb_build_object('ya_bloqueado', true, 'bloqueado_hasta', v_state.bloqueado_hasta);
        END IF;
        v_intentos := v_state.intentos_en_epoch + 1;
        IF v_intentos >= v_max THEN
            -- La fila está bloqueada (FOR UPDATE): solo el primer bloqueo de la época fija el fin.
            IF v_state.epoch_bloqueo IS NOT DISTINCT FROM v_state.epoch AND v_state.bloqueo_canonico_hasta IS NOT NULL THEN
                v_until := v_state.bloqueo_canonico_hasta;
            ELSE
                v_until := now() + make_interval(mins => v_min);
            END IF;
            UPDATE control_acceso
            SET intentos_en_epoch = v_max,
                estado = 'BLOQUEADO',
                bloqueado_hasta = v_until,
                epoch_bloqueo = v_state.epoch,
                bloqueo_canonico_hasta = v_until,
                provisional = false,
                provisional_hasta = NULL
            WHERE id_empleado = v_emp;
            PERFORM publicar_snapshot(v_emp, true);
            RETURN jsonb_build_object('bloqueado', true, 'bloqueado_hasta', v_until, 'epoch', v_state.epoch);
        END IF;
        UPDATE control_acceso
        SET intentos_en_epoch = v_intentos
        WHERE id_empleado = v_emp;
        PERFORM publicar_snapshot(v_emp, false);
        RETURN jsonb_build_object('intentos', v_intentos, 'epoch', v_state.epoch);
    END IF;

    RETURN jsonb_build_object('ignorado', true);
END;
$$;


--
-- Name: precio_historial_inmutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.precio_historial_inmutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.fecha_inicio_vigencia > now()::timestamp THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        IF NEW.fecha_inicio_vigencia < now()::timestamp THEN
            RAISE EXCEPTION 'Un precio no puede empezar en el pasado' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.id_medicamento = OLD.id_medicamento
       AND NEW.precio = OLD.precio
       AND NEW.fecha_inicio_vigencia = OLD.fecha_inicio_vigencia
       AND NEW.id_empleado_registro IS NOT DISTINCT FROM OLD.id_empleado_registro
       AND (NEW.fecha_fin_vigencia IS NULL OR NEW.fecha_fin_vigencia >= now()::timestamp)
       AND (OLD.fecha_fin_vigencia IS NULL OR OLD.fecha_fin_vigencia >= now()::timestamp) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'El historial de precios no se puede modificar (precio % ya rigió)', OLD.id_precio
        USING ERRCODE = '42501';
END;
$$;


--
-- Name: publicar_snapshot(integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publicar_snapshot(p_emp integer, p_revocar boolean) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_state control_acceso%ROWTYPE;
    v_snap bigint;
    v_tienda integer;
    v_version bigint;
BEGIN
    SELECT * INTO v_state FROM control_acceso WHERE id_empleado = p_emp FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    v_snap := nextval('control_acceso_snapshot_seq');
    UPDATE control_acceso SET id_snapshot = v_snap WHERE id_empleado = p_emp;
    SELECT id_tienda, version_credencial INTO v_tienda, v_version
    FROM empleado WHERE id_empleado = p_emp;
    PERFORM append_replica_evento(
        v_tienda,
        'CONTROL_ACCESO_SNAPSHOT',
        v_version,
        jsonb_build_object(
            'id_empleado', p_emp,
            'epoch', v_state.epoch,
            'intentos_en_epoch', v_state.intentos_en_epoch,
            'estado', v_state.estado,
            'bloqueado_hasta', v_state.bloqueado_hasta,
            'id_snapshot', v_snap,
            'version_credencial', v_version
        )
    );
    IF p_revocar THEN
        UPDATE sesion_activa SET revocada = true WHERE id_empleado = p_emp AND revocada = false;
        PERFORM append_replica_evento(
            v_tienda,
            'SESION_REVOCAR',
            v_version,
            jsonb_build_object('id_empleado', p_emp, 'id_snapshot', v_snap)
        );
    END IF;
    RETURN v_snap;
END;
$$;


--
-- Name: receta_vigente(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.receta_vigente(p_fecha_emision date) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT p_fecha_emision <= current_date
       AND current_date - p_fecha_emision <= (SELECT dias_vigencia FROM politica_sistema WHERE id = 1);
$$;


--
-- Name: traslado_transicion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.traslado_transicion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.estado = OLD.estado THEN
        RETURN NEW;
    END IF;
    IF (OLD.estado = 'SOLICITADO' AND NEW.estado IN ('EN_TRANSITO', 'FALLIDO'))
       OR (OLD.estado = 'EN_TRANSITO' AND NEW.estado IN ('COMPLETADO', 'COMPENSANDO'))
       OR (OLD.estado = 'COMPENSANDO' AND NEW.estado = 'COMPENSADO') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'TRASLADO_TRANSICION: % -> % no permitida en el traslado %', OLD.estado, NEW.estado, OLD.id_traslado USING ERRCODE = '23514';
END;
$$;


SET default_tablespace = '';


--
-- Name: auth_operacion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_operacion (
    idempotency_key uuid NOT NULL,
    payload_hmac character(64) NOT NULL,
    resultado_http integer NOT NULL,
    cuerpo_json jsonb NOT NULL,
    token_entrega text,
    creado_en timestamp with time zone DEFAULT now() NOT NULL,
    id_empleado integer
);


--
-- Name: categoria_id_categoria_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.categoria_id_categoria_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categoria; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categoria (
    id_categoria integer DEFAULT nextval('public.categoria_id_categoria_seq'::regclass) NOT NULL,
    nombre character varying(80) NOT NULL
);


--
-- Name: codigo_restablecimiento; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.codigo_restablecimiento (
    id_codigo bigint NOT NULL,
    id_empleado integer NOT NULL,
    codigo_hmac character(64) NOT NULL,
    estado character varying(12) DEFAULT 'VIGENTE'::character varying NOT NULL,
    intentos integer DEFAULT 0 NOT NULL,
    expira_en timestamp with time zone NOT NULL,
    generado_por integer NOT NULL,
    creado_en timestamp with time zone DEFAULT now() NOT NULL,
    usado_en timestamp with time zone,
    CONSTRAINT codigo_restablecimiento_estado_check CHECK (((estado)::text = ANY ((ARRAY['VIGENTE'::character varying, 'USADO'::character varying, 'ANULADO'::character varying, 'BLOQUEADO'::character varying])::text[])))
);


--
-- Name: codigo_restablecimiento_id_codigo_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.codigo_restablecimiento ALTER COLUMN id_codigo ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.codigo_restablecimiento_id_codigo_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: control_acceso; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.control_acceso (
    id_empleado integer NOT NULL,
    epoch bigint DEFAULT 1 NOT NULL,
    intentos_en_epoch integer DEFAULT 0 NOT NULL,
    estado character varying(20) DEFAULT 'ACTIVO'::character varying NOT NULL,
    bloqueado_hasta timestamp with time zone,
    provisional boolean DEFAULT false NOT NULL,
    provisional_hasta timestamp with time zone,
    id_snapshot bigint DEFAULT 0 NOT NULL,
    epoch_bloqueo bigint,
    bloqueo_canonico_hasta timestamp with time zone,
    CONSTRAINT control_acceso_estado_check CHECK (((estado)::text = ANY ((ARRAY['ACTIVO'::character varying, 'BLOQUEADO'::character varying])::text[])))
);


--
-- Name: control_acceso_snapshot_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.control_acceso_snapshot_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: empleado_id_empleado_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.empleado_id_empleado_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: empleado; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.empleado (
    id_empleado integer DEFAULT nextval('public.empleado_id_empleado_seq'::regclass) NOT NULL,
    id_tienda integer NOT NULL,
    id_rol integer NOT NULL,
    nombre_completo character varying(150) NOT NULL,
    usuario character varying(60) NOT NULL,
    contrasena_hash character varying(255) NOT NULL,
    correo character varying(120),
    activo boolean DEFAULT true NOT NULL,
    fecha_creacion timestamp without time zone DEFAULT now() NOT NULL,
    fecha_baja timestamp without time zone,
    version_credencial bigint DEFAULT 1 NOT NULL,
    version_cuenta bigint DEFAULT 1 NOT NULL
);


--
-- Name: inbox_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_sync (
    id_tienda_origen integer NOT NULL,
    idempotency_key uuid NOT NULL,
    tipo_evento character varying(40) NOT NULL,
    payload jsonb NOT NULL,
    aplicado_en timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: intento_acceso; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intento_acceso (
    id_intento bigint NOT NULL,
    idempotency_key uuid NOT NULL,
    usuario_intentado character varying(60) NOT NULL,
    id_empleado integer,
    resultado character varying(40) NOT NULL,
    fecha_hora timestamp with time zone DEFAULT now() NOT NULL,
    detalle character varying(400)
);


--
-- Name: intento_acceso_id_intento_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.intento_acceso ALTER COLUMN id_intento ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.intento_acceso_id_intento_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: medicamento_id_medicamento_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.medicamento_id_medicamento_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: medicamento; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.medicamento (
    id_medicamento integer DEFAULT nextval('public.medicamento_id_medicamento_seq'::regclass) NOT NULL,
    codigo_interno character varying(40) NOT NULL,
    nombre_comercial character varying(150) NOT NULL,
    principio_activo character varying(150) NOT NULL,
    id_categoria integer,
    requiere_receta boolean DEFAULT false NOT NULL,
    requiere_refrigeracion boolean DEFAULT false NOT NULL,
    unidad_medida character varying(30) DEFAULT 'unidad'::character varying NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    tasa_impuesto numeric(5,2) DEFAULT 0 NOT NULL,
    CONSTRAINT medicamento_tasa_impuesto_check CHECK (((tasa_impuesto >= (0)::numeric) AND (tasa_impuesto <= (100)::numeric)))
);


--
-- Name: medicamento_proveedor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.medicamento_proveedor (
    id_proveedor integer NOT NULL,
    id_medicamento integer NOT NULL
);


--
-- Name: medicamento_tienda; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.medicamento_tienda (
    id_tienda integer NOT NULL,
    id_medicamento integer NOT NULL,
    stock_minimo integer,
    dias_alerta_caducidad integer,
    cantidad_disponible integer,
    fecha_sincronizacion timestamp without time zone,
    CONSTRAINT medicamento_tienda_dias_check CHECK ((dias_alerta_caducidad >= 0)),
    CONSTRAINT medicamento_tienda_stock_check CHECK (((cantidad_disponible IS NULL) = (fecha_sincronizacion IS NULL))),
    CONSTRAINT medicamento_tienda_stock_minimo_check CHECK ((stock_minimo >= 0)),
    CONSTRAINT medicamento_tienda_umbral_check CHECK (((stock_minimo IS NULL) = (dias_alerta_caducidad IS NULL)))
);


--
-- Name: metodo_pago_id_metodo_pago_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.metodo_pago_id_metodo_pago_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: metodo_pago; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metodo_pago (
    id_metodo_pago integer DEFAULT nextval('public.metodo_pago_id_metodo_pago_seq'::regclass) NOT NULL,
    nombre character varying(40) NOT NULL,
    activo boolean DEFAULT true NOT NULL
);


--
-- Name: permiso_id_permiso_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.permiso_id_permiso_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: permiso; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permiso (
    id_permiso integer DEFAULT nextval('public.permiso_id_permiso_seq'::regclass) NOT NULL,
    codigo character varying(60) NOT NULL,
    descripcion character varying(200)
);


--
-- Name: politica_sistema; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.politica_sistema (
    id integer NOT NULL,
    intentos_maximos integer NOT NULL,
    minutos_bloqueo integer NOT NULL,
    dias_vigencia integer DEFAULT 30 NOT NULL,
    minutos_reserva integer DEFAULT 15 NOT NULL,
    CONSTRAINT politica_sistema_dias_check CHECK ((dias_vigencia > 0)),
    CONSTRAINT politica_sistema_id_check CHECK ((id = 1)),
    CONSTRAINT politica_sistema_intentos_check CHECK ((intentos_maximos > 0)),
    CONSTRAINT politica_sistema_minutos_check CHECK ((minutos_bloqueo > 0)),
    CONSTRAINT politica_sistema_reserva_check CHECK ((minutos_reserva > 0))
);


--
-- Name: precio_medicamento_id_precio_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.precio_medicamento_id_precio_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: precio_medicamento; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.precio_medicamento (
    id_precio integer DEFAULT nextval('public.precio_medicamento_id_precio_seq'::regclass) NOT NULL,
    id_medicamento integer NOT NULL,
    precio numeric(12,2) NOT NULL,
    fecha_inicio_vigencia timestamp without time zone DEFAULT now() NOT NULL,
    fecha_fin_vigencia timestamp without time zone,
    id_empleado_registro integer,
    CONSTRAINT precio_medicamento_precio_check CHECK ((precio >= (0)::numeric)),
    CONSTRAINT precio_medicamento_vigencia_check CHECK (((fecha_fin_vigencia IS NULL) OR (fecha_fin_vigencia > fecha_inicio_vigencia)))
);


--
-- Name: proveedor_id_proveedor_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.proveedor_id_proveedor_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: proveedor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proveedor (
    id_proveedor integer DEFAULT nextval('public.proveedor_id_proveedor_seq'::regclass) NOT NULL,
    nombre_empresa character varying(150) NOT NULL,
    nit character varying(40) NOT NULL,
    telefono character varying(30),
    correo character varying(120),
    direccion character varying(200),
    activo boolean DEFAULT true NOT NULL
);


--
-- Name: receta_conflicto; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receta_conflicto (
    id_conflicto bigint NOT NULL,
    id_receta_emitida integer,
    codigo character varying(40) NOT NULL,
    id_tienda_origen integer NOT NULL,
    motivo character varying(200) NOT NULL,
    payload jsonb NOT NULL,
    creado_en timestamp with time zone DEFAULT now() NOT NULL,
    resuelto boolean DEFAULT false NOT NULL
);


--
-- Name: receta_conflicto_id_conflicto_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.receta_conflicto ALTER COLUMN id_conflicto ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.receta_conflicto_id_conflicto_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: receta_emitida; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receta_emitida (
    id_receta_emitida integer NOT NULL,
    codigo character varying(40) NOT NULL,
    paciente_nombre character varying(150) NOT NULL,
    paciente_documento character varying(40) NOT NULL,
    medico_prescriptor character varying(150) NOT NULL,
    fecha_emision date NOT NULL,
    estado character varying(20) DEFAULT 'EMITIDA'::character varying NOT NULL,
    id_tienda_reserva integer,
    id_empleado_reserva integer,
    reservada_hasta timestamp without time zone,
    id_tienda_reclamo integer,
    reclamada_en timestamp without time zone,
    id_empleado_emisor integer,
    creada_en timestamp without time zone DEFAULT now() NOT NULL,
    documento_hmac character varying(64),
    documento_cifrado text,
    CONSTRAINT receta_emitida_estado_check CHECK (((estado)::text = ANY ((ARRAY['EMITIDA'::character varying, 'RESERVADA'::character varying, 'RECLAMADA'::character varying, 'ANULADA'::character varying])::text[]))),
    CONSTRAINT receta_emitida_reclamo_check CHECK ((((estado)::text <> 'RECLAMADA'::text) OR ((id_tienda_reclamo IS NOT NULL) AND (reclamada_en IS NOT NULL)))),
    CONSTRAINT receta_emitida_reserva_check CHECK ((((estado)::text <> 'RESERVADA'::text) OR ((id_tienda_reserva IS NOT NULL) AND (reservada_hasta IS NOT NULL))))
);


--
-- Name: receta_emitida_id_receta_emitida_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.receta_emitida ALTER COLUMN id_receta_emitida ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.receta_emitida_id_receta_emitida_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: receta_emitida_medicamento; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receta_emitida_medicamento (
    id_receta_emitida integer NOT NULL,
    id_medicamento integer NOT NULL,
    cantidad_autorizada integer NOT NULL,
    CONSTRAINT receta_emitida_medicamento_cantidad_check CHECK ((cantidad_autorizada > 0))
);


--
-- Name: registro_actividad_central_id_registro_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.registro_actividad_central_id_registro_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: registro_actividad_central; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.registro_actividad_central (
    id_registro integer DEFAULT nextval('public.registro_actividad_central_id_registro_seq'::regclass) NOT NULL,
    id_empleado integer,
    accion character varying(80) NOT NULL,
    entidad_afectada character varying(60) NOT NULL,
    id_entidad_afectada integer,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    detalle character varying(400),
    id_tienda integer,
    id_registro_tienda integer,
    recibido_en timestamp with time zone DEFAULT now(),
    CONSTRAINT registro_actividad_central_origen_check CHECK (((id_tienda IS NULL) = (id_registro_tienda IS NULL)))
);


--
-- Name: replica_evento; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replica_evento (
    id_evento bigint NOT NULL,
    id_tienda_destino integer,
    tipo_evento character varying(40) NOT NULL,
    version_credencial bigint DEFAULT 1 NOT NULL,
    payload jsonb NOT NULL,
    creado_en timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rol_id_rol_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rol_id_rol_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rol; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rol (
    id_rol integer DEFAULT nextval('public.rol_id_rol_seq'::regclass) NOT NULL,
    nombre character varying(40) NOT NULL,
    descripcion character varying(200)
);


--
-- Name: rol_permiso; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rol_permiso (
    id_rol integer NOT NULL,
    id_permiso integer NOT NULL
);


--
-- Name: sesion_activa; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: tienda_id_tienda_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tienda_id_tienda_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tienda; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tienda (
    id_tienda integer DEFAULT nextval('public.tienda_id_tienda_seq'::regclass) NOT NULL,
    nombre character varying(120) NOT NULL,
    direccion character varying(200) NOT NULL,
    ciudad character varying(80) NOT NULL,
    telefono character varying(30),
    fecha_apertura date,
    activa boolean DEFAULT true NOT NULL,
    fecha_registro timestamp without time zone DEFAULT now() NOT NULL,
    version_tienda bigint DEFAULT 1 NOT NULL,
    id_politica integer DEFAULT 1 NOT NULL
);


--
-- Name: traslado_id_traslado_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.traslado_id_traslado_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: traslado; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.traslado (
    id_traslado integer DEFAULT nextval('public.traslado_id_traslado_seq'::regclass) NOT NULL,
    id_tienda_origen integer NOT NULL,
    id_tienda_destino integer NOT NULL,
    id_empleado_solicitante integer NOT NULL,
    estado character varying(20) DEFAULT 'SOLICITADO'::character varying NOT NULL,
    fecha_solicitud timestamp without time zone DEFAULT now() NOT NULL,
    fecha_confirmacion timestamp without time zone,
    observaciones character varying(300),
    motivo character varying(300),
    actualizado_en timestamp without time zone,
    idempotency_key uuid,
    id_medicamento integer NOT NULL,
    cantidad integer NOT NULL,
    lotes_enviados jsonb,
    CONSTRAINT traslado_cantidad_check CHECK ((cantidad > 0)),
    CONSTRAINT traslado_check CHECK ((id_tienda_origen <> id_tienda_destino)),
    CONSTRAINT traslado_estado_check CHECK (((estado)::text = ANY ((ARRAY['SOLICITADO'::character varying, 'EN_TRANSITO'::character varying, 'COMPLETADO'::character varying, 'COMPENSANDO'::character varying, 'COMPENSADO'::character varying, 'FALLIDO'::character varying])::text[])))
);


--
-- Name: venta_categoria_consolidada; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venta_categoria_consolidada (
    id_tienda integer NOT NULL,
    fecha date NOT NULL,
    id_categoria integer NOT NULL,
    unidades integer DEFAULT 0 NOT NULL,
    ingresos numeric(14,2) DEFAULT 0 NOT NULL,
    fecha_sincronizacion timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: venta_consolidada_id_venta_consolidada_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.venta_consolidada_id_venta_consolidada_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: venta_consolidada; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venta_consolidada (
    id_venta_consolidada integer DEFAULT nextval('public.venta_consolidada_id_venta_consolidada_seq'::regclass) NOT NULL,
    id_tienda integer NOT NULL,
    fecha date NOT NULL,
    id_metodo_pago integer NOT NULL,
    total_vendido numeric(14,2) DEFAULT 0 NOT NULL,
    total_facturas integer DEFAULT 0 NOT NULL,
    fecha_sincronizacion timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Data for Name: auth_operacion; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: categoria; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.categoria VALUES (0, 'Sin categoría');


--
-- Data for Name: codigo_restablecimiento; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: control_acceso; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: empleado; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: inbox_sync; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: intento_acceso; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: medicamento; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: medicamento_proveedor; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: medicamento_tienda; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: metodo_pago; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.metodo_pago VALUES (1, 'efectivo', true);
INSERT INTO public.metodo_pago VALUES (2, 'tarjeta_debito', true);
INSERT INTO public.metodo_pago VALUES (3, 'tarjeta_credito', true);
INSERT INTO public.metodo_pago VALUES (4, 'transferencia', true);


--
-- Data for Name: permiso; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.permiso VALUES (1, 'RED_VISIBILIDAD', 'Ver la operacion consolidada de la red');
INSERT INTO public.permiso VALUES (2, 'RED_CONTROL', 'Administrar la red de tiendas');
INSERT INTO public.permiso VALUES (3, 'PRECIO_GESTIONAR', 'Gestionar precios');
INSERT INTO public.permiso VALUES (4, 'VENTA_REGISTRAR', 'Registrar ventas');
INSERT INTO public.permiso VALUES (5, 'FACTURA_ANULAR', 'Anular o devolver facturas');
INSERT INTO public.permiso VALUES (6, 'TIENDA_GESTIONAR', 'Administrar tiendas de la red');
INSERT INTO public.permiso VALUES (7, 'EMPLEADO_GESTIONAR', 'Gestionar empleados de la tienda');
INSERT INTO public.permiso VALUES (8, 'REPORTE_CONSOLIDADO_VER', 'Ver reportes consolidados');
INSERT INTO public.permiso VALUES (9, 'INVENTARIO_CONSULTAR', 'Consultar inventario de la tienda');
INSERT INTO public.permiso VALUES (10, 'CAJA_CERRAR', 'Cerrar caja');
INSERT INTO public.permiso VALUES (11, 'INVENTARIO_GESTIONAR', 'Registrar lotes, recibir pedidos y ajustar inventario');
INSERT INTO public.permiso VALUES (12, 'AUDITORIA_CONSULTAR', 'Consultar el registro de auditoría');
INSERT INTO public.permiso VALUES (13, 'REPORTE_TIENDA_VER', 'Ver reportes y estadísticas de la tienda');
INSERT INTO public.permiso VALUES (14, 'PROVEEDOR_GESTIONAR', 'Gestionar proveedores y solicitudes de reabastecimiento');


--
-- Data for Name: politica_sistema; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.politica_sistema VALUES (1, 5, 15, 30, 15);


--
-- Data for Name: precio_medicamento; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: proveedor; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: receta_conflicto; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: receta_emitida; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: receta_emitida_medicamento; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: registro_actividad_central; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: replica_evento; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: rol; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.rol VALUES (1, 'cajero', 'Operacion de mostrador');
INSERT INTO public.rol VALUES (2, 'administrador_tienda', 'Administracion de una tienda');
INSERT INTO public.rol VALUES (3, 'administrador_general', 'Administracion de la red');


--
-- Data for Name: rol_permiso; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.rol_permiso VALUES (3, 1);
INSERT INTO public.rol_permiso VALUES (3, 2);
INSERT INTO public.rol_permiso VALUES (2, 3);
INSERT INTO public.rol_permiso VALUES (3, 3);
INSERT INTO public.rol_permiso VALUES (1, 4);
INSERT INTO public.rol_permiso VALUES (2, 4);
INSERT INTO public.rol_permiso VALUES (3, 4);
INSERT INTO public.rol_permiso VALUES (2, 5);
INSERT INTO public.rol_permiso VALUES (3, 5);
INSERT INTO public.rol_permiso VALUES (3, 6);
INSERT INTO public.rol_permiso VALUES (2, 7);
INSERT INTO public.rol_permiso VALUES (3, 7);
INSERT INTO public.rol_permiso VALUES (3, 8);
INSERT INTO public.rol_permiso VALUES (1, 9);
INSERT INTO public.rol_permiso VALUES (2, 9);
INSERT INTO public.rol_permiso VALUES (3, 9);
INSERT INTO public.rol_permiso VALUES (2, 10);
INSERT INTO public.rol_permiso VALUES (3, 10);
INSERT INTO public.rol_permiso VALUES (2, 11);
INSERT INTO public.rol_permiso VALUES (3, 11);
INSERT INTO public.rol_permiso VALUES (2, 12);
INSERT INTO public.rol_permiso VALUES (3, 12);
INSERT INTO public.rol_permiso VALUES (1, 5);
INSERT INTO public.rol_permiso VALUES (2, 13);
INSERT INTO public.rol_permiso VALUES (3, 13);
INSERT INTO public.rol_permiso VALUES (2, 14);
INSERT INTO public.rol_permiso VALUES (3, 14);


--
-- Data for Name: sesion_activa; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tienda; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: traslado; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: venta_categoria_consolidada; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: venta_consolidada; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: categoria_id_categoria_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.categoria_id_categoria_seq', 1, false);


--
-- Name: codigo_restablecimiento_id_codigo_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.codigo_restablecimiento_id_codigo_seq', 1, false);


--
-- Name: control_acceso_snapshot_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.control_acceso_snapshot_seq', 1, true);


--
-- Name: empleado_id_empleado_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.empleado_id_empleado_seq', 1, false);


--
-- Name: intento_acceso_id_intento_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.intento_acceso_id_intento_seq', 1, false);


--
-- Name: medicamento_id_medicamento_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.medicamento_id_medicamento_seq', 1, false);


--
-- Name: metodo_pago_id_metodo_pago_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.metodo_pago_id_metodo_pago_seq', 4, true);


--
-- Name: permiso_id_permiso_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.permiso_id_permiso_seq', 14, true);


--
-- Name: precio_medicamento_id_precio_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.precio_medicamento_id_precio_seq', 1, false);


--
-- Name: proveedor_id_proveedor_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.proveedor_id_proveedor_seq', 1, false);


--
-- Name: receta_conflicto_id_conflicto_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.receta_conflicto_id_conflicto_seq', 1, false);


--
-- Name: receta_emitida_id_receta_emitida_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.receta_emitida_id_receta_emitida_seq', 1, false);


--
-- Name: registro_actividad_central_id_registro_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.registro_actividad_central_id_registro_seq', 1, false);


--
-- Name: rol_id_rol_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.rol_id_rol_seq', 3, true);


--
-- Name: tienda_id_tienda_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.tienda_id_tienda_seq', 1, false);


--
-- Name: traslado_id_traslado_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.traslado_id_traslado_seq', 1, false);


--
-- Name: venta_consolidada_id_venta_consolidada_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.venta_consolidada_id_venta_consolidada_seq', 1, false);


--
-- Name: auth_operacion auth_operacion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_operacion
    ADD CONSTRAINT auth_operacion_pkey PRIMARY KEY (idempotency_key);


--
-- Name: categoria categoria_nombre_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categoria
    ADD CONSTRAINT categoria_nombre_key UNIQUE (nombre);


--
-- Name: categoria categoria_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categoria
    ADD CONSTRAINT categoria_pkey PRIMARY KEY (id_categoria);


--
-- Name: codigo_restablecimiento codigo_restablecimiento_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.codigo_restablecimiento
    ADD CONSTRAINT codigo_restablecimiento_pkey PRIMARY KEY (id_codigo);


--
-- Name: control_acceso control_acceso_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.control_acceso
    ADD CONSTRAINT control_acceso_pkey PRIMARY KEY (id_empleado);


--
-- Name: empleado empleado_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empleado
    ADD CONSTRAINT empleado_pkey PRIMARY KEY (id_empleado);


--
-- Name: empleado empleado_usuario_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empleado
    ADD CONSTRAINT empleado_usuario_key UNIQUE (usuario);


--
-- Name: inbox_sync inbox_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_sync
    ADD CONSTRAINT inbox_sync_pkey PRIMARY KEY (id_tienda_origen, idempotency_key);


--
-- Name: intento_acceso intento_acceso_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intento_acceso
    ADD CONSTRAINT intento_acceso_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: intento_acceso intento_acceso_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intento_acceso
    ADD CONSTRAINT intento_acceso_pkey PRIMARY KEY (id_intento);


--
-- Name: medicamento medicamento_codigo_interno_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medicamento
    ADD CONSTRAINT medicamento_codigo_interno_key UNIQUE (codigo_interno);


--
-- Name: medicamento medicamento_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medicamento
    ADD CONSTRAINT medicamento_pkey PRIMARY KEY (id_medicamento);


--
-- Name: medicamento_proveedor medicamento_proveedor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medicamento_proveedor
    ADD CONSTRAINT medicamento_proveedor_pkey PRIMARY KEY (id_proveedor, id_medicamento);


--
-- Name: medicamento_tienda medicamento_tienda_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medicamento_tienda
    ADD CONSTRAINT medicamento_tienda_pkey PRIMARY KEY (id_tienda, id_medicamento);


--
-- Name: metodo_pago metodo_pago_nombre_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metodo_pago
    ADD CONSTRAINT metodo_pago_nombre_key UNIQUE (nombre);


--
-- Name: metodo_pago metodo_pago_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metodo_pago
    ADD CONSTRAINT metodo_pago_pkey PRIMARY KEY (id_metodo_pago);


--
-- Name: permiso permiso_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permiso
    ADD CONSTRAINT permiso_codigo_key UNIQUE (codigo);


--
-- Name: permiso permiso_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permiso
    ADD CONSTRAINT permiso_pkey PRIMARY KEY (id_permiso);


--
-- Name: politica_sistema politica_sistema_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.politica_sistema
    ADD CONSTRAINT politica_sistema_pkey PRIMARY KEY (id);


--
-- Name: precio_medicamento precio_medicamento_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.precio_medicamento
    ADD CONSTRAINT precio_medicamento_pkey PRIMARY KEY (id_precio);


--
-- Name: proveedor proveedor_nit_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proveedor
    ADD CONSTRAINT proveedor_nit_key UNIQUE (nit);


--
-- Name: proveedor proveedor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proveedor
    ADD CONSTRAINT proveedor_pkey PRIMARY KEY (id_proveedor);


--
-- Name: receta_conflicto receta_conflicto_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_conflicto
    ADD CONSTRAINT receta_conflicto_pkey PRIMARY KEY (id_conflicto);


--
-- Name: receta_emitida receta_emitida_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_emitida
    ADD CONSTRAINT receta_emitida_codigo_key UNIQUE (codigo);


--
-- Name: receta_emitida receta_emitida_documento_cifrado_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.receta_emitida
    ADD CONSTRAINT receta_emitida_documento_cifrado_check CHECK ((documento_cifrado IS NOT NULL)) NOT VALID;


--
-- Name: receta_emitida_medicamento receta_emitida_medicamento_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_emitida_medicamento
    ADD CONSTRAINT receta_emitida_medicamento_pkey PRIMARY KEY (id_receta_emitida, id_medicamento);


--
-- Name: receta_emitida receta_emitida_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_emitida
    ADD CONSTRAINT receta_emitida_pkey PRIMARY KEY (id_receta_emitida);


--
-- Name: registro_actividad_central registro_actividad_central_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registro_actividad_central
    ADD CONSTRAINT registro_actividad_central_pkey PRIMARY KEY (id_registro);


--
-- Name: registro_actividad_central registro_actividad_central_tienda_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registro_actividad_central
    ADD CONSTRAINT registro_actividad_central_tienda_key UNIQUE (id_tienda, id_registro_tienda);


--
-- Name: replica_evento replica_evento_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replica_evento
    ADD CONSTRAINT replica_evento_pkey PRIMARY KEY (id_evento);


--
-- Name: rol rol_nombre_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rol
    ADD CONSTRAINT rol_nombre_key UNIQUE (nombre);


--
-- Name: rol_permiso rol_permiso_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rol_permiso
    ADD CONSTRAINT rol_permiso_pkey PRIMARY KEY (id_rol, id_permiso);


--
-- Name: rol rol_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rol
    ADD CONSTRAINT rol_pkey PRIMARY KEY (id_rol);


--
-- Name: sesion_activa sesion_activa_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sesion_activa
    ADD CONSTRAINT sesion_activa_pkey PRIMARY KEY (id_sesion);


--
-- Name: sesion_activa sesion_activa_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sesion_activa
    ADD CONSTRAINT sesion_activa_token_hash_key UNIQUE (token_hash);


--
-- Name: tienda tienda_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tienda
    ADD CONSTRAINT tienda_pkey PRIMARY KEY (id_tienda);


--
-- Name: traslado traslado_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traslado
    ADD CONSTRAINT traslado_pkey PRIMARY KEY (id_traslado);


--
-- Name: venta_categoria_consolidada venta_categoria_consolidada_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_categoria_consolidada
    ADD CONSTRAINT venta_categoria_consolidada_pkey PRIMARY KEY (id_tienda, fecha, id_categoria);


--
-- Name: venta_consolidada venta_consolidada_id_tienda_fecha_id_metodo_pago_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_consolidada
    ADD CONSTRAINT venta_consolidada_id_tienda_fecha_id_metodo_pago_key UNIQUE (id_tienda, fecha, id_metodo_pago);


--
-- Name: venta_consolidada venta_consolidada_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_consolidada
    ADD CONSTRAINT venta_consolidada_pkey PRIMARY KEY (id_venta_consolidada);


--
-- Name: idx_codigo_restablecimiento_vigente; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_codigo_restablecimiento_vigente ON public.codigo_restablecimiento USING btree (id_empleado) WHERE ((estado)::text = 'VIGENTE'::text);


--
-- Name: idx_empleado_tienda; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_empleado_tienda ON public.empleado USING btree (id_tienda);


--
-- Name: idx_medicamento_nombre; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_medicamento_nombre ON public.medicamento USING btree (nombre_comercial);


--
-- Name: idx_medicamento_principio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_medicamento_principio ON public.medicamento USING btree (principio_activo);


--
-- Name: idx_medicamento_proveedor_medicamento; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_medicamento_proveedor_medicamento ON public.medicamento_proveedor USING btree (id_medicamento);


--
-- Name: idx_medicamento_tienda_medicamento; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_medicamento_tienda_medicamento ON public.medicamento_tienda USING btree (id_medicamento);


--
-- Name: idx_precio_medicamento_vigencia; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_precio_medicamento_vigencia ON public.precio_medicamento USING btree (id_medicamento, fecha_inicio_vigencia);


--
-- Name: idx_receta_emitida_documento; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receta_emitida_documento ON public.receta_emitida USING btree (paciente_documento);


--
-- Name: idx_receta_emitida_documento_hmac; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receta_emitida_documento_hmac ON public.receta_emitida USING btree (documento_hmac);


--
-- Name: idx_receta_emitida_estado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receta_emitida_estado ON public.receta_emitida USING btree (estado);


--
-- Name: idx_registro_actividad_central_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registro_actividad_central_fecha ON public.registro_actividad_central USING btree (fecha_hora);


--
-- Name: idx_traslado_destino; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traslado_destino ON public.traslado USING btree (id_tienda_destino);


--
-- Name: idx_traslado_origen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traslado_origen ON public.traslado USING btree (id_tienda_origen);


--
-- Name: idx_traslado_origen_estado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traslado_origen_estado ON public.traslado USING btree (id_tienda_origen, estado);


--
-- Name: idx_traslado_origen_medicamento; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traslado_origen_medicamento ON public.traslado USING btree (id_tienda_origen, id_medicamento) WHERE ((estado)::text = 'SOLICITADO'::text);


--
-- Name: idx_venta_categoria_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_venta_categoria_fecha ON public.venta_categoria_consolidada USING btree (fecha);


--
-- Name: idx_venta_consolidada_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_venta_consolidada_fecha ON public.venta_consolidada USING btree (fecha);


--
-- Name: uq_precio_medicamento_inicio; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_precio_medicamento_inicio ON public.precio_medicamento USING btree (id_medicamento, fecha_inicio_vigencia);


--
-- Name: ux_traslado_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_traslado_idempotency ON public.traslado USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: medicamento medicamento_con_umbral; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER medicamento_con_umbral AFTER INSERT OR UPDATE OF activo ON public.medicamento DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.exigir_umbral_medicamento();


--
-- Name: precio_medicamento precio_medicamento_historial; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER precio_medicamento_historial BEFORE DELETE OR UPDATE ON public.precio_medicamento FOR EACH ROW EXECUTE FUNCTION public.precio_historial_inmutable();


--
-- Name: registro_actividad_central registro_actividad_central_inmutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER registro_actividad_central_inmutable BEFORE DELETE OR UPDATE ON public.registro_actividad_central FOR EACH ROW EXECUTE FUNCTION public.auditoria_inmutable();


--
-- Name: registro_actividad_central registro_actividad_central_sin_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER registro_actividad_central_sin_truncate BEFORE TRUNCATE ON public.registro_actividad_central FOR EACH STATEMENT EXECUTE FUNCTION public.auditoria_inmutable();


--
-- Name: tienda tienda_con_umbrales; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER tienda_con_umbrales AFTER INSERT OR UPDATE OF activa ON public.tienda DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.exigir_umbral_tienda();


--
-- Name: traslado traslado_transicion_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER traslado_transicion_trg BEFORE UPDATE OF estado ON public.traslado FOR EACH ROW EXECUTE FUNCTION public.traslado_transicion();


--
-- Name: auth_operacion auth_operacion_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_operacion
    ADD CONSTRAINT auth_operacion_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado(id_empleado);


--
-- Name: codigo_restablecimiento codigo_restablecimiento_generado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.codigo_restablecimiento
    ADD CONSTRAINT codigo_restablecimiento_generado_por_fkey FOREIGN KEY (generado_por) REFERENCES public.empleado(id_empleado);


--
-- Name: codigo_restablecimiento codigo_restablecimiento_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.codigo_restablecimiento
    ADD CONSTRAINT codigo_restablecimiento_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado(id_empleado);


--
-- Name: control_acceso control_acceso_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.control_acceso
    ADD CONSTRAINT control_acceso_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado(id_empleado);


--
-- Name: empleado empleado_id_rol_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empleado
    ADD CONSTRAINT empleado_id_rol_fkey FOREIGN KEY (id_rol) REFERENCES public.rol(id_rol);


--
-- Name: empleado empleado_id_tienda_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empleado
    ADD CONSTRAINT empleado_id_tienda_fkey FOREIGN KEY (id_tienda) REFERENCES public.tienda(id_tienda);


--
-- Name: inbox_sync inbox_sync_id_tienda_origen_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_sync
    ADD CONSTRAINT inbox_sync_id_tienda_origen_fkey FOREIGN KEY (id_tienda_origen) REFERENCES public.tienda(id_tienda);


--
-- Name: intento_acceso intento_acceso_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intento_acceso
    ADD CONSTRAINT intento_acceso_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado(id_empleado);


--
-- Name: medicamento medicamento_id_categoria_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medicamento
    ADD CONSTRAINT medicamento_id_categoria_fkey FOREIGN KEY (id_categoria) REFERENCES public.categoria(id_categoria);


--
-- Name: medicamento_proveedor medicamento_proveedor_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medicamento_proveedor
    ADD CONSTRAINT medicamento_proveedor_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento(id_medicamento);


--
-- Name: medicamento_proveedor medicamento_proveedor_id_proveedor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medicamento_proveedor
    ADD CONSTRAINT medicamento_proveedor_id_proveedor_fkey FOREIGN KEY (id_proveedor) REFERENCES public.proveedor(id_proveedor);


--
-- Name: medicamento_tienda medicamento_tienda_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medicamento_tienda
    ADD CONSTRAINT medicamento_tienda_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento(id_medicamento) ON DELETE CASCADE;


--
-- Name: medicamento_tienda medicamento_tienda_id_tienda_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medicamento_tienda
    ADD CONSTRAINT medicamento_tienda_id_tienda_fkey FOREIGN KEY (id_tienda) REFERENCES public.tienda(id_tienda) ON DELETE CASCADE;


--
-- Name: precio_medicamento precio_medicamento_id_empleado_registro_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.precio_medicamento
    ADD CONSTRAINT precio_medicamento_id_empleado_registro_fkey FOREIGN KEY (id_empleado_registro) REFERENCES public.empleado(id_empleado);


--
-- Name: precio_medicamento precio_medicamento_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.precio_medicamento
    ADD CONSTRAINT precio_medicamento_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento(id_medicamento);


--
-- Name: receta_conflicto receta_conflicto_id_receta_emitida_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_conflicto
    ADD CONSTRAINT receta_conflicto_id_receta_emitida_fkey FOREIGN KEY (id_receta_emitida) REFERENCES public.receta_emitida(id_receta_emitida);


--
-- Name: receta_conflicto receta_conflicto_id_tienda_origen_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_conflicto
    ADD CONSTRAINT receta_conflicto_id_tienda_origen_fkey FOREIGN KEY (id_tienda_origen) REFERENCES public.tienda(id_tienda);


--
-- Name: receta_emitida receta_emitida_id_empleado_emisor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_emitida
    ADD CONSTRAINT receta_emitida_id_empleado_emisor_fkey FOREIGN KEY (id_empleado_emisor) REFERENCES public.empleado(id_empleado);


--
-- Name: receta_emitida receta_emitida_id_empleado_reserva_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_emitida
    ADD CONSTRAINT receta_emitida_id_empleado_reserva_fkey FOREIGN KEY (id_empleado_reserva) REFERENCES public.empleado(id_empleado);


--
-- Name: receta_emitida receta_emitida_id_tienda_reclamo_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_emitida
    ADD CONSTRAINT receta_emitida_id_tienda_reclamo_fkey FOREIGN KEY (id_tienda_reclamo) REFERENCES public.tienda(id_tienda);


--
-- Name: receta_emitida receta_emitida_id_tienda_reserva_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_emitida
    ADD CONSTRAINT receta_emitida_id_tienda_reserva_fkey FOREIGN KEY (id_tienda_reserva) REFERENCES public.tienda(id_tienda);


--
-- Name: receta_emitida_medicamento receta_emitida_medicamento_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_emitida_medicamento
    ADD CONSTRAINT receta_emitida_medicamento_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento(id_medicamento);


--
-- Name: receta_emitida_medicamento receta_emitida_medicamento_id_receta_emitida_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_emitida_medicamento
    ADD CONSTRAINT receta_emitida_medicamento_id_receta_emitida_fkey FOREIGN KEY (id_receta_emitida) REFERENCES public.receta_emitida(id_receta_emitida);


--
-- Name: registro_actividad_central registro_actividad_central_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registro_actividad_central
    ADD CONSTRAINT registro_actividad_central_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado(id_empleado);


--
-- Name: registro_actividad_central registro_actividad_central_id_tienda_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registro_actividad_central
    ADD CONSTRAINT registro_actividad_central_id_tienda_fkey FOREIGN KEY (id_tienda) REFERENCES public.tienda(id_tienda);


--
-- Name: replica_evento replica_evento_id_tienda_destino_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replica_evento
    ADD CONSTRAINT replica_evento_id_tienda_destino_fkey FOREIGN KEY (id_tienda_destino) REFERENCES public.tienda(id_tienda) NOT VALID;


--
-- Name: rol_permiso rol_permiso_id_permiso_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rol_permiso
    ADD CONSTRAINT rol_permiso_id_permiso_fkey FOREIGN KEY (id_permiso) REFERENCES public.permiso(id_permiso) ON DELETE CASCADE;


--
-- Name: rol_permiso rol_permiso_id_rol_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rol_permiso
    ADD CONSTRAINT rol_permiso_id_rol_fkey FOREIGN KEY (id_rol) REFERENCES public.rol(id_rol) ON DELETE CASCADE;


--
-- Name: sesion_activa sesion_activa_id_empleado_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sesion_activa
    ADD CONSTRAINT sesion_activa_id_empleado_fkey FOREIGN KEY (id_empleado) REFERENCES public.empleado(id_empleado);


--
-- Name: tienda tienda_id_politica_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tienda
    ADD CONSTRAINT tienda_id_politica_fkey FOREIGN KEY (id_politica) REFERENCES public.politica_sistema(id);


--
-- Name: traslado traslado_id_empleado_solicitante_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traslado
    ADD CONSTRAINT traslado_id_empleado_solicitante_fkey FOREIGN KEY (id_empleado_solicitante) REFERENCES public.empleado(id_empleado);


--
-- Name: traslado traslado_id_medicamento_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traslado
    ADD CONSTRAINT traslado_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES public.medicamento(id_medicamento);


--
-- Name: traslado traslado_id_tienda_destino_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traslado
    ADD CONSTRAINT traslado_id_tienda_destino_fkey FOREIGN KEY (id_tienda_destino) REFERENCES public.tienda(id_tienda);


--
-- Name: traslado traslado_id_tienda_origen_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traslado
    ADD CONSTRAINT traslado_id_tienda_origen_fkey FOREIGN KEY (id_tienda_origen) REFERENCES public.tienda(id_tienda);


--
-- Name: venta_categoria_consolidada venta_categoria_consolidada_id_categoria_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_categoria_consolidada
    ADD CONSTRAINT venta_categoria_consolidada_id_categoria_fkey FOREIGN KEY (id_categoria) REFERENCES public.categoria(id_categoria);


--
-- Name: venta_categoria_consolidada venta_categoria_consolidada_id_tienda_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_categoria_consolidada
    ADD CONSTRAINT venta_categoria_consolidada_id_tienda_fkey FOREIGN KEY (id_tienda) REFERENCES public.tienda(id_tienda);


--
-- Name: venta_consolidada venta_consolidada_id_metodo_pago_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_consolidada
    ADD CONSTRAINT venta_consolidada_id_metodo_pago_fkey FOREIGN KEY (id_metodo_pago) REFERENCES public.metodo_pago(id_metodo_pago);


--
-- Name: venta_consolidada venta_consolidada_id_tienda_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_consolidada
    ADD CONSTRAINT venta_consolidada_id_tienda_fkey FOREIGN KEY (id_tienda) REFERENCES public.tienda(id_tienda);


--
-- PostgreSQL database dump complete
--

\unrestrict tfnRnr9WXWRQHIrfdAyg4vbnJogv2fMk1xWRKL2Sj4quL2FehOw5CJ3OiYQ1B1d


-- 10. PERMISOS DEL ROL DE APLICACIÓN (farmahub_datos)
-- ============================================================================

-- Solo datos, sin DDL ni TRUNCATE; las tablas de auditoría y de cierres son de solo inserción. Si el rol no existe
-- en esta base, el bloque no hace nada (ver docs/seguridad/datos-personales.md).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farmahub_datos') THEN
        GRANT USAGE ON SCHEMA public TO farmahub_datos;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO farmahub_datos;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO farmahub_datos;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO farmahub_datos;
        REVOKE UPDATE, DELETE, TRUNCATE ON registro_actividad_central FROM farmahub_datos;
        REVOKE UPDATE, DELETE, TRUNCATE ON replica_evento FROM farmahub_datos;
        REVOKE UPDATE, DELETE, TRUNCATE ON inbox_sync FROM farmahub_datos;
    END IF;
END $$;

COMMIT;

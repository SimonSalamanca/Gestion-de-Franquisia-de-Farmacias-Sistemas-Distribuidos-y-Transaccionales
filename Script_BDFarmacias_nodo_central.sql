-- ============================================================================
--  SCRIPT DE CREACION - BASE DE DATOS DEL NODO CENTRAL
--  Proyecto: Sistema de Gestion de Franquicia de Farmacias
--  Base de datos: "Sistema de gestión de farmacias-nodo central"
--
--  Contenido:
--   1. Creacion de la base de datos
--   2. Secuencias
--   3. Tablas (con restricciones CHECK y valores por defecto)
--   4. Restricciones de integridad (PRIMARY KEY, UNIQUE, FOREIGN KEY)
--   5. Indices
--
--  Nota: al momento de la extraccion la base no contenia registros,
--  por lo que el script reconstruye solo la estructura.
--
--  Uso:  psql -U postgres -f Script_BDFarmacias_nodo_central.sql
-- ============================================================================

SET client_encoding = 'UTF8';

-- ============================================================================
-- 1. CREACION DE LA BASE DE DATOS
-- ============================================================================
CREATE DATABASE "Sistema de gestión de farmacias-nodo central";

\connect "Sistema de gestión de farmacias-nodo central"

SET client_encoding = 'UTF8';

-- ============================================================================
-- 2. SECUENCIAS
-- ============================================================================

CREATE SEQUENCE categoria_id_categoria_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE empleado_id_empleado_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE inventario_consolidado_id_inventario_consolidado_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE medicamento_id_medicamento_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE metodo_pago_id_metodo_pago_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE permiso_id_permiso_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE precio_medicamento_id_precio_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE proveedor_id_proveedor_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE registro_actividad_central_id_registro_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE rol_id_rol_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE tienda_id_tienda_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE traslado_id_traslado_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE venta_consolidada_id_venta_consolidada_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

-- ============================================================================
-- 3. TABLAS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 3.1 Tablas maestras (sin dependencias)
-- ----------------------------------------------------------------------------

CREATE TABLE categoria (
    id_categoria integer NOT NULL,
    nombre character varying(80) NOT NULL
);

CREATE TABLE rol (
    id_rol integer NOT NULL,
    nombre character varying(40) NOT NULL,
    descripcion character varying(200)
);

CREATE TABLE permiso (
    id_permiso integer NOT NULL,
    codigo character varying(60) NOT NULL,
    descripcion character varying(200)
);

CREATE TABLE metodo_pago (
    id_metodo_pago integer NOT NULL,
    nombre character varying(40) NOT NULL,
    activo boolean DEFAULT true NOT NULL
);

CREATE TABLE proveedor (
    id_proveedor integer NOT NULL,
    nombre_empresa character varying(150) NOT NULL,
    nit character varying(40) NOT NULL,
    telefono character varying(30),
    correo character varying(120),
    direccion character varying(200),
    activo boolean DEFAULT true NOT NULL
);

CREATE TABLE tienda (
    id_tienda integer NOT NULL,
    nombre character varying(120) NOT NULL,
    direccion character varying(200) NOT NULL,
    ciudad character varying(80) NOT NULL,
    telefono character varying(30),
    fecha_apertura date,
    activa boolean DEFAULT true NOT NULL,
    fecha_registro timestamp without time zone DEFAULT now() NOT NULL
);

-- ----------------------------------------------------------------------------
-- 3.2 Medicamentos e inventario
-- ----------------------------------------------------------------------------

CREATE TABLE medicamento (
    id_medicamento integer NOT NULL,
    codigo_interno character varying(40) NOT NULL,
    nombre_comercial character varying(150) NOT NULL,
    principio_activo character varying(150) NOT NULL,
    id_categoria integer,
    requiere_receta boolean DEFAULT false NOT NULL,
    requiere_refrigeracion boolean DEFAULT false NOT NULL,
    unidad_medida character varying(30) DEFAULT 'unidad' NOT NULL,
    activo boolean DEFAULT true NOT NULL
);

CREATE TABLE medicamento_proveedor (
    id_medicamento integer NOT NULL,
    id_proveedor integer NOT NULL,
    precio_referencia numeric(12,2),
    tiempo_entrega_dias integer
);

CREATE TABLE umbral_stock (
    id_tienda integer NOT NULL,
    id_medicamento integer NOT NULL,
    stock_minimo integer DEFAULT 0 NOT NULL,
    dias_alerta_caducidad integer DEFAULT 30 NOT NULL,
    CONSTRAINT umbral_stock_stock_minimo_check CHECK (stock_minimo >= 0),
    CONSTRAINT umbral_stock_dias_alerta_caducidad_check CHECK (dias_alerta_caducidad >= 0)
);

CREATE TABLE inventario_consolidado (
    id_inventario_consolidado integer NOT NULL,
    id_tienda integer NOT NULL,
    id_medicamento integer NOT NULL,
    cantidad_disponible integer DEFAULT 0 NOT NULL,
    fecha_sincronizacion timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE precio_medicamento (
    id_precio integer NOT NULL,
    id_medicamento integer NOT NULL,
    precio numeric(12,2) NOT NULL,
    fecha_inicio_vigencia timestamp without time zone DEFAULT now() NOT NULL,
    fecha_fin_vigencia timestamp without time zone,
    id_empleado_registro integer,
    CONSTRAINT precio_medicamento_precio_check CHECK (precio >= 0)
);

-- ----------------------------------------------------------------------------
-- 3.3 Personal y seguridad
-- ----------------------------------------------------------------------------

CREATE TABLE empleado (
    id_empleado integer NOT NULL,
    id_tienda integer NOT NULL,
    id_rol integer NOT NULL,
    nombre_completo character varying(150) NOT NULL,
    usuario character varying(60) NOT NULL,
    contrasena_hash character varying(255) NOT NULL,
    correo character varying(120),
    activo boolean DEFAULT true NOT NULL,
    fecha_creacion timestamp without time zone DEFAULT now() NOT NULL,
    fecha_baja timestamp without time zone
);

CREATE TABLE rol_permiso (
    id_rol integer NOT NULL,
    id_permiso integer NOT NULL
);

-- ----------------------------------------------------------------------------
-- 3.4 Traslados de mercancia
-- ----------------------------------------------------------------------------

CREATE TABLE traslado (
    id_traslado integer NOT NULL,
    id_tienda_origen integer NOT NULL,
    id_tienda_destino integer NOT NULL,
    id_empleado_solicitante integer NOT NULL,
    estado character varying(20) DEFAULT 'SOLICITADO' NOT NULL,
    fecha_solicitud timestamp without time zone DEFAULT now() NOT NULL,
    fecha_confirmacion timestamp without time zone,
    observaciones character varying(300),
    CONSTRAINT traslado_check CHECK (id_tienda_origen <> id_tienda_destino),
    CONSTRAINT traslado_estado_check CHECK (
        estado IN ('SOLICITADO', 'EN_TRANSITO', 'COMPLETADO', 'COMPENSADO', 'FALLIDO')
    )
);

CREATE TABLE detalle_traslado (
    id_traslado integer NOT NULL,
    id_medicamento integer NOT NULL,
    cantidad integer NOT NULL,
    CONSTRAINT detalle_traslado_cantidad_check CHECK (cantidad > 0)
);

-- ----------------------------------------------------------------------------
-- 3.5 Operaciones y auditoria
-- ----------------------------------------------------------------------------

CREATE TABLE venta_consolidada (
    id_venta_consolidada integer NOT NULL,
    id_tienda integer NOT NULL,
    fecha date NOT NULL,
    id_metodo_pago integer NOT NULL,
    total_vendido numeric(14,2) DEFAULT 0 NOT NULL,
    total_facturas integer DEFAULT 0 NOT NULL,
    fecha_sincronizacion timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE registro_actividad_central (
    id_registro integer NOT NULL,
    id_empleado integer,
    accion character varying(80) NOT NULL,
    entidad_afectada character varying(60) NOT NULL,
    id_entidad_afectada integer,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    detalle character varying(400)
);

-- ============================================================================
-- 4. RESTRICCIONES DE INTEGRIDAD
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 4.1 Llaves primarias
-- ----------------------------------------------------------------------------

ALTER TABLE categoria
    ADD CONSTRAINT categoria_pkey PRIMARY KEY (id_categoria);

ALTER TABLE rol
    ADD CONSTRAINT rol_pkey PRIMARY KEY (id_rol);

ALTER TABLE permiso
    ADD CONSTRAINT permiso_pkey PRIMARY KEY (id_permiso);

ALTER TABLE metodo_pago
    ADD CONSTRAINT metodo_pago_pkey PRIMARY KEY (id_metodo_pago);

ALTER TABLE proveedor
    ADD CONSTRAINT proveedor_pkey PRIMARY KEY (id_proveedor);

ALTER TABLE tienda
    ADD CONSTRAINT tienda_pkey PRIMARY KEY (id_tienda);

ALTER TABLE medicamento
    ADD CONSTRAINT medicamento_pkey PRIMARY KEY (id_medicamento);

ALTER TABLE medicamento_proveedor
    ADD CONSTRAINT medicamento_proveedor_pkey PRIMARY KEY (id_medicamento, id_proveedor);

ALTER TABLE umbral_stock
    ADD CONSTRAINT umbral_stock_pkey PRIMARY KEY (id_tienda, id_medicamento);

ALTER TABLE inventario_consolidado
    ADD CONSTRAINT inventario_consolidado_pkey PRIMARY KEY (id_inventario_consolidado);

ALTER TABLE precio_medicamento
    ADD CONSTRAINT precio_medicamento_pkey PRIMARY KEY (id_precio);

ALTER TABLE empleado
    ADD CONSTRAINT empleado_pkey PRIMARY KEY (id_empleado);

ALTER TABLE rol_permiso
    ADD CONSTRAINT rol_permiso_pkey PRIMARY KEY (id_rol, id_permiso);

ALTER TABLE traslado
    ADD CONSTRAINT traslado_pkey PRIMARY KEY (id_traslado);

ALTER TABLE detalle_traslado
    ADD CONSTRAINT detalle_traslado_pkey PRIMARY KEY (id_traslado, id_medicamento);

ALTER TABLE venta_consolidada
    ADD CONSTRAINT venta_consolidada_pkey PRIMARY KEY (id_venta_consolidada);

ALTER TABLE registro_actividad_central
    ADD CONSTRAINT registro_actividad_central_pkey PRIMARY KEY (id_registro);

-- ----------------------------------------------------------------------------
-- 4.2 Restricciones UNIQUE
-- ----------------------------------------------------------------------------

ALTER TABLE categoria
    ADD CONSTRAINT categoria_nombre_key UNIQUE (nombre);

ALTER TABLE rol
    ADD CONSTRAINT rol_nombre_key UNIQUE (nombre);

ALTER TABLE permiso
    ADD CONSTRAINT permiso_codigo_key UNIQUE (codigo);

ALTER TABLE metodo_pago
    ADD CONSTRAINT metodo_pago_nombre_key UNIQUE (nombre);

ALTER TABLE proveedor
    ADD CONSTRAINT proveedor_nit_key UNIQUE (nit);

ALTER TABLE medicamento
    ADD CONSTRAINT medicamento_codigo_interno_key UNIQUE (codigo_interno);

ALTER TABLE inventario_consolidado
    ADD CONSTRAINT inventario_consolidado_id_tienda_id_medicamento_key UNIQUE (id_tienda, id_medicamento);

ALTER TABLE empleado
    ADD CONSTRAINT empleado_usuario_key UNIQUE (usuario);

ALTER TABLE venta_consolidada
    ADD CONSTRAINT venta_consolidada_id_tienda_fecha_id_metodo_pago_key UNIQUE (id_tienda, fecha, id_metodo_pago);

-- ----------------------------------------------------------------------------
-- 4.3 Llaves foraneas (relaciones)
-- ----------------------------------------------------------------------------

ALTER TABLE medicamento
    ADD CONSTRAINT medicamento_id_categoria_fkey FOREIGN KEY (id_categoria)
        REFERENCES categoria (id_categoria);

ALTER TABLE medicamento_proveedor
    ADD CONSTRAINT medicamento_proveedor_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento (id_medicamento) ON DELETE CASCADE;

ALTER TABLE medicamento_proveedor
    ADD CONSTRAINT medicamento_proveedor_id_proveedor_fkey FOREIGN KEY (id_proveedor)
        REFERENCES proveedor (id_proveedor) ON DELETE CASCADE;

ALTER TABLE umbral_stock
    ADD CONSTRAINT umbral_stock_id_tienda_fkey FOREIGN KEY (id_tienda)
        REFERENCES tienda (id_tienda) ON DELETE CASCADE;

ALTER TABLE umbral_stock
    ADD CONSTRAINT umbral_stock_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento (id_medicamento) ON DELETE CASCADE;

ALTER TABLE inventario_consolidado
    ADD CONSTRAINT inventario_consolidado_id_tienda_fkey FOREIGN KEY (id_tienda)
        REFERENCES tienda (id_tienda);

ALTER TABLE inventario_consolidado
    ADD CONSTRAINT inventario_consolidado_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento (id_medicamento);

ALTER TABLE precio_medicamento
    ADD CONSTRAINT precio_medicamento_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento (id_medicamento);

ALTER TABLE precio_medicamento
    ADD CONSTRAINT precio_medicamento_id_empleado_registro_fkey FOREIGN KEY (id_empleado_registro)
        REFERENCES empleado (id_empleado);

ALTER TABLE empleado
    ADD CONSTRAINT empleado_id_tienda_fkey FOREIGN KEY (id_tienda)
        REFERENCES tienda (id_tienda);

ALTER TABLE empleado
    ADD CONSTRAINT empleado_id_rol_fkey FOREIGN KEY (id_rol)
        REFERENCES rol (id_rol);

ALTER TABLE rol_permiso
    ADD CONSTRAINT rol_permiso_id_rol_fkey FOREIGN KEY (id_rol)
        REFERENCES rol (id_rol) ON DELETE CASCADE;

ALTER TABLE rol_permiso
    ADD CONSTRAINT rol_permiso_id_permiso_fkey FOREIGN KEY (id_permiso)
        REFERENCES permiso (id_permiso) ON DELETE CASCADE;

ALTER TABLE traslado
    ADD CONSTRAINT traslado_id_tienda_origen_fkey FOREIGN KEY (id_tienda_origen)
        REFERENCES tienda (id_tienda);

ALTER TABLE traslado
    ADD CONSTRAINT traslado_id_tienda_destino_fkey FOREIGN KEY (id_tienda_destino)
        REFERENCES tienda (id_tienda);

ALTER TABLE traslado
    ADD CONSTRAINT traslado_id_empleado_solicitante_fkey FOREIGN KEY (id_empleado_solicitante)
        REFERENCES empleado (id_empleado);

ALTER TABLE detalle_traslado
    ADD CONSTRAINT detalle_traslado_id_traslado_fkey FOREIGN KEY (id_traslado)
        REFERENCES traslado (id_traslado) ON DELETE CASCADE;

ALTER TABLE detalle_traslado
    ADD CONSTRAINT detalle_traslado_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento (id_medicamento);

ALTER TABLE venta_consolidada
    ADD CONSTRAINT venta_consolidada_id_tienda_fkey FOREIGN KEY (id_tienda)
        REFERENCES tienda (id_tienda);

ALTER TABLE venta_consolidada
    ADD CONSTRAINT venta_consolidada_id_metodo_pago_fkey FOREIGN KEY (id_metodo_pago)
        REFERENCES metodo_pago (id_metodo_pago);

ALTER TABLE registro_actividad_central
    ADD CONSTRAINT registro_actividad_central_id_empleado_fkey FOREIGN KEY (id_empleado)
        REFERENCES empleado (id_empleado);

-- ============================================================================
-- 5. INDICES
-- ============================================================================

CREATE INDEX idx_empleado_tienda ON empleado USING btree (id_tienda);

CREATE INDEX idx_inventario_consolidado_medicamento
    ON inventario_consolidado USING btree (id_medicamento);

CREATE INDEX idx_medicamento_nombre ON medicamento USING btree (nombre_comercial);

CREATE INDEX idx_medicamento_principio ON medicamento USING btree (principio_activo);

CREATE INDEX idx_precio_medicamento_vigencia
    ON precio_medicamento USING btree (id_medicamento, fecha_inicio_vigencia);

CREATE INDEX idx_traslado_destino ON traslado USING btree (id_tienda_destino);

CREATE INDEX idx_traslado_origen ON traslado USING btree (id_tienda_origen);

CREATE INDEX idx_venta_consolidada_fecha ON venta_consolidada USING btree (fecha);

-- ============================================================================
-- 6. ASOCIACION DE SECUENCIAS A LAS COLUMNAS SERIAL
-- ============================================================================

ALTER TABLE categoria ALTER COLUMN id_categoria
    SET DEFAULT nextval('categoria_id_categoria_seq'::regclass);

ALTER TABLE empleado ALTER COLUMN id_empleado
    SET DEFAULT nextval('empleado_id_empleado_seq'::regclass);

ALTER TABLE inventario_consolidado ALTER COLUMN id_inventario_consolidado
    SET DEFAULT nextval('inventario_consolidado_id_inventario_consolidado_seq'::regclass);

ALTER TABLE medicamento ALTER COLUMN id_medicamento
    SET DEFAULT nextval('medicamento_id_medicamento_seq'::regclass);

ALTER TABLE metodo_pago ALTER COLUMN id_metodo_pago
    SET DEFAULT nextval('metodo_pago_id_metodo_pago_seq'::regclass);

ALTER TABLE permiso ALTER COLUMN id_permiso
    SET DEFAULT nextval('permiso_id_permiso_seq'::regclass);

ALTER TABLE precio_medicamento ALTER COLUMN id_precio
    SET DEFAULT nextval('precio_medicamento_id_precio_seq'::regclass);

ALTER TABLE proveedor ALTER COLUMN id_proveedor
    SET DEFAULT nextval('proveedor_id_proveedor_seq'::regclass);

ALTER TABLE registro_actividad_central ALTER COLUMN id_registro
    SET DEFAULT nextval('registro_actividad_central_id_registro_seq'::regclass);

ALTER TABLE rol ALTER COLUMN id_rol
    SET DEFAULT nextval('rol_id_rol_seq'::regclass);

ALTER TABLE tienda ALTER COLUMN id_tienda
    SET DEFAULT nextval('tienda_id_tienda_seq'::regclass);

ALTER TABLE traslado ALTER COLUMN id_traslado
    SET DEFAULT nextval('traslado_id_traslado_seq'::regclass);

ALTER TABLE venta_consolidada ALTER COLUMN id_venta_consolidada
    SET DEFAULT nextval('venta_consolidada_id_venta_consolidada_seq'::regclass);

-- ============================================================================
--  FIN DEL SCRIPT DEL NODO CENTRAL
-- ============================================================================
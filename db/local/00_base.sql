-- Esquema base del nodo local (farmacia). Copia de Script_BDFarmacias_nodo_farmacia.sql sin
-- CREATE DATABASE ni \connect (en Neon la base ya existe). NO es idempotente:
-- el migrador solo lo ejecuta cuando la base está vacía.

-- ============================================================================
--  SCRIPT DE CREACION - BASE DE DATOS DEL NODO LOCAL (FARMACIA SUR)
--  Proyecto: Sistema de Gestion de Franquicia de Farmacias
--  Base de datos: "Sistema de gestion de farmacia-farmacia sur"
--
--  Contenido:
--   1. Creacion de la base de datos
--   2. Secuencias
--   3. Tablas (con restricciones CHECK y valores por defecto)
--   4. Restricciones de integridad (PRIMARY KEY, UNIQUE, FOREIGN KEY)
--   5. Indices
--   6. Vistas
--
--  Notas:
--   - Las tablas con sufijo _ref almacenan una copia local de los datos
--     maestros sincronizados desde el nodo central (autonomia RNF-04).
--   - Las correcciones del archivo correcciones_nodo_farmacia.sql ya estan
--     aplicadas (contrasena_hash, integridad total de factura, cantidad > 0).
--   - Al momento de la extraccion la base no contenia registros,
--     por lo que el script reconstruye solo la estructura.
--
--  Uso:  psql -U postgres -f Script_BDFarmacias_nodo_farmacia.sql
-- ============================================================================

SET client_encoding = 'UTF8';

-- ============================================================================
-- 1. CREACION DE LA BASE DE DATOS
-- ============================================================================


SET client_encoding = 'UTF8';

-- ============================================================================
-- 2. SECUENCIAS
-- ============================================================================

CREATE SEQUENCE anulacion_devolucion_id_anulacion_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE cierre_caja_id_cierre_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE cliente_id_cliente_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE factura_id_factura_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE lote_id_lote_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE movimiento_inventario_id_movimiento_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE pedido_id_pedido_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE receta_id_receta_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE SEQUENCE registro_actividad_id_registro_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

-- ============================================================================
-- 3. TABLAS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 3.1 Datos maestros sincronizados desde el nodo central (tablas _ref)
-- ----------------------------------------------------------------------------

CREATE TABLE categoria_ref (
    id_categoria integer NOT NULL,
    nombre character varying(80) NOT NULL
);

CREATE TABLE rol_ref (
    id_rol integer NOT NULL,
    nombre character varying(40) NOT NULL
);

CREATE TABLE metodo_pago_ref (
    id_metodo_pago integer NOT NULL,
    nombre character varying(40) NOT NULL,
    activo boolean DEFAULT true NOT NULL
);

CREATE TABLE proveedor_ref (
    id_proveedor integer NOT NULL,
    nombre_empresa character varying(150) NOT NULL,
    activo boolean DEFAULT true NOT NULL
);

CREATE TABLE tienda_ref (
    id_tienda integer NOT NULL,
    nombre character varying(120) NOT NULL,
    activa boolean DEFAULT true NOT NULL,
    es_tienda_local boolean DEFAULT false NOT NULL
);

CREATE TABLE medicamento_ref (
    id_medicamento integer NOT NULL,
    codigo_interno character varying(40) NOT NULL,
    nombre_comercial character varying(150) NOT NULL,
    principio_activo character varying(150) NOT NULL,
    id_categoria integer,
    requiere_receta boolean DEFAULT false NOT NULL,
    requiere_refrigeracion boolean DEFAULT false NOT NULL,
    activo boolean DEFAULT true NOT NULL
);

CREATE TABLE empleado_ref (
    id_empleado integer NOT NULL,
    id_rol integer NOT NULL,
    nombre_completo character varying(150) NOT NULL,
    usuario character varying(60) NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    contrasena_hash character varying(255)
);

CREATE TABLE precio_vigente_ref (
    id_medicamento integer NOT NULL,
    precio numeric(12,2) NOT NULL,
    fecha_vigencia timestamp without time zone NOT NULL,
    CONSTRAINT precio_vigente_ref_precio_check CHECK (precio >= 0)
);

CREATE TABLE umbral_stock_ref (
    id_medicamento integer NOT NULL,
    stock_minimo integer DEFAULT 0 NOT NULL,
    dias_alerta_caducidad integer DEFAULT 30 NOT NULL
);

-- ----------------------------------------------------------------------------
-- 3.2 Clientes
-- ----------------------------------------------------------------------------

CREATE TABLE cliente (
    id_cliente integer NOT NULL,
    nombre character varying(150) NOT NULL,
    documento_identidad character varying(40),
    telefono character varying(30),
    correo character varying(120)
);

-- ----------------------------------------------------------------------------
-- 3.3 Compras e inventario
-- ----------------------------------------------------------------------------

CREATE TABLE pedido (
    id_pedido integer NOT NULL,
    id_proveedor integer NOT NULL,
    id_empleado_solicitante integer NOT NULL,
    origen_solicitud character varying(20) NOT NULL,
    fecha_solicitud timestamp without time zone DEFAULT now() NOT NULL,
    estado character varying(20) DEFAULT 'SOLICITADO' NOT NULL,
    fecha_recepcion timestamp without time zone,
    CONSTRAINT pedido_origen_solicitud_check CHECK (
        origen_solicitud IN ('ALERTA_AUTOMATICA', 'MANUAL')
    ),
    CONSTRAINT pedido_estado_check CHECK (
        estado IN ('SOLICITADO', 'RECIBIDO_PARCIAL', 'RECIBIDO_TOTAL', 'CANCELADO')
    )
);

CREATE TABLE detalle_pedido (
    id_pedido integer NOT NULL,
    id_medicamento integer NOT NULL,
    cantidad_solicitada integer NOT NULL,
    cantidad_recibida integer DEFAULT 0 NOT NULL,
    CONSTRAINT detalle_pedido_cantidad_solicitada_check CHECK (cantidad_solicitada > 0),
    CONSTRAINT detalle_pedido_cantidad_recibida_check CHECK (cantidad_recibida >= 0)
);

CREATE TABLE lote (
    id_lote integer NOT NULL,
    id_medicamento integer NOT NULL,
    id_proveedor integer NOT NULL,
    numero_lote character varying(60) NOT NULL,
    fecha_ingreso date DEFAULT CURRENT_DATE NOT NULL,
    fecha_caducidad date NOT NULL,
    cantidad_inicial integer NOT NULL,
    cantidad_disponible integer NOT NULL,
    estado character varying(15) DEFAULT 'DISPONIBLE' NOT NULL,
    fecha_registro timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT lote_cantidad_inicial_check CHECK (cantidad_inicial >= 0),
    CONSTRAINT lote_cantidad_disponible_check CHECK (cantidad_disponible >= 0),
    CONSTRAINT lote_estado_check CHECK (
        estado IN ('DISPONIBLE', 'BLOQUEADO', 'AGOTADO')
    )
);

CREATE TABLE movimiento_inventario (
    id_movimiento integer NOT NULL,
    id_lote integer NOT NULL,
    tipo_movimiento character varying(20) NOT NULL,
    cantidad integer NOT NULL,
    id_empleado integer NOT NULL,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    referencia_documento character varying(60),
    id_traslado integer,
    rol_tienda_traslado character varying(10),
    observaciones character varying(300),
    CONSTRAINT movimiento_cantidad_check CHECK (cantidad > 0),
    CONSTRAINT movimiento_inventario_tipo_movimiento_check CHECK (
        tipo_movimiento IN ('ENTRADA', 'VENTA', 'AJUSTE', 'DEVOLUCION',
                            'TRASLADO_SALIDA', 'TRASLADO_ENTRADA')
    )
);

-- ----------------------------------------------------------------------------
-- 3.4 Ventas, devoluciones y recetas
-- ----------------------------------------------------------------------------

CREATE TABLE factura (
    id_factura integer NOT NULL,
    numero_factura character varying(30) NOT NULL,
    id_cliente integer,
    id_empleado integer NOT NULL,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    subtotal numeric(14,2) NOT NULL,
    impuestos numeric(14,2) NOT NULL,
    total numeric(14,2) NOT NULL,
    estado character varying(20) DEFAULT 'EMITIDA' NOT NULL,
    CONSTRAINT factura_subtotal_check CHECK (subtotal >= 0),
    CONSTRAINT factura_impuestos_check CHECK (impuestos >= 0),
    CONSTRAINT factura_total_check CHECK (total >= 0),
    CONSTRAINT factura_total_integridad_check CHECK (total = subtotal + impuestos),
    CONSTRAINT factura_estado_check CHECK (
        estado IN ('EMITIDA', 'ANULADA', 'DEVOLUCION_PARCIAL')
    )
);

CREATE TABLE detalle_factura (
    id_factura integer NOT NULL,
    id_lote integer NOT NULL,
    id_receta integer,
    cantidad integer NOT NULL,
    precio_unitario_aplicado numeric(12,2) NOT NULL,
    subtotal_linea numeric(14,2) NOT NULL,
    CONSTRAINT detalle_factura_cantidad_check CHECK (cantidad > 0)
);

CREATE TABLE factura_metodo_pago (
    id_factura integer NOT NULL,
    id_metodo_pago integer NOT NULL,
    monto numeric(14,2) NOT NULL,
    CONSTRAINT factura_metodo_pago_monto_check CHECK (monto > 0)
);

CREATE TABLE anulacion_devolucion (
    id_anulacion integer NOT NULL,
    id_factura integer NOT NULL,
    tipo character varying(20) NOT NULL,
    motivo character varying(300) NOT NULL,
    id_empleado integer NOT NULL,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT anulacion_devolucion_tipo_check CHECK (
        tipo IN ('ANULACION_TOTAL', 'DEVOLUCION_PARCIAL')
    )
);

CREATE TABLE detalle_devolucion (
    id_anulacion integer NOT NULL,
    id_lote integer NOT NULL,
    cantidad_devuelta integer NOT NULL,
    CONSTRAINT detalle_devolucion_cantidad_devuelta_check CHECK (cantidad_devuelta > 0)
);

CREATE TABLE receta (
    id_receta integer NOT NULL,
    medico_prescriptor character varying(150) NOT NULL,
    fecha_emision date NOT NULL,
    id_cliente integer,
    fecha_registro timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE receta_medicamento (
    id_receta integer NOT NULL,
    id_medicamento integer NOT NULL,
    cantidad_autorizada integer NOT NULL,
    CONSTRAINT receta_medicamento_cantidad_autorizada_check CHECK (cantidad_autorizada > 0)
);

-- ----------------------------------------------------------------------------
-- 3.5 Cierre de caja
-- ----------------------------------------------------------------------------

CREATE TABLE cierre_caja (
    id_cierre integer NOT NULL,
    id_empleado integer NOT NULL,
    fecha date NOT NULL,
    turno character varying(20),
    total_sistema numeric(14,2) NOT NULL,
    total_efectivo_contado numeric(14,2) NOT NULL,
    total_vouchers numeric(14,2) NOT NULL,
    diferencia numeric(14,2) DEFAULT 0 NOT NULL,
    estado character varying(20) DEFAULT 'CONCILIADO' NOT NULL,
    fecha_hora_cierre timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT cierre_caja_estado_check CHECK (
        estado IN ('CONCILIADO', 'CON_DIFERENCIA')
    )
);

CREATE TABLE cierre_caja_metodo_pago (
    id_cierre integer NOT NULL,
    id_metodo_pago integer NOT NULL,
    total_calculado_sistema numeric(14,2) DEFAULT 0 NOT NULL,
    total_reportado_empleado numeric(14,2) DEFAULT 0 NOT NULL
);

-- ----------------------------------------------------------------------------
-- 3.6 Traslados entre nodos
-- ----------------------------------------------------------------------------

CREATE TABLE traslado_local (
    id_traslado integer NOT NULL,
    rol_tienda character varying(10) NOT NULL,
    id_tienda_origen integer NOT NULL,
    id_tienda_destino integer NOT NULL,
    estado_local character varying(20) NOT NULL,
    fecha_hora timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT traslado_local_check CHECK (id_tienda_origen <> id_tienda_destino),
    CONSTRAINT traslado_local_rol_tienda_check CHECK (
        rol_tienda IN ('ORIGEN', 'DESTINO')
    ),
    CONSTRAINT traslado_local_estado_local_check CHECK (
        estado_local IN ('PENDIENTE', 'DESCONTADO', 'RECIBIDO', 'COMPENSADO')
    )
);

CREATE TABLE detalle_traslado_local (
    id_traslado integer NOT NULL,
    rol_tienda character varying(10) NOT NULL,
    id_medicamento integer NOT NULL,
    id_lote integer,
    cantidad integer NOT NULL,
    CONSTRAINT detalle_traslado_local_cantidad_check CHECK (cantidad > 0)
);

-- ----------------------------------------------------------------------------
-- 3.7 Auditoria
-- ----------------------------------------------------------------------------

CREATE TABLE registro_actividad (
    id_registro integer NOT NULL,
    id_empleado integer NOT NULL,
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

ALTER TABLE categoria_ref
    ADD CONSTRAINT categoria_ref_pkey PRIMARY KEY (id_categoria);

ALTER TABLE rol_ref
    ADD CONSTRAINT rol_ref_pkey PRIMARY KEY (id_rol);

ALTER TABLE metodo_pago_ref
    ADD CONSTRAINT metodo_pago_ref_pkey PRIMARY KEY (id_metodo_pago);

ALTER TABLE proveedor_ref
    ADD CONSTRAINT proveedor_ref_pkey PRIMARY KEY (id_proveedor);

ALTER TABLE tienda_ref
    ADD CONSTRAINT tienda_ref_pkey PRIMARY KEY (id_tienda);

ALTER TABLE medicamento_ref
    ADD CONSTRAINT medicamento_ref_pkey PRIMARY KEY (id_medicamento);

ALTER TABLE empleado_ref
    ADD CONSTRAINT empleado_ref_pkey PRIMARY KEY (id_empleado);

ALTER TABLE precio_vigente_ref
    ADD CONSTRAINT precio_vigente_ref_pkey PRIMARY KEY (id_medicamento);

ALTER TABLE umbral_stock_ref
    ADD CONSTRAINT umbral_stock_ref_pkey PRIMARY KEY (id_medicamento);

ALTER TABLE cliente
    ADD CONSTRAINT cliente_pkey PRIMARY KEY (id_cliente);

ALTER TABLE pedido
    ADD CONSTRAINT pedido_pkey PRIMARY KEY (id_pedido);

ALTER TABLE detalle_pedido
    ADD CONSTRAINT detalle_pedido_pkey PRIMARY KEY (id_pedido, id_medicamento);

ALTER TABLE lote
    ADD CONSTRAINT lote_pkey PRIMARY KEY (id_lote);

ALTER TABLE movimiento_inventario
    ADD CONSTRAINT movimiento_inventario_pkey PRIMARY KEY (id_movimiento);

ALTER TABLE factura
    ADD CONSTRAINT factura_pkey PRIMARY KEY (id_factura);

ALTER TABLE detalle_factura
    ADD CONSTRAINT detalle_factura_pkey PRIMARY KEY (id_factura, id_lote);

ALTER TABLE factura_metodo_pago
    ADD CONSTRAINT factura_metodo_pago_pkey PRIMARY KEY (id_factura, id_metodo_pago);

ALTER TABLE anulacion_devolucion
    ADD CONSTRAINT anulacion_devolucion_pkey PRIMARY KEY (id_anulacion);

ALTER TABLE detalle_devolucion
    ADD CONSTRAINT detalle_devolucion_pkey PRIMARY KEY (id_anulacion, id_lote);

ALTER TABLE receta
    ADD CONSTRAINT receta_pkey PRIMARY KEY (id_receta);

ALTER TABLE receta_medicamento
    ADD CONSTRAINT receta_medicamento_pkey PRIMARY KEY (id_receta, id_medicamento);

ALTER TABLE cierre_caja
    ADD CONSTRAINT cierre_caja_pkey PRIMARY KEY (id_cierre);

ALTER TABLE cierre_caja_metodo_pago
    ADD CONSTRAINT cierre_caja_metodo_pago_pkey PRIMARY KEY (id_cierre, id_metodo_pago);

ALTER TABLE traslado_local
    ADD CONSTRAINT traslado_local_pkey PRIMARY KEY (id_traslado, rol_tienda);

ALTER TABLE detalle_traslado_local
    ADD CONSTRAINT detalle_traslado_local_pkey PRIMARY KEY (id_traslado, rol_tienda, id_medicamento);

ALTER TABLE registro_actividad
    ADD CONSTRAINT registro_actividad_pkey PRIMARY KEY (id_registro);

-- ----------------------------------------------------------------------------
-- 4.2 Restricciones UNIQUE
-- ----------------------------------------------------------------------------

ALTER TABLE cliente
    ADD CONSTRAINT cliente_documento_identidad_key UNIQUE (documento_identidad);

ALTER TABLE factura
    ADD CONSTRAINT factura_numero_factura_key UNIQUE (numero_factura);

ALTER TABLE lote
    ADD CONSTRAINT lote_id_medicamento_id_proveedor_numero_lote_key
        UNIQUE (id_medicamento, id_proveedor, numero_lote);

-- ----------------------------------------------------------------------------
-- 4.3 Llaves foraneas (relaciones)
-- ----------------------------------------------------------------------------

ALTER TABLE medicamento_ref
    ADD CONSTRAINT medicamento_ref_id_categoria_fkey FOREIGN KEY (id_categoria)
        REFERENCES categoria_ref (id_categoria);

ALTER TABLE empleado_ref
    ADD CONSTRAINT empleado_ref_id_rol_fkey FOREIGN KEY (id_rol)
        REFERENCES rol_ref (id_rol);

ALTER TABLE precio_vigente_ref
    ADD CONSTRAINT precio_vigente_ref_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento_ref (id_medicamento);

ALTER TABLE umbral_stock_ref
    ADD CONSTRAINT umbral_stock_ref_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento_ref (id_medicamento);

ALTER TABLE pedido
    ADD CONSTRAINT pedido_id_proveedor_fkey FOREIGN KEY (id_proveedor)
        REFERENCES proveedor_ref (id_proveedor);

ALTER TABLE pedido
    ADD CONSTRAINT pedido_id_empleado_solicitante_fkey FOREIGN KEY (id_empleado_solicitante)
        REFERENCES empleado_ref (id_empleado);

ALTER TABLE detalle_pedido
    ADD CONSTRAINT detalle_pedido_id_pedido_fkey FOREIGN KEY (id_pedido)
        REFERENCES pedido (id_pedido) ON DELETE CASCADE;

ALTER TABLE detalle_pedido
    ADD CONSTRAINT detalle_pedido_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento_ref (id_medicamento);

ALTER TABLE lote
    ADD CONSTRAINT lote_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento_ref (id_medicamento);

ALTER TABLE lote
    ADD CONSTRAINT lote_id_proveedor_fkey FOREIGN KEY (id_proveedor)
        REFERENCES proveedor_ref (id_proveedor);

ALTER TABLE movimiento_inventario
    ADD CONSTRAINT movimiento_inventario_id_lote_fkey FOREIGN KEY (id_lote)
        REFERENCES lote (id_lote);

ALTER TABLE movimiento_inventario
    ADD CONSTRAINT movimiento_inventario_id_empleado_fkey FOREIGN KEY (id_empleado)
        REFERENCES empleado_ref (id_empleado);

ALTER TABLE factura
    ADD CONSTRAINT factura_id_cliente_fkey FOREIGN KEY (id_cliente)
        REFERENCES cliente (id_cliente);

ALTER TABLE factura
    ADD CONSTRAINT factura_id_empleado_fkey FOREIGN KEY (id_empleado)
        REFERENCES empleado_ref (id_empleado);

ALTER TABLE detalle_factura
    ADD CONSTRAINT detalle_factura_id_factura_fkey FOREIGN KEY (id_factura)
        REFERENCES factura (id_factura) ON DELETE CASCADE;

ALTER TABLE detalle_factura
    ADD CONSTRAINT detalle_factura_id_lote_fkey FOREIGN KEY (id_lote)
        REFERENCES lote (id_lote);

ALTER TABLE detalle_factura
    ADD CONSTRAINT detalle_factura_id_receta_fkey FOREIGN KEY (id_receta)
        REFERENCES receta (id_receta);

ALTER TABLE factura_metodo_pago
    ADD CONSTRAINT factura_metodo_pago_id_factura_fkey FOREIGN KEY (id_factura)
        REFERENCES factura (id_factura) ON DELETE CASCADE;

ALTER TABLE factura_metodo_pago
    ADD CONSTRAINT factura_metodo_pago_id_metodo_pago_fkey FOREIGN KEY (id_metodo_pago)
        REFERENCES metodo_pago_ref (id_metodo_pago);

ALTER TABLE anulacion_devolucion
    ADD CONSTRAINT anulacion_devolucion_id_factura_fkey FOREIGN KEY (id_factura)
        REFERENCES factura (id_factura);

ALTER TABLE anulacion_devolucion
    ADD CONSTRAINT anulacion_devolucion_id_empleado_fkey FOREIGN KEY (id_empleado)
        REFERENCES empleado_ref (id_empleado);

ALTER TABLE detalle_devolucion
    ADD CONSTRAINT detalle_devolucion_id_anulacion_fkey FOREIGN KEY (id_anulacion)
        REFERENCES anulacion_devolucion (id_anulacion) ON DELETE CASCADE;

ALTER TABLE detalle_devolucion
    ADD CONSTRAINT detalle_devolucion_id_lote_fkey FOREIGN KEY (id_lote)
        REFERENCES lote (id_lote);

ALTER TABLE receta
    ADD CONSTRAINT receta_id_cliente_fkey FOREIGN KEY (id_cliente)
        REFERENCES cliente (id_cliente);

ALTER TABLE receta_medicamento
    ADD CONSTRAINT receta_medicamento_id_receta_fkey FOREIGN KEY (id_receta)
        REFERENCES receta (id_receta) ON DELETE CASCADE;

ALTER TABLE receta_medicamento
    ADD CONSTRAINT receta_medicamento_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento_ref (id_medicamento);

ALTER TABLE cierre_caja
    ADD CONSTRAINT cierre_caja_id_empleado_fkey FOREIGN KEY (id_empleado)
        REFERENCES empleado_ref (id_empleado);

ALTER TABLE cierre_caja_metodo_pago
    ADD CONSTRAINT cierre_caja_metodo_pago_id_cierre_fkey FOREIGN KEY (id_cierre)
        REFERENCES cierre_caja (id_cierre) ON DELETE CASCADE;

ALTER TABLE cierre_caja_metodo_pago
    ADD CONSTRAINT cierre_caja_metodo_pago_id_metodo_pago_fkey FOREIGN KEY (id_metodo_pago)
        REFERENCES metodo_pago_ref (id_metodo_pago);

ALTER TABLE traslado_local
    ADD CONSTRAINT traslado_local_id_tienda_origen_fkey FOREIGN KEY (id_tienda_origen)
        REFERENCES tienda_ref (id_tienda);

ALTER TABLE traslado_local
    ADD CONSTRAINT traslado_local_id_tienda_destino_fkey FOREIGN KEY (id_tienda_destino)
        REFERENCES tienda_ref (id_tienda);

ALTER TABLE detalle_traslado_local
    ADD CONSTRAINT detalle_traslado_local_id_traslado_rol_tienda_fkey
        FOREIGN KEY (id_traslado, rol_tienda)
        REFERENCES traslado_local (id_traslado, rol_tienda) ON DELETE CASCADE;

ALTER TABLE detalle_traslado_local
    ADD CONSTRAINT detalle_traslado_local_id_medicamento_fkey FOREIGN KEY (id_medicamento)
        REFERENCES medicamento_ref (id_medicamento);

ALTER TABLE detalle_traslado_local
    ADD CONSTRAINT detalle_traslado_local_id_lote_fkey FOREIGN KEY (id_lote)
        REFERENCES lote (id_lote);

ALTER TABLE movimiento_inventario
    ADD CONSTRAINT fk_movimiento_traslado FOREIGN KEY (id_traslado, rol_tienda_traslado)
        REFERENCES traslado_local (id_traslado, rol_tienda);

ALTER TABLE registro_actividad
    ADD CONSTRAINT registro_actividad_id_empleado_fkey FOREIGN KEY (id_empleado)
        REFERENCES empleado_ref (id_empleado);

-- ============================================================================
-- 5. INDICES
-- ============================================================================

CREATE INDEX idx_factura_cliente ON factura USING btree (id_cliente);

CREATE INDEX idx_factura_fecha ON factura USING btree (fecha_hora);

CREATE INDEX idx_lote_caducidad ON lote USING btree (fecha_caducidad);

CREATE INDEX idx_lote_estado ON lote USING btree (estado);

CREATE INDEX idx_lote_medicamento ON lote USING btree (id_medicamento);

CREATE INDEX idx_medicamento_ref_nombre ON medicamento_ref USING btree (nombre_comercial);

CREATE INDEX idx_medicamento_ref_principio ON medicamento_ref USING btree (principio_activo);

CREATE INDEX idx_movimiento_fecha ON movimiento_inventario USING btree (fecha_hora);

CREATE INDEX idx_movimiento_lote ON movimiento_inventario USING btree (id_lote);

CREATE INDEX idx_movimiento_traslado
    ON movimiento_inventario USING btree (id_traslado, rol_tienda_traslado);

CREATE INDEX idx_registro_actividad_empleado
    ON registro_actividad USING btree (id_empleado);

CREATE INDEX idx_registro_actividad_fecha ON registro_actividad USING btree (fecha_hora);

-- ============================================================================
-- 6. VISTAS
-- ============================================================================

-- Stock total por medicamento disponible en la tienda
CREATE VIEW vw_stock_tienda AS
SELECT
    l.id_medicamento,
    m.nombre_comercial,
    SUM(l.cantidad_disponible) AS stock_total
FROM lote l
JOIN medicamento_ref m ON m.id_medicamento = l.id_medicamento
WHERE l.estado = 'DISPONIBLE'
GROUP BY l.id_medicamento, m.nombre_comercial;

-- Lotes proximos a caducar segun umbral de alerta configurado
CREATE VIEW vw_alerta_caducidad AS
SELECT
    l.id_lote,
    l.id_medicamento,
    m.nombre_comercial,
    l.numero_lote,
    l.fecha_caducidad,
    l.cantidad_disponible
FROM lote l
JOIN medicamento_ref m ON m.id_medicamento = l.id_medicamento
JOIN umbral_stock_ref u ON u.id_medicamento = l.id_medicamento
WHERE l.estado = 'DISPONIBLE'
  AND l.fecha_caducidad <= (CURRENT_DATE + (u.dias_alerta_caducidad || ' days')::interval);

-- Medicamentos con stock menor o igual al minimo configurado
CREATE VIEW vw_alerta_stock_bajo AS
SELECT
    s.id_medicamento,
    s.nombre_comercial,
    s.stock_total,
    u.stock_minimo
FROM vw_stock_tienda s
JOIN umbral_stock_ref u ON u.id_medicamento = s.id_medicamento
WHERE s.stock_total <= u.stock_minimo;

-- ============================================================================
-- 7. ASOCIACION DE SECUENCIAS A LAS COLUMNAS SERIAL
-- ============================================================================

ALTER TABLE anulacion_devolucion ALTER COLUMN id_anulacion
    SET DEFAULT nextval('anulacion_devolucion_id_anulacion_seq'::regclass);

ALTER TABLE cierre_caja ALTER COLUMN id_cierre
    SET DEFAULT nextval('cierre_caja_id_cierre_seq'::regclass);

ALTER TABLE cliente ALTER COLUMN id_cliente
    SET DEFAULT nextval('cliente_id_cliente_seq'::regclass);

ALTER TABLE factura ALTER COLUMN id_factura
    SET DEFAULT nextval('factura_id_factura_seq'::regclass);

ALTER TABLE lote ALTER COLUMN id_lote
    SET DEFAULT nextval('lote_id_lote_seq'::regclass);

ALTER TABLE movimiento_inventario ALTER COLUMN id_movimiento
    SET DEFAULT nextval('movimiento_inventario_id_movimiento_seq'::regclass);

ALTER TABLE pedido ALTER COLUMN id_pedido
    SET DEFAULT nextval('pedido_id_pedido_seq'::regclass);

ALTER TABLE receta ALTER COLUMN id_receta
    SET DEFAULT nextval('receta_id_receta_seq'::regclass);

ALTER TABLE registro_actividad ALTER COLUMN id_registro
    SET DEFAULT nextval('registro_actividad_id_registro_seq'::regclass);

-- ============================================================================
--  FIN DEL SCRIPT DEL NODO LOCAL (FARMACIA SUR)
-- ============================================================================
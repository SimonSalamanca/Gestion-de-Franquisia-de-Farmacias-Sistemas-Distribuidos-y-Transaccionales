-- HU-08: datos maestros que necesita la venta. Idempotente. Son datos, no estructura (RNF-11): agregar un método de
-- pago o cambiar el impuesto de un medicamento es un insert/update. migrate.mjs publica a las tiendas lo que aún no
-- tiene evento de réplica (METODO_PAGO_UPSERT y MEDICAMENTO_UPSERT).

-- Impuesto de venta de cada medicamento, en porcentaje (0 = exento). La factura lo fija en cada línea al vender.
ALTER TABLE medicamento
    ADD COLUMN IF NOT EXISTS tasa_impuesto numeric(5,2) NOT NULL DEFAULT 0
        CONSTRAINT medicamento_tasa_impuesto_check CHECK (tasa_impuesto >= 0 AND tasa_impuesto <= 100);

-- Métodos de pago de la red (pago combinado: una factura puede usar varios). Los nombres son códigos en minúscula, que
-- son los que ya existen en las bases del proyecto; la API los muestra con su etiqueta ("Tarjeta débito").
INSERT INTO metodo_pago (nombre)
VALUES ('efectivo'), ('tarjeta_debito'), ('tarjeta_credito'), ('transferencia')
ON CONFLICT (nombre) DO NOTHING;

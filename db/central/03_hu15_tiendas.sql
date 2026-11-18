-- HU-15: administración de tiendas de la red. Idempotente.
-- version_tienda: control optimista de edición (dos administradores sobre la misma tienda) y
-- versión del evento TIENDA_UPSERT. El resultado por Idempotency-Key se guarda en auth_operacion (01_hu06), la tabla de
-- idempotencia común del nodo (antes había una tienda_operacion propia; 16_reduccion_tablas.sql la fusiona).

ALTER TABLE tienda
    ADD COLUMN IF NOT EXISTS version_tienda bigint NOT NULL DEFAULT 1;

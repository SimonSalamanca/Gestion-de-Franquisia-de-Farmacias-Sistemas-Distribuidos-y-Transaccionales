-- HU-15: administración de tiendas de la red. Idempotente.
-- version_tienda: control optimista de edición (dos administradores sobre la misma tienda) y
-- versión del evento TIENDA_UPSERT. tienda_operacion: resultado guardado por Idempotency-Key.

ALTER TABLE tienda
    ADD COLUMN IF NOT EXISTS version_tienda bigint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS tienda_operacion (
    idempotency_key uuid PRIMARY KEY,
    payload_hmac character(64) NOT NULL,
    resultado_http integer NOT NULL,
    cuerpo_json jsonb NOT NULL,
    creado_en timestamp with time zone NOT NULL DEFAULT now()
);

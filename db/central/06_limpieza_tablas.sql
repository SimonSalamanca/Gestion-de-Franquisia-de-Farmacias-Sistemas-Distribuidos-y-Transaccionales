-- Limpieza de tablas creadas por las historias ya desarrolladas que no cumplen ninguna función. Idempotente.
-- Solo tablas nuestras: las del diseño original (00_base.sql) que aún no se usan pertenecen a historias
-- pendientes (ventas, traslados, cierres...) y no se tocan.

-- replica_cursor (01_hu06.sql): el cursor de réplica es de cada tienda y vive en su nodo local; todo el código
-- usa esa tabla. La copia del central nunca tuvo filas ni referencias (sin FK, vistas ni funciones).
DROP TABLE IF EXISTS replica_cursor;

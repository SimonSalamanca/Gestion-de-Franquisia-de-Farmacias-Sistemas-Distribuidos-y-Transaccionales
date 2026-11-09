# HU-13 — Gestionar proveedores y generar solicitudes de reabastecimiento

Estado: **IMPLEMENTADA** (2026-11-09): API, esquemas en `db/central/13_hu13_permiso_proveedores.sql` y `db/local/11_hu13_solicitudes.sql`, módulo "Proveedores" (POS y consola), botón "Generar solicitud" en las alertas de stock y pruebas en verde (ver "Pruebas"). Pendiente el veredicto del auditor (GPT-5.6 Luna), igual que HU-03, HU-04, HU-07, HU-08 y HU-12.

Requerimientos: **RF-09** (proveedores, solicitudes de pedido y recepción), regla de negocio 11 (reabastecimiento: el pedido requiere proveedor, se crea desde una alerta o a mano, con estados pendiente/enviada/recibida), **RNF-04** (autonomía local), **RNF-06** (concurrencia), **RNF-10**.

## Historia

Como administrador de tienda, quiero mantener un registro de proveedores y generar solicitudes de pedido, ya sea automáticamente desde una alerta de stock bajo o de forma manual, para asegurar la continuidad del abastecimiento.

## Criterios de aceptación

1. El sistema permite registrar, editar y consultar proveedores de medicamentos.
2. Desde una alerta de stock bajo, el administrador puede generar una solicitud de reabastecimiento sin volver a ingresar los datos del producto.
3. También es posible generar una solicitud de reabastecimiento de forma manual, aunque no exista una alerta activa.
4. El sistema no permite generar una solicitud de reabastecimiento sin un proveedor asociado.
5. El administrador puede consultar el estado de una solicitud (pendiente, enviada, recibida).

## Decisiones (supuestos de la propuesta; pendientes de confirmar con el usuario)

1. **Quién gestiona proveedores.** Resuelve la inconsistencia 4 de `FARMAHUB_CONTEXT.md` (el UML dice Admin general; la HU dice Admin de tienda): **los dos** pueden registrar y editar, igual que HU-03 con los precios. Un permiso nuevo, `PROVEEDOR_GESTIONAR`, para el administrador de tienda y el general (no el cajero). Las solicitudes las genera el administrador de tienda (con ese mismo permiso) desde el POS.
2. **El proveedor es de la red; la solicitud es de la tienda.** `proveedor` vive en el central (único escritor, NIT único). Cada tienda guarda su copia en `proveedor_ref` y las solicitudes (`pedido`) en su propia base: no se replican al central (no hay tabla de pedidos en el central, y el diseño las trata como operación local, RNF-04).
3. **Estados.** El esquema base ya tenía `SOLICITADO`, `RECIBIDO_PARCIAL`, `RECIBIDO_TOTAL` y `CANCELADO`; HU-02 recibe pedidos sobre ellos. Se **agrega `ENVIADO`** sin renombrar nada: *pendiente* = `SOLICITADO`, *enviada* = `ENVIADO`, *recibida* = `RECIBIDO_TOTAL` (la parcial se ve como "Recibida en parte"). La recepción de HU-02 acepta una solicitud pendiente o enviada (marcarla enviada no es obligatorio).
4. **Desde una alerta.** Aplica a `STOCK_BAJO` y `STOCK_AGOTADO` activas. El producto sale de la alerta; la **cantidad sugerida repone hasta el doble del mínimo** (`2 × mínimo − stock`, al menos 1) y se puede ajustar; el proveedor sugerido es el del último lote recibido de ese medicamento, siempre que esté activo. Una alerta tiene **a lo sumo una solicitud abierta**.
5. **Un proveedor inactivo** no admite solicitudes nuevas; las que ya existen se conservan y se pueden consultar y recibir.
6. **Conflictos del registro de proveedores:** dos administradores que editan el mismo proveedor a la vez se serializan (`FOR UPDATE`); **gana el último en guardar** (last-write-wins documentado, porque son datos de contacto y no stock, recetas ni pagos).
7. Sin commits: los cambios quedan en el árbol de trabajo para que el usuario los revise.

## Nodos

- **Central:** único escritor de `proveedor`. Cada alta o edición va en una transacción con su auditoría (`registro_actividad_central`, entidad `proveedor`: `PROVEEDOR_CREAR`, `PROVEEDOR_EDITAR`, `PROVEEDOR_ACTIVAR`, `PROVEEDOR_DESACTIVAR`) y un `PROVEEDOR_UPSERT` con la fila completa (NIT y contacto) hacia todas las tiendas.
- **Local:** `proveedor_ref` guarda la fila completa (columnas nuevas `nit`, `telefono`, `correo`, `direccion`). `pedido` y `detalle_pedido` guardan las solicitudes; `pedido.id_alerta` liga la que nace de una alerta; `fecha_envio` y `observaciones` (motivo de cancelación).

## Online

| Ruta | Permiso | Uso |
| --- | --- | --- |
| `GET /api/{local\|central}/proveedores?q=&incluir_inactivos=` | `PROVEEDOR_GESTIONAR` | Registro (en el POS: `detalle=1`, lee la réplica local; en la consola, el central) |
| `GET /api/{local\|central}/proveedores/{id}` | `PROVEEDOR_GESTIONAR` | Un proveedor |
| `POST /api/{local\|central}/proveedores` | `PROVEEDOR_GESTIONAR` + `Idempotency-Key` | Registrar (va al central) |
| `PATCH /api/{local\|central}/proveedores/{id}` | `PROVEEDOR_GESTIONAR` + `Idempotency-Key` | Editar los campos enviados, o `{ "activo": false }` (va al central) |
| `GET /api/local/solicitudes[?estado=&id_proveedor=]` | `PROVEEDOR_GESTIONAR` | Solicitudes con su estado y el resumen por estado (`PENDIENTE`, `ENVIADA`, `RECIBIDA`, `RECIBIDA_PARCIAL`, `CANCELADA`) |
| `GET /api/local/solicitudes/{id}` | `PROVEEDOR_GESTIONAR` | Una solicitud con sus líneas |
| `GET /api/local/solicitudes/medicamentos?q=` | `PROVEEDOR_GESTIONAR` | Búsqueda para una solicitud manual, con stock vendible y mínimo |
| `GET /api/local/alertas/{id}/solicitud` | `PROVEEDOR_GESTIONAR` | Lo que sale de la alerta: producto, stock, mínimo, cantidad y proveedor sugeridos |
| `POST /api/local/solicitudes` | `PROVEEDOR_GESTIONAR` + `Idempotency-Key` | Crear: `{ id_proveedor, lineas: [{ id_medicamento, cantidad }], observaciones }` (manual) o `{ id_proveedor, id_alerta, cantidad? }` (desde una alerta) |
| `POST /api/local/solicitudes/{id}/enviar` | `PROVEEDOR_GESTIONAR` + `Idempotency-Key` | Pendiente → enviada |
| `POST /api/local/solicitudes/{id}/cancelar` | `PROVEEDOR_GESTIONAR` + `Idempotency-Key` | Pendiente o enviada → cancelada, con `motivo` (5 a 300 caracteres) |

`GET /api/local/proveedores` **sin** `detalle` sigue siendo la lista de HU-02 (un arreglo con los proveedores activos, para el selector de "Lotes y recepción"); ahora la sirve `routes/proveedores.mjs`.

- Validación de proveedor: nombre 3–150 caracteres; NIT 5–40 (letras, números, punto o guion), único sin distinguir mayúsculas; teléfono, correo y dirección opcionales pero válidos si vienen. El permiso se relee en el central al escribir (la réplica del POS puede ir atrasada) y un rechazo también se audita.
- Validación de solicitud: proveedor obligatorio (`400 PROVEEDOR_OBLIGATORIO`), existente y activo (`409 PROVEEDOR_INACTIVO`); al menos una línea y hasta 50; cantidad entera de 1 a 100 000; un producto no se repite en la misma solicitud; el medicamento debe estar activo.

## Sin proveedor no hay solicitud (criterio 4)

Tres capas: la API responde `400 PROVEEDOR_OBLIGATORIO`; `pedido.id_proveedor` es `NOT NULL` con clave foránea a `proveedor_ref`; y el disparador `pedido_proveedor_activo_trg` rechaza un proveedor inexistente o inactivo aunque una escritura directa se salte la API (la prueba lo comprueba).

## Estados y transiciones (criterio 5)

```
SOLICITADO (pendiente) ──enviar──▶ ENVIADO ──recepción──▶ RECIBIDO_PARCIAL ──recepción──▶ RECIBIDO_TOTAL (recibida)
      │                              │
      └─cancelar──▶ CANCELADO ◀──cancelar
```

- La API valida con `FOR UPDATE` y responde `409 TRANSICION_INVALIDA` (enviar una enviada, cancelar una recibida). El disparador `pedido_transicion_estado_trg` lo garantiza en la base, también para dos usuarios simultáneos: una solicitud con mercancía recibida ya no se cancela ni retrocede.
- La recepción (HU-02/HU-14, `POST /api/local/pedidos/{id}/recepcion`) acepta pendiente, enviada o recibida en parte. Para HU-14 queda por hacer la pantalla específica de diferencias; el método `recibirPedido` ya existe.

## Offline y latencia

- **Solicitudes: totalmente locales.** Se generan, consultan, envían y cancelan sin conexión con el central; el nodo local sigue operando aunque no lo alcance (regla 1). El proveedor se toma de `proveedor_ref`, ya replicado.
- **Registro de proveedores: consultar sí, escribir no.** En el POS se lee `proveedor_ref` también offline. Registrar o editar desde el POS responde **503 `SIN_CONEXION`** con `ultima_sync`, sin encolar (el central es el único dueño del NIT único, igual que precios y cuentas). La consola, si no alcanza al central, también responde 503.
- Latencia alta no equivale a desconexión: se usa `enCentral`, que distingue el estado `offline` del circuito de un fallo a mitad de la operación (503, no 500).

## Reconexión, duplicados y conflictos

- **Reintentos:** todas las escrituras llevan `Idempotency-Key`. Misma clave y mismo cuerpo: misma respuesta, sin segundo proveedor ni segunda solicitud ni segundo evento. Misma clave con otro cuerpo: 409.
- **Dos administradores sobre la misma alerta:** un índice único parcial (`uq_pedido_alerta_abierta`) deja nacer una sola solicitud abierta por alerta; las demás reciben `409 SOLICITUD_DUPLICADA`. La prueba lanza cuatro a la vez. Cancelada la solicitud, la alerta puede generar otra.
- **NIT repetido:** comprobación previa y restricción única en la base (`409 NIT_DUPLICADO`); la prueba lanza cuatro altas simultáneas con el mismo NIT y gana una.
- **Réplica:** `PROVEEDOR_UPSERT` es idempotente por `id_proveedor` y se aplica en orden del log; la última versión gana. Los eventos anteriores a HU-13 no traían NIT ni contacto: el manejador conserva lo que la tienda ya tenga cuando el evento no los trae, y al arrancar `migrate()` vuelve a publicar una sola vez los proveedores cuyo último evento está incompleto.
- **Estado final comparable:** el proveedor es el mismo en el central y en la tienda tras la sincronización (la prueba compara NIT, teléfono y dirección); las solicitudes solo existen en la tienda que las generó, con su auditoría (`SOLICITUD_CREAR`, `SOLICITUD_ENVIAR`, `SOLICITUD_CANCELAR`) en `registro_actividad`, que ya sube al central (HU-07).

## Implementación

| Pieza | Archivo |
| --- | --- |
| Registro de proveedores (central + lectura local) | `apps/api/proveedores.mjs`, rutas en `apps/api/routes/proveedores.mjs` |
| Solicitudes y estados | `apps/api/solicitudes.mjs`, rutas en `apps/api/routes/solicitudes.mjs`, ambas registradas en `apps/api/app.mjs` |
| Réplica en la tienda | `PROVEEDOR_UPSERT` en `apps/api/sync/handlers/catalogo.mjs` (fila completa) |
| Publicación de los proveedores existentes | `CATALOGO` y `emitirProveedoresSinContacto` en `apps/api/migrate.mjs` |
| Módulo en el catálogo | `PROVEEDOR_GESTIONAR` en `apps/api/auth.mjs` |
| Esquema | `db/central/13_hu13_permiso_proveedores.sql` (permiso y roles, replicado con `PERMISO_UPSERT` y `ROL_PERMISO_SET`), `db/local/11_hu13_solicitudes.sql` |
| Interfaz | `apps/web/src/Abastecimiento.jsx` (módulo), `Proveedores.jsx`, `Solicitudes.jsx` (incluye `SolicitudDeAlerta`), `abastecimientoUi.jsx`; botón "Generar solicitud" en `Alertas.jsx` |
| Pruebas | `scripts/probar-hu13.mjs` (`npm run test:hu13`) |

Cambios en código existente: la recepción de HU-02 (`inventario/lotes.mjs`) y el listado de pedidos por recibir aceptan el estado `ENVIADO`; `routes/lotes.mjs` ya no define `GET /api/local/proveedores` (pasó a `routes/proveedores.mjs` con el mismo resultado para `INVENTARIO_GESTIONAR`); `Lotes.jsx` muestra "Enviado"; `hu06-pruebas.mjs` incluye el permiso nuevo en la lista exacta del administrador de tienda.

## Validación de esquema

| Dato | Definición | Uso |
| --- | --- | --- |
| Proveedor (central) | `proveedor`: `nombre_empresa varchar(150)`, `nit varchar(40) UNIQUE`, `telefono varchar(30)`, `correo varchar(120)`, `direccion varchar(200)`, `activo boolean` (script base) | Dueño del registro |
| Réplica | `proveedor_ref` (local) con `nit`, `telefono`, `correo`, `direccion` nuevos y nulos para filas anteriores | Consulta y solicitudes offline |
| Solicitud | `pedido`: `id_proveedor NOT NULL` (FK), `id_empleado_solicitante`, `origen_solicitud IN ('ALERTA_AUTOMATICA','MANUAL')`, `estado`, `fecha_solicitud`, `fecha_recepcion` (script base) + `id_alerta bigint`, `fecha_envio`, `observaciones varchar(300)` | Solicitud |
| Líneas | `detalle_pedido (id_pedido, id_medicamento)` PK, `cantidad_solicitada > 0`, `cantidad_recibida >= 0` (script base) | Productos y cantidades |
| Estados | `pedido_estado_check` ahora incluye `ENVIADO`; `pedido_transicion_estado_trg` | Transiciones válidas |
| Origen/alerta | `pedido_alerta_origen_check`: origen `ALERTA_AUTOMATICA` si y solo si hay `id_alerta` (NOT VALID: no revisa filas antiguas) | Coherencia |
| Una por alerta | `uq_pedido_alerta_abierta (id_alerta)` parcial sobre estados abiertos | Sin duplicados |
| Proveedor activo | `pedido_proveedor_activo_trg` (BEFORE INSERT) | Sin proveedor inactivo |

Las tablas de proveedor y pedido ya estaban en los scripts base (`db/central/00_base.sql`, `db/local/00_base.sql`); `docs/database/*.sql` sigue siendo la referencia de los scripts base y no se modificó.

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-13 Gestionar proveedores y generar solicitudes de reabastecimiento

  Escenario: El administrador registra, edita y consulta proveedores
    Dado que "admin.tienda" tiene sesión en el POS y el central está en línea
    Cuando registra al proveedor "Distribuidora X" con NIT "900123456-7"
    Entonces la respuesta es 201 y queda PROVEEDOR_CREAR en la auditoría del central
    Y la tienda lo recibe con su NIT y su contacto en la siguiente sincronización
    Cuando el administrador general edita su teléfono desde la consola
    Entonces la tienda lo ve actualizado tras sincronizar
    Y el NIT no puede repetirse (409 NIT_DUPLICADO, aunque cambie la mayúscula)

  Escenario: Solicitud desde una alerta sin reingresar el producto
    Dado una alerta STOCK_BAJO de "Ibuprofeno 400 mg" con 3 unidades y mínimo 10
    Cuando el administrador abre "Generar solicitud" desde la alerta
    Entonces ve el producto, el stock, el mínimo y una cantidad sugerida de 17
    Y el proveedor del último lote preseleccionado
    Cuando confirma la solicitud
    Entonces nace PENDIENTE, con origen ALERTA_AUTOMATICA, ligada a la alerta y con el producto y la cantidad

  Escenario: Una alerta no genera dos solicitudes abiertas
    Dado una alerta con una solicitud pendiente
    Cuando otro administrador genera una solicitud desde la misma alerta
    Entonces recibe 409 SOLICITUD_DUPLICADA y no se crea una segunda
    Y cuatro peticiones simultáneas producen una sola solicitud

  Escenario: Solicitud manual sin alerta activa
    Dado que no hay alertas activas para "Amoxicilina 500 mg"
    Cuando el administrador genera una solicitud con el proveedor y 40 unidades
    Entonces nace PENDIENTE con origen MANUAL
    Y repetir la misma petición con la misma clave devuelve la misma solicitud

  Escenario: No se genera una solicitud sin proveedor
    Cuando el administrador intenta generar una solicitud sin proveedor, manual o desde una alerta
    Entonces recibe 400 PROVEEDOR_OBLIGATORIO y no se guarda nada
    Y un proveedor inactivo recibe 409 PROVEEDOR_INACTIVO
    Y la base rechaza un pedido sin proveedor o con uno inactivo

  Escenario: El administrador consulta el estado de la solicitud
    Dado una solicitud pendiente
    Cuando la marca como enviada
    Entonces su estado es ENVIADA con la fecha de envío
    Y enviarla otra vez da 409 TRANSICION_INVALIDA
    Cuando se recibe toda la mercancía en "Lotes y recepción"
    Entonces su estado es RECIBIDA con la fecha de recepción y las cantidades recibidas
    Pero ya no se puede cancelar ni retroceder, ni desde la API ni desde la base

  Escenario: Cancelar exige un motivo
    Dado una solicitud pendiente o enviada
    Cuando la cancela sin motivo
    Entonces recibe 400
    Cuando la cancela con el motivo "cantidad equivocada"
    Entonces queda CANCELADA con su motivo y SOLICITUD_CANCELAR en la auditoría de la tienda

  Escenario: Solo los administradores gestionan proveedores y solicitudes
    Dado que "cajero1" tiene sesión en el POS
    Cuando intenta ver el registro, registrar un proveedor o generar una solicitud
    Entonces recibe 403 y queda ACCESO_DENEGADO en la auditoría de la tienda

  Escenario: La tienda sigue solicitando sin conexión con el central
    Dado que el estado real del POS es offline
    Cuando el administrador genera, consulta y marca como enviada una solicitud
    Entonces todo funciona con los proveedores ya replicados
    Pero registrar o editar un proveedor responde 503 SIN_CONEXION y no guarda nada
    Y al volver la red las solicitudes locales no cambian
```

## Pruebas

`npm run test:hu13` (`scripts/probar-hu13.mjs`, casos por las rutas reales de `app.mjs` y por SQL). Escribe en las bases del `.env`; con Neon exige `PERMITIR_NEON=1`. Correr con el API detenido y **una sola corrida a la vez**. Cada corrida crea sus proveedores y su medicamento y los deja inactivos al final; las solicitudes de prueba quedan en `pedido` (la auditoría no se borra).

Resultado (2026-11-09, rama de Neon `Sprint3_Simon_HU`): `test:hu13` 94/94, repetida dos veces seguidas sin diferencias. Regresión: `test:hu01` 39/39, `test:hu02`, `test:hu03`, `test:hu04` 64/64, `test:hu06` 38/38 (con el permiso nuevo en la lista exacta del administrador de tienda) y `test:sync` 12/12 (con el API levantado, como exige esa prueba), todas "TODO OK"; `db:verificar --estricto` sin diferencias en central ni en local. La interfaz compila (`vite build`).

Recorrido en el navegador como `admin.tienda`: el módulo "Proveedores" aparece en el menú; la pestaña Solicitudes muestra el estado de cada una (pendiente, enviada, recibida, cancelada con su motivo) y los contadores por estado; la pestaña Proveedores lista el registro con NIT y contacto y las solicitudes abiertas; desde Inventario > Alertas cada alerta de stock trae "Generar solicitud", que muestra el producto, el stock, el mínimo y la cantidad sugerida, y sin proveedor responde "La solicitud necesita un proveedor". No se recorrió la consola de red (`admin.general`) en el navegador: sus rutas sí están cubiertas por la prueba. No se repitió el recorrido en un celular.

Nota: las primeras corridas de prueba dejaron proveedores activos en la tienda y solicitudes pendientes en la rama; se limpiaron a mano y la prueba ahora desactiva sus proveedores en las dos bases y cancela sus solicitudes abiertas al terminar.

## Pendiente para otras historias

- **HU-14 (recepción):** la pantalla de recepción con diferencias de cantidad; la lógica base ya existe en `recibirPedido` (HU-02) y reconoce el estado `ENVIADO`.
- **Notificación al proveedor** (correo o integración): hoy "enviada" es un estado que el administrador marca a mano; el envío real queda fuera de alcance.
- **Catálogo de proveedores por medicamento** (`medicamento_proveedor` del central, con precio y tiempo de entrega): no se replica ni se usa todavía; el proveedor sugerido sale del historial de lotes de la tienda.
- **Vista de solicitudes de toda la red en el central** (consolidado): fuera de alcance; las solicitudes son de cada tienda.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Propuesta (Grok 4.7) | Esta propuesta: decisiones, nodos, offline y conflictos. **Pendiente de revisión por el usuario** |
| Auditor GPT-5.6 Luna | pendiente (sin `APROBADO` la historia no está lista para el backlog según `AGENTS.md`) |
| Subagentes técnicos | `analista-contexto`, `redactor-criterios` y `disenador-flujos`: pendientes; el Gherkin de arriba es provisional |
| Implementación y pruebas | Ver "Pruebas" (2026-11-09) |

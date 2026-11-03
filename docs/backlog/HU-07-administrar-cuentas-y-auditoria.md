# HU-07 — Administrar cuentas de empleados y trazabilidad de auditoría

Estado: **IMPLEMENTADA** (2026-11-03): API, esquema en `db/central/04_hu07_cuentas.sql` y `db/local/03_hu07_auditoria.sql`, pantallas "Empleados" y "Auditoría" (POS y consola) y "Restablecer contraseña" en el login. Pruebas en verde (ver "Pruebas"). Pendiente el veredicto del auditor.

Jira: **SDGFCSDF-7** · Sprint 1. Requerimientos: **RF-05** (empleados y auditoría), **RNF-01**, **RNF-02**, **RNF-10**, **RNF-11**.

## Historia

Como administrador, quiero crear, editar y dar de baja cuentas de empleados, habilitar el restablecimiento seguro de contraseñas, y consultar un registro de auditoría de las acciones críticas, para controlar al personal y cumplir con los requisitos de trazabilidad.

## Criterios de aceptación

1. Un administrador puede crear, editar y desactivar cuentas de empleados.
2. El sistema ofrece un mecanismo seguro de restablecimiento de contraseña.
3. Toda acción crítica (ventas, ajustes de inventario, anulaciones, inicios de sesión) queda registrada con fecha, hora y usuario responsable, en un registro no editable por usuarios finales.
4. El registro de auditoría se conserva por un mínimo de dos años y puede consultarse y filtrarse por usuario, fecha o tipo de acción.
5. Un administrador de tienda no puede crear ni modificar cuentas con rol de administrador general (restricción jerárquica de permisos).

## Trazabilidad

| Fuente | Cobertura |
| --- | --- |
| RF-05 | Alta, edición, desactivación y reactivación; restablecimiento; consulta de auditoría |
| RNF-01 | Permiso releído en cada request; el actor se revalida en el central; 403 auditado en el nodo que lo rechaza |
| RNF-02 | Contraseñas en scrypt; códigos solo como HMAC; el admin nunca ve ni fija contraseñas |
| RNF-10 | Triggers que impiden `UPDATE`/`DELETE`/`TRUNCATE` en la auditoría; borrado solo pasados 2 años |
| RNF-11 | `AUDITORIA_CONSULTAR` es un insert de datos, replicado con `PERMISO_UPSERT`/`ROL_PERMISO_SET` |
| RNF-04 | Vender, consultar e iniciar sesión siguen offline; la auditoría local se consulta offline |

## Nodos

- **Central:** único dueño de `empleado` (HU-06). Toda escritura de cuentas ocurre aquí, en una transacción con su auditoría (`registro_actividad_central`) y el `EMPLEADO_UPSERT` hacia la tienda de la cuenta (y hacia la anterior si cambió). Guarda `auditoria_tienda`, la copia de la auditoría de cada tienda.
- **Local:** aplica `EMPLEADO_UPSERT`/`SESION_REVOCAR` con los handlers de HU-06 (sin cambios). Registra su auditoría en `registro_actividad` y la sube al central en cada ciclo.

## Online

- Rutas iguales en los dos nodos: `GET/POST /api/{local|central}/empleados`, `PATCH /empleados/{id}`, `POST /empleados/{id}/desactivar|reactivar|codigo`, `POST /api/{local|central}/auth/restablecer`.
- Auditoría: `GET /api/local/auditoria` (tienda; `origen=cuentas` para las acciones del central sobre cuentas de esa tienda) y `GET /api/central/auditoria` (toda la red; `tienda=central|<id>`). Filtros: `usuario` (usuario o nombre), `accion`, `desde`, `hasta` (instantes ISO; la UI convierte el día local), `pagina` (50 por página).
- Escrituras con `Idempotency-Key` UUID (`conIdempotencia`, tabla `auth_operacion` del central).
- Edición y cambios de estado exigen `version_cuenta`: versión distinta, 409 `CONFLICTO`, cero escrituras.
- El `usuario` no se puede cambiar (el login y el índice único de la tienda dependen de él).

## Restricción jerárquica (criterio 5)

Se valida en el servidor contra los datos del **central** (no contra la réplica del POS):

- El admin de tienda solo gestiona cuentas de **su** tienda y con rol cajero o administrador de tienda. No puede crear, editar, desactivar ni generar códigos para un admin general, ni asignar ese rol, ni mover cuentas a otra tienda (si envía `id_tienda`, se ignora y queda la suya).
- Nadie puede desactivarse a sí mismo ni cambiar su propio rol o tienda.
- No se puede dejar la red sin un admin general activo (`ULTIMO_GENERAL`, con `FOR UPDATE` sobre los admins generales).
- Cada rechazo responde 403 `JERARQUIA` y queda `ACCESO_DENEGADO` en `registro_actividad_central`. La interfaz ya no ofrece esas acciones, pero ocultarlas no autoriza.

## Restablecimiento seguro (criterio 2)

- El administrador genera un **código de un solo uso** (`XXXX-XXXX`, sin caracteres ambiguos). Vence a los 30 minutos (24 h si es el de activación de una cuenta nueva) y se muestra una sola vez. Se guarda solo su HMAC con `AUTH_PEPPER`; ni siquiera la respuesta idempotente lo conserva.
- Generar un código anula el anterior. Cinco intentos fallidos lo dejan `BLOQUEADO`.
- El empleado lo canjea sin sesión en "Restablecer contraseña": usuario, código y contraseña nueva (8 a 128 caracteres, letras y números, sin contener el usuario).
- Al canjear: hash nuevo, `version_credencial + 1` (un login hecho con la contraseña anterior no se reaplica, regla de HU-06), sesiones revocadas en el central y en la tienda (`SESION_REVOCAR`) y `CONTRASENA_RESTABLECIDA` en auditoría.
- Usuario inexistente, código malo, vencido o usado: el mismo error `CODIGO_INVALIDO` (no revela qué cuentas existen).
- **Alta de cuenta:** nace con una contraseña aleatoria que nadie conoce y un código de activación. El administrador nunca elige ni ve la contraseña.

## Auditoría (criterios 3 y 4)

- **No editable:** el trigger `auditoria_inmutable()` rechaza `UPDATE`, `TRUNCATE` y todo `DELETE` de filas con menos de 2 años en `registro_actividad` (local), `registro_actividad_central` y `auditoria_tienda` (central). No hay excepción de mantenimiento: cualquiera podría activarla.
- **Retención:** nada se borra antes de 2 años; pasado ese plazo el borrado está permitido pero ningún proceso lo hace.
- **Qué se registra hoy:** `INICIO_SESION`, `INTENTO_FALLIDO`, `CUENTA_BLOQUEADA`, `ACCESO_DENEGADO` (HU-06); `LOTE_REGISTRAR`, `LOTE_AJUSTAR`, `PEDIDO_RECIBIR` (HU-02); `TIENDA_*`, `UMBRAL_CONFIGURAR` (HU-15); `EMPLEADO_CREAR`, `EMPLEADO_EDITAR`, `EMPLEADO_DESACTIVAR`, `EMPLEADO_REACTIVAR`, `CONTRASENA_CODIGO_GENERADO`, `CONTRASENA_RESTABLECIDA`, `CONTRASENA_RESTABLECER_FALLIDO` (esta historia). Ventas (HU-08) y anulaciones (HU-10) aún no existen: solo tienen que escribir en `registro_actividad` con el mismo formato y aparecen en la consulta sin cambios.
- **Subida al central:** en cada ciclo de sincronización la tienda copia su auditoría nueva a `auditoria_tienda` en un solo insert por lote (500 filas), idempotente por `(id_tienda, id_registro)`. El cursor (`auditoria_cursor`) solo avanza sobre filas de más de 2 minutos: una fila con id menor de una transacción aún abierta no se salta; las recientes se reenvían y el central las descarta.

## Offline y latencia

- Cuentas y restablecimiento desde el POS: **503 `SIN_CONEXION`** con `estado_real` y `ultima_sync`, sin encolar (la unicidad del usuario y la jerarquía solo se garantizan en el central). Una caída del central a mitad de la operación también responde 503.
- Auditoría de la tienda: funciona offline (base local). La de cuentas y la de red exigen el central.
- La subida de auditoría falla sin frenar la réplica; se reintenta en el siguiente ciclo.

## Reconexión, duplicados y conflictos

- Misma clave y mismo cuerpo: misma respuesta, sin segunda cuenta ni segundo evento (el código de activación no se vuelve a mostrar). Clave con otro cuerpo: 409.
- Usuario repetido (también en carrera, por `empleado_usuario_key`): 409 `USUARIO_EXISTE`.
- Edición concurrente: 409 por `version_cuenta`. Hash, rol, activo y tienda: gana el central (HU-06).
- La tienda aplica `EMPLEADO_UPSERT` en orden del log; un evento con `version_credencial` menor que la local no pisa un hash nuevo y queda en `sync_conflicto`.

## Implementación

| Pieza | Archivo |
| --- | --- |
| Cuentas, jerarquía, códigos y restablecimiento | `apps/api/empleados.mjs` |
| Consulta de auditoría y subida al central | `apps/api/auditoria.mjs` (subida llamada desde el ciclo de `server.mjs`) |
| Rutas | `apps/api/routes/empleados.mjs`, registradas en `apps/api/app.mjs` |
| Esquema | `db/central/04_hu07_cuentas.sql`, `db/local/03_hu07_auditoria.sql` |
| Interfaz | `apps/web/src/Empleados.jsx`, `apps/web/src/Auditoria.jsx`, `Restablecer` en `App.jsx` |

Cambios en código existente: `migrate.mjs` (la cuarentena de usuarios duplicados de HU-06 ya no borra auditoría: desactiva y renombra la fila), `scripts/probar-hu06.mjs` (usuario de prueba único por corrida, desactivado al final en vez de borrado), módulo `AUDITORIA_CONSULTAR` en `auth.mjs` y menú en `App.jsx`.

## Validación de esquema

| Dato | Definición | Uso |
| --- | --- | --- |
| Cuenta | `empleado` (usuario único, `contrasena_hash`, `activo`, `fecha_baja`, `version_credencial`) | Autoridad del central |
| Versión de cuenta | `empleado.version_cuenta bigint NOT NULL DEFAULT 1` | Control optimista |
| Código | `codigo_restablecimiento` (HMAC, estado, intentos, `expira_en`) | Restablecimiento |
| Auditoría local | `registro_actividad` (`id_empleado NOT NULL`, FK a `empleado_ref`) | Consulta offline |
| Auditoría central | `registro_actividad_central` (`id_empleado` nullable) | Cuentas, tiendas, consola |
| Auditoría subida | `auditoria_tienda` PK `(id_tienda, id_registro)`, sin FK | Vista de red |
| Cursor de subida | `auditoria_cursor` (local) | Reanudar la subida |

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-07 Administrar cuentas de empleados y auditoría

  Escenario: El admin de tienda crea una cuenta y el empleado la activa
    Dado que "admin.tienda" tiene sesión en el POS y el central está en línea
    Cuando crea la cuenta "maria.lopez" con rol cajero
    Entonces la respuesta es 201 con un código de activación que vence en 24 horas
    Y la cuenta queda en su tienda aunque haya enviado otra
    Y queda EMPLEADO_CREAR en la auditoría del central
    Cuando la tienda sincroniza
    Entonces "maria.lopez" existe en empleado_ref
    Cuando "maria.lopez" canjea el código y elige su contraseña
    Entonces puede iniciar sesión en el POS con esa contraseña

  Escenario: Reintento idempotente
    Dado que la clave "k-1" ya creó la cuenta "maria.lopez"
    Cuando se reintenta con la misma clave y el mismo cuerpo
    Entonces vuelve la misma cuenta sin volver a mostrar el código
    Cuando se reutiliza "k-1" con otro cuerpo
    Entonces la respuesta es 409 y no hay escrituras

  Escenario: Restricción jerárquica
    Dado que "admin.tienda" es administrador de tienda
    Cuando intenta crear una cuenta con rol administrador general
    O editar, desactivar o generar un código para "admin.general"
    O desactivar una cuenta de otra tienda
    Entonces recibe 403 JERARQUIA
    Y no hay mutación
    Y queda ACCESO_DENEGADO en la auditoría del central

  Escenario: Restablecimiento con código de un solo uso
    Dado que el admin generó un código para "maria.lopez"
    Cuando ella lo canjea con una contraseña válida
    Entonces su version_credencial sube en 1
    Y se revocan sus sesiones en el central y en la tienda
    Cuando lo intenta canjear de nuevo
    Entonces recibe CODIGO_INVALIDO
    Y tras 5 códigos incorrectos el código queda BLOQUEADO

  Escenario: Desactivación
    Dado que "maria.lopez" tiene sesión en el POS
    Cuando el admin desactiva su cuenta y la tienda sincroniza
    Entonces su sesión queda revocada y no puede volver a entrar
    Y su historial de auditoría se conserva

  Escenario: Sin conexión con el central
    Dado que el estado real del POS es offline
    Cuando el admin intenta crear una cuenta o un empleado restablecer su contraseña
    Entonces recibe 503 SIN_CONEXION con la hora de la última sync
    Y no se crea nada ni se encola
    Y la auditoría de la tienda sigue consultándose

  Escenario: La auditoría no se puede alterar
    Dado registros de auditoría en la tienda y en el central
    Cuando cualquier usuario de la base intenta UPDATE, DELETE o TRUNCATE
    Entonces la base lo rechaza con error 42501

  Escenario: Consulta filtrada y vista de red
    Dado que la tienda subió su auditoría en el ciclo de sincronización
    Cuando el admin general filtra por acción INICIO_SESION y la tienda "Farmacia Centro"
    Entonces ve los inicios de sesión de esa tienda con fecha, hora y usuario
    Y reenviar la subida no duplica registros
```

## Pruebas

`npm run test:hu07` (`scripts/probar-hu07.mjs`, 63 casos por las rutas reales de `app.mjs`). Escribe en las bases del `.env`; con Neon exige `PERMITIR_NEON=1`. Correr con el API detenido. Las cuentas de prueba quedan desactivadas (no se borran).

Resultado (2026-11-03, ramas de prueba de Neon): `test:hu07` 63/63. Regresión: `test:hu06` 37/37, `test:hu01` 39/39, `test:hu02` 38/38, `test:hu15` 19/19 y 28/28, `test:sync` 12/12 (con API) y `db:verificar --estricto` sin diferencias. HU-06 y HU-07 se corrieron dos veces seguidas en verde. Recorrido en el navegador: alta desde el POS, activación con el código, login del empleado nuevo, auditoría consolidada en la consola (alta, restablecimiento y login de la tienda en orden) y Empleados a 375 px sin desplazamiento horizontal.

## Decisiones

1. **Código de un solo uso** en lugar de contraseña temporal: no toca el login de HU-06 (que funciona offline) y el admin nunca conoce contraseñas.
2. **503 sin conexión, sin cola**: un alta encolada podría fallar al reconectar (usuario repetido) cuando el empleado ya la creía hecha.
3. **Sin excepción de mantenimiento en los triggers.** Las pruebas desactivan sus cuentas en lugar de borrarlas.
4. El restablecimiento no desbloquea una cuenta bloqueada por intentos (HU-06): el bloqueo de 15 minutos sigue su curso.
5. `ULTIMO_GENERAL` es defensa en profundidad: con las reglas de "no a sí mismo" no es alcanzable por la API, pero protege ante cambios futuros.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Plan y decisiones con el usuario | Código de un solo uso, 503 sin cola, rama `hu-07` sin commits |
| Implementación y pruebas | 63/63 y regresión en verde (2026-11-03) |
| Auditor GPT-5.6 Luna | pendiente |

# HU-06 — Autenticarse y operar según el rol asignado

Estado: lógica `APROBADO` por `co-orquestador-auditor` (2026-10-15).

`analista-contexto` no pudo iniciar (modelo `open-code/muse-spark-1.3-free` no disponible). La contraste de campos se hizo leyendo `Script_BDFarmacias_nodo_central.sql`, `Script_BDFarmacias_nodo_farmacia.sql`, `db/hu06_central.sql` y `db/hu06_local.sql`.

El corte de código en `apps/api` no está alineado con esta lógica. No se toma como cumplimiento de la historia hasta aplicar las correcciones de abajo.

Frontend previsto: React. Ocultar un módulo no autoriza. El API del nodo relee el permiso en cada request.

## Historia

Como empleado, quiero iniciar sesión con usuario y contraseña y que el sistema me asigne automáticamente a mi tienda y a mi rol, para que solo pueda ver y ejecutar las acciones que me corresponden.

## Criterios de aceptación

1. El sistema exige autenticación con usuario y contraseña antes de permitir el acceso a cualquier funcionalidad.
2. Al iniciar sesión, el sistema asocia automáticamente al empleado con la tienda a la que pertenece.
3. Un cajero solo puede consultar inventario y registrar ventas; un administrador de tienda además gestiona empleados, precios y cierre de caja; un administrador general tiene visibilidad y control sobre toda la red.
4. Un intento de acceder a una función no permitida por el rol es rechazado por el sistema.
5. Tras 5 intentos fallidos de inicio de sesión en la época vigente, la cuenta queda bloqueada 15 minutos. Esos valores viven solo en `politica_acceso` (`intentos_maximos`, `minutos_bloqueo`): cambiar la política es un update de esa fila, no un cambio de código. El plazo se calcula con `now()` de la base.

## Trazabilidad

| Fuente | Cobertura |
| --- | --- |
| RF-12 / RF-05 | Login, tienda automática, roles |
| RNF-01 | Sin sesión no hay módulo; el acceso fuera de rol se rechaza y se registra |
| RNF-02 | La contraseña no queda en claro ni vuelve al cliente |
| RNF-04 | Cajero y admin de tienda entran en local aunque el central no responda |
| RNF-07 | Mensajes distintos para bloqueo, offline y credencial pendiente |
| RNF-10 | Login, fallo, bloqueo y acceso denegado quedan en auditoría |
| RNF-11 | Un rol nuevo es un insert, no un cambio de esquema |
| RNF-13 | La red puede ir atrasada; se muestra la hora de la última sync |

Fuera de alcance: alta de empleados, reset de contraseña, venta, cierre de caja y datos consolidados. Esta historia solo abre o cierra el módulo.

## Roles reales

No se renombran los roles ya sembrados.

| Rol en `rol.nombre` | Códigos |
| --- | --- |
| cajero | INVENTARIO_CONSULTAR, VENTA_REGISTRAR |
| administrador_tienda | los del cajero + EMPLEADO_GESTIONAR, PRECIO_GESTIONAR, CAJA_CERRAR, FACTURA_ANULAR |
| administrador_general | los del admin de tienda + RED_VISIBILIDAD, RED_CONTROL, TIENDA_GESTIONAR, REPORTE_CONSOLIDADO_VER |

El chequeo es por `permiso.codigo`. Esos códigos caben en `varchar(60)`. Los nombres caben en `varchar(40)`.

POS React llama al API local y muestra solo módulos de tienda. Consola React llama al API central y muestra solo módulos de red. Sin `RED_VISIBILIDAD` o `RED_CONTROL` la consola no abre sesión.

## Nodos

- Local: login de mostrador, sesión local, bloqueo provisional, outbox.
- Central: autoridad de hash, rol, `activo`, `fecha_baja` y `version_credencial`. Único escritor del estado canónico de bloqueo. Publica el log de réplica.
- Toda cuenta tiene tienda hogar, incluido el admin general (`empleado.id_tienda` NOT NULL). El hash se replica solo a esa tienda.

## Online

1. `POST /api/local/auth/login` no espera al central. Asocia `empleado_ref.id_tienda`. Si no coincide con la tienda local, `CONFLICTO_REPLICA` y no hay sesión.
2. `POST /api/central/auth/login` exige permiso de red. Si el estado real es offline, 503 con hora de última sync. No muestra la red en cero.
3. Ni el login local ni el central mutan epoch ni contador. Solo insertan un evento con `idempotency_key` y `version_credencial_observada`.
4. El único pliegue es `fold_evento` en el central, idempotente por `(id_tienda_origen, idempotency_key)`.
5. Cada request protegido relee sesión de este nodo, no revocada, no expirada, empleado activo y código de permiso. 401 o 403 antes de mutar.

## Offline y latencia

- Con el central caído, el login local sigue si el hash ya está y el bloqueo provisional no venció.
- Módulos de red fallan cerrados: sin conexión y hora de última sync. No se encolan como éxito.
- Probe real cada 10 s, timeout 3 s. El login local no lo espera.
- Respuesta real mayor a 3 s: `degradado`, breaker cerrado.
- Cinco timeouts reales: `offline`, breaker abierto 30 s.
- `forzado` es un campo aparte de demostración. No pisa `estado_real`. La UI muestra los dos.
- El quinto fallo provisional hace, en la misma transacción SQL, `bloqueado_hasta = now() + interval '15 minutes'` y `provisional = true`. No se usa reloj de JavaScript. La expiración compara contra `now()` de esa base.

## Reconexión, duplicados y conflictos

- El local reenvía el outbox en orden por empleado. Espera `min(60s, 2^(intentos-1))`, tope 20. Luego `ERROR` visible, sin borrar. Frena solo lo posterior de ese empleado. Un ciclo posterior puede reanudar la fila.
- Misma clave y mismo HMAC: misma respuesta, sin segunda sesión ni segundo incremento. HMAC distinto: 409, cero escrituras.
- Cursor global: se lee `id_evento > cursor` sin filtrar destino. Si falta `cursor+1`, se detiene. Un evento de otra tienda se omite y el cursor avanza.
- `id_snapshot` sale de `nextval('control_acceso_snapshot_seq')` bajo `SELECT … FOR UPDATE` de ese empleado. No hay `MAX+1`.
- Snapshot con `id_snapshot` menor o igual al ya aplicado se ignora y no re-bloquea.
- El snapshot lleva la `version_credencial` vigente del central al publicarlo, no la versión observada del evento rechazado.
- El local aplica snapshot y `SESION_REVOCAR` en la misma transacción si `id_snapshot` es mayor y `snapshot.version_credencial >= version local`. Si la versión local es estrictamente mayor, no aplica y deja el conflicto visible.
- Un evento con versión observada menor no entra al fold ni resetea. En esa transacción el central audita `CREDENCIAL_OBSOLETA` y publica el snapshot canónico.
- Hash, rol, activo y tienda: gana el central. Una versión menor no pisa un hash nuevo.
- El epoch local anterior al snapshot es provisional y se descarta al aplicarlo. No se suma al epoch canónico.
- Sync exitosa de ese empleado: outbox vacío y último snapshot aplicable ya aplicado. Solo entonces coinciden epoch, estado, contador, `bloqueado_hasta`, hash y versión.
- Cinco `FAIL` distintos de la época, aunque lleguen 3+2, producen un solo lock canónico. `SUCCESS` en `ACTIVO` o `EXPIRADO` cierran la época. Los fallos viejos no se reutilizan. `SUCCESS` con cuenta bloqueada no resetea.

## Migración de usuario único

Antes de `UNIQUE(usuario)` en `empleado_ref`:

1. Detectar duplicados.
2. Conservar la fila cuyo `id_empleado` coincide con el central.
3. Mover el resto a `empleado_ref_cuarentena`. No borrar en silencio.
4. Si el central no está o no hay par, abortar y no crear el índice.
5. Mientras `count(usuario) <> 1`, el login responde `CONFLICTO_REPLICA` y no elige fila.

## Validación de esquema

Encaje: ENCAJA con extensiones. Ningún tipo base contradice el login.

| Dato | Definición leída | Uso |
| --- | --- | --- |
| Tienda hogar | `empleado.id_tienda integer NOT NULL` | Asociación automática |
| Usuario central | `empleado.usuario varchar(60) NOT NULL` + `empleado_usuario_key` | Login central |
| Hash central | `contrasena_hash varchar(255) NOT NULL` | Nunca en claro |
| Hash local | `empleado_ref.contrasena_hash varchar(255)` nullable | NULL = aún no replicado |
| Usuario local | `empleado_ref.usuario varchar(60) NOT NULL`, sin UNIQUE en el script base | Hace falta la cuarentena antes del índice |
| Permisos offline | `rol_ref` no tiene permisos en el script base | `permiso_ref` y `rol_permiso_ref` son extensión |
| Auditoría local | `registro_actividad.id_empleado NOT NULL` | Usuario desconocido va a `intento_acceso` |
| Auditoría central | `registro_actividad_central.id_empleado` nullable | Puede registrar desconocido |

`db/hu06_central.sql` y `db/hu06_local.sql` ya agregan `version_credencial`, `control_acceso`, `bloqueo_canonico`, `intento_acceso`, `auth_operacion`, `sesion_activa`, `replica_evento`, `outbox_sync`, `inbox_sync` y `append_replica_evento`. Pendiente de alinear con esta lógica: secuencia de snapshot, cuarentena de usuarios y `empleado_ref.id_tienda` NOT NULL tras el backfill.

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-06 Autenticarse y operar según el rol asignado

  Escenario: Login local asocia tienda y rol sin llamar al central
    Dado que "cajero1" está activo en el nodo de su tienda, con hash replicado y rol cajero
    Cuando inicia sesión en el punto de venta
    Entonces la respuesta trae su id_tienda, el rol cajero y solo INVENTARIO_CONSULTAR y VENTA_REGISTRAR
    Y el nodo central no participó en la decisión

  Escenario: Pérdida de red no impide el login local
    Dado que el hash de "cajero1" ya está en el nodo local
    Y el probe al central acumuló 5 timeouts reales de 3 segundos
    Cuando inicia sesión en el punto de venta
    Entonces entra
    Y el intento queda en el outbox
    Y el timeout no borra ese evento

  Escenario: Latencia alta no es caída
    Dado que el central responde al probe en más de 3 segundos
    Cuando se consulta la conectividad
    Entonces estado_real es degradado y el circuit-breaker sigue cerrado
    Y forzado, si existe, se muestra aparte

  Escenario: Admin general offline no ve la red vacía
    Dado que el estado real es offline
    Cuando el admin general abre la consola de red
    Entonces recibe 503 con "sin conexión con el nodo central" y la hora de última sync
    Y no recibe totales en cero

  Escenario: Cajero no abre cierre de caja
    Dado que "cajero1" tiene sesión local válida
    Cuando solicita CAJA_CERRAR
    Entonces recibe 403
    Y no hay mutación
    Y queda ACCESO_DENEGADO

  Escenario: Admin de tienda no entra a la consola de red
    Dado que "admin.tienda" no tiene RED_VISIBILIDAD ni RED_CONTROL
    Cuando inicia sesión en la consola central
    Entonces no se abre sesión de red

  Escenario: Admin general online ve la red
    Dado que el central está alcanzable
    Y "admin.general" tiene RED_VISIBILIDAD y RED_CONTROL
    Cuando inicia sesión en la consola
    Entonces la sesión queda asociada a su tienda hogar
    Y puede abrir los módulos de red

  Escenario: Sin sesión no se muta
    Dado que no hay sesión válida
    Cuando se llama a un módulo
    Entonces la respuesta es 401
    Y no hay mutación

  Escenario: Quinto fallo bloquea y la época nueva no reusa los anteriores
    Dado que la cuenta está ACTIVA en la época 3 con 4 fallos distintos
    Cuando falla una quinta vez
    Entonces queda BLOQUEADA con bloqueado_hasta = now() del nodo más 15 minutos y provisional verdadero
    Cuando llega EXPIRADO de esa época
    Entonces la época canónica pasa a 4, el contador queda en 0 y los 5 fallos viejos no suman

  Escenario: Tres fallos locales y dos centrales producen un solo bloqueo
    Dado que la época tiene 3 FAIL del nodo local y 2 FAIL del central, sin SUCCESS posterior
    Cuando el central pliega el conjunto una sola vez por idempotency_key
    Entonces existe una sola fila de bloqueo canónico para ese empleado y esa época

  Escenario: Un evento de otra tienda no atasca el cursor
    Dado que el cursor local está en 4 y el evento 5 es de otra tienda
    Cuando el local sincroniza
    Entonces omite el evento 5 y avanza el cursor a 5

  Escenario: Snapshot viejo no re-bloquea
    Dado que el local ya aplicó el snapshot 8 en estado ACTIVO
    Cuando llega otra vez el snapshot 7 BLOQUEADO
    Entonces lo ignora y la cuenta sigue ACTIVA

  Escenario: Snapshot de resolución no se rechaza por la versión observada
    Dado que un SUCCESS local observó una versión vieja
    Y el central publicó un snapshot con la version_credencial vigente
    Cuando el local sincroniza
    Entonces aplica ese snapshot y revoca la sesión
    Y no compara contra la versión observada del evento rechazado

  Escenario: Reintento idempotente no duplica
    Dado que la clave "k-1" ya creó la sesión "s-1"
    Cuando se reintenta la misma clave y el mismo payload
    Entonces vuelve la misma sesión "s-1"
    Y no hay otra auditoría ni otro incremento
    Cuando se reutiliza "k-1" con otro payload
    Entonces la respuesta es 409 y no hay escrituras

  Escenario: Hash nulo y usuario desconocido
    Dado que el usuario existe en local y su hash es NULL
    Cuando intenta entrar
    Entonces ve "credenciales no disponibles en esta tienda"
    Dado que el usuario no existe en el nodo
    Cuando intenta entrar
    Entonces ve "credenciales inválidas"
    Y no se inserta en registro_actividad local

  Escenario: Usuario duplicado no elige fila
    Dado que empleado_ref tiene dos filas con el mismo usuario
    Cuando intenta entrar
    Entonces recibe CONFLICTO_REPLICA
    Y no se abre sesión

  Escenario: Tras sync exitosa los nodos coinciden
    Dado que el outbox de ese empleado está vacío
    Y el local aplicó el último snapshot cuya versión no es menor que la local
    Cuando se comparan local y central
    Entonces coinciden epoch, estado, contador, bloqueado_hasta, hash y version_credencial
```

## Ciclo

| Paso | Resultado |
| --- | --- |
| Auditor, diseño inicial | `APROBADO` |
| Auditor, corte de `apps/api` | `NO APROBADO`: cursor, doble fold, reloj JS, `MAX+1`, breaker simulado, SUCCESS obsoleto, UNIQUE sin cuarentena |
| Auditor, lógica corregida de este documento | `APROBADO` |
| `analista-contexto` | No inició. Validación directa contra los SQL citados |

# Despliegue en Render (plan gratuito)

Cada tienda (nodo local) se despliega como un servicio web de Render. El mismo proceso entrega la web compilada y el API,
así la web llama a `/api/...` en su propio dominio. Las dos tiendas comparten el nodo central en Neon.

| Servicio | Tienda | Base local (Neon) | Dirección |
|---|---|---|---|
| `farmahub-centro` | 1 · Farmacia Centro | variables `LOCAL_*` del `.env` | `https://farmahub-centro.onrender.com` |
| `farmahub-norte` | 2 · Farmacia Norte | variables `LOCAL_*_TIENDA2` del `.env` | `https://farmahub-norte.onrender.com` |

La consola de red (administrador general) entra por cualquiera de los dos servicios eligiendo "Consola de red".

## Cómo se comporta el plan gratuito

- El servicio se **duerme tras 15 minutos sin visitas** y despierta con la primera visita (alrededor de 1 minuto). Al despertar,
  el API aplica las migraciones pendientes, sincroniza con el central y envía la foto completa del stock. A los 2 minutos la tienda
  vuelve a verse "Al día" en la vista de red.
- **No se debe mantener despierto con "pings".** El plan gratuito de Neon da 100 horas de cómputo al mes por proyecto. Con el API
  encendido todo el tiempo, cada base las agotaría en unos 16 días y quedaría suspendida hasta el mes siguiente. Dormido, Neon también
  duerme y la cuota alcanza todo el mes.
- Render da 750 horas de instancia gratuitas al mes por cuenta, compartidas entre los servicios.

## Pasos

1. Crear una cuenta en <https://render.com> (gratis, no pide tarjeta) y conectar la cuenta de GitHub con acceso al repositorio.
2. **New → Blueprint** y elegir el repositorio. Render lee `render.yaml` y propone los dos servicios.
3. Escribir las variables secretas de cada servicio (Render las pide al crear el Blueprint; nunca van al repositorio):

   | Variable | `farmahub-centro` | `farmahub-norte` |
   |---|---|---|
   | `CENTRAL_DATABASE_URL_UNPOOLED` | `CENTRAL_DATABASE_URL_UNPOOLED` del `.env` | igual |
   | `CENTRAL_DATABASE_URL_UNPOOLED_APP` | `CENTRAL_DATABASE_URL_UNPOOLED_APP` del `.env` | igual |
   | `LOCAL_DATABASE_URL_UNPOOLED` | `LOCAL_DATABASE_URL_UNPOOLED` del `.env` | `LOCAL_DATABASE_URL_UNPOOLED_TIENDA2` del `.env` |
   | `LOCAL_DATABASE_URL_UNPOOLED_APP` | `LOCAL_DATABASE_URL_UNPOOLED_APP` del `.env` | `LOCAL_DATABASE_URL_UNPOOLED_TIENDA2_APP` del `.env` |
   | `DATOS_CLAVE` | `DATOS_CLAVE` del `.env` | **la misma** |
   | `CORS_ORIGIN` | `https://farmahub-centro.onrender.com` | `https://farmahub-norte.onrender.com` |

   Si Render asigna otro nombre de dominio (porque el nombre ya existe), use la dirección real en `CORS_ORIGIN`.
4. **Apply**. La primera compilación tarda unos minutos. El servicio está listo cuando el registro muestra
   `API FarmaHub en http://localhost:10000 (tienda N)`.
5. Abrir la dirección pública e iniciar sesión.

Cada `git push` a `main` vuelve a desplegar los dos servicios (`autoDeploy`).

## Variables fijas del Blueprint

- `FARMAHUB_SIMULACION=0`: sin la demostración de conectividad (docs/operacion/demostracion-conectividad.md). El panel no
  aparece y su API responde 404.
- `SEED_DEMO=0`: el despliegue no siembra datos de demostración.
- No se define `NODE_ENV=production`: ese modo exige un `AUTH_PEPPER` propio, y las contraseñas actuales se calcularon con el
  pepper de desarrollo, así que ninguna cuenta podría entrar. Para pasar a producción hay que definir `AUTH_PEPPER` y regenerar
  las contraseñas con códigos de restablecimiento (HU-07).

## Lo que cambió en el código para desplegar

- `apps/api/web-estatica.mjs`: entrega `apps/web/dist` (caché larga para `assets/`, `index.html` sin caché, nunca fuera de `dist`).
  En desarrollo no hay `dist` compilado relevante: la web la sirve Vite en el puerto 5173.
- `apps/api/config.mjs`: sin archivo `.env`, usa las variables del entorno.
- `apps/api/server.mjs`: cierra ordenadamente con `SIGTERM` (Render lo envía al redesplegar o dormir el servicio).
- `GET /api/conectividad` informa `simulacion` (si la demostración está habilitada) y `tienda` (id y nombre del nodo).

## Pruebas del despliegue

Se probó la rama en un clon limpio, sin `.env`, con los mismos comandos de `render.yaml` y contra un clon Docker de las bases:
compilación, arranque, entrega de la web, rutas fuera de `dist` bloqueadas, simulación deshabilitada, inicio de sesión y módulos
en Chrome y Edge (escritorio y celular), y las suites de interfaz sobre la web compilada.

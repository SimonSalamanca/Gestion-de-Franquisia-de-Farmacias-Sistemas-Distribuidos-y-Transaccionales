# Datos personales de clientes y pacientes: matriz de acceso

Aprobada por el administrador del proyecto. Cumple el requisito RNF-02 (datos de cliente solo para roles autorizados).

## Matriz

| Dato | Administrador general (consola) | Administrador de tienda (POS) | Cajero (POS) |
|---|---|---|---|
| Nombre del cliente o paciente | Sí | Sí | Sí |
| Documento de identidad | Completo | Completo | Enmascarado (`****1234`) |
| Teléfono | Sí | Sí | No |
| Correo | Sí | Sí | No |

El administrador de tienda y el administrador general tienen el mismo acceso a datos personales. El cajero ve lo necesario para atender la venta (el nombre y el documento enmascarado para ubicar la receta), pero no el contacto ni el documento completo.

## Dónde se aplica

- **API local:** `apps/api/historial.mjs` (clientes y facturas) y `apps/api/recetas.mjs` (recetas). La decisión sale de `veDatosPersonales(sesion)`: el permiso `AUDITORIA_CONSULTAR`, que tienen los administradores.
- **Consola de red:** `apps/api/recetas-red.mjs`. El documento de las recetas emitidas siempre sale enmascarado.
- **Central:** el documento de los pacientes se guarda cifrado (HMAC para buscar, AES-256-GCM para leer). Solo el central lo descifra, y únicamente para la copia de la tienda que dispensa la receta.
- **Tienda (tabla `cliente`):** igual que en el central. `documento_identidad` guarda solo el valor enmascarado; el valor real va en `documento_cifrado` (AES-256-GCM) y `documento_hmac` identifica al cliente para la unicidad y las búsquedas por documento (`db/local/15_datos_personales_cifrado.sql`). El documento completo se descifra únicamente al mostrarlo a quien tiene acceso (administradores) y queda auditado. Los documentos que ya existían se cifran al arrancar el nodo (`cifrarDocumentosCliente` en `apps/api/migrate.mjs`). Cada nodo necesita la misma `DATOS_CLAVE`; sin ella los documentos cifrados no se pueden recuperar.

## Auditoría

Cada vez que un administrador ve el documento completo de un cliente o paciente, queda un registro `CLIENTE_DATOS_CONSULTAR` en la auditoría de la tienda, con el usuario, la fecha y el alcance de la consulta. Lo registran hoy: la búsqueda de clientes, el historial de un cliente, la búsqueda de facturas por cliente y el detalle de una receta.

## Pruebas

`npm run test:datos-personales` recorre las salidas con datos personales como cajero y como administrador, y comprueba que el documento completo, el teléfono y el correo solo aparecen cuando corresponde.

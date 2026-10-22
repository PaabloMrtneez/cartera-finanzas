# Workflows del repositorio privado

Estos workflows se ejecutan en el repositorio privado de Cartera, que es el que
tiene los secretos (base de datos, Supabase, VAPID) y el despliegue. Se incluyen
aquí para que se vea cómo está montado, en una carpeta que GitHub no ejecuta.

| Workflow | Qué hace |
|---|---|
| `e2e.yml` | Pruebas de Playwright contra una build de producción, con un usuario de CI dedicado |
| `backup.yml` | Volcado semanal de la base, cifrado con GPG y comprobado antes de guardarse |
| `notificar.yml` | Tarea programada de avisos push y cuotas de préstamos |
| `precios.yml` | Actualización de cotizaciones (Yahoo Finance) y tipos de cambio (BCE) |
| `keepalive.yml` | Mantiene activo el proyecto gratuito de Supabase |
| `escritorio.yml` | Compila el instalador de Windows y lo publica como release |

En este repositorio solo corre `../workflows/ci.yml`: lint, tipos, pruebas
unitarias, build y los escáneres de secretos sobre el paquete del cliente.

# Pruebas de extremo a extremo

Playwright contra la app de verdad y el Supabase de verdad, con el acceso real
(contraseña y segundo factor). Solo con usuarios de prueba `@cartera.local`: los
scripts se niegan a tocar cualquier otro.

## Correrlas

```bash
npm run e2e                      # levanta `next dev` y corre todo
```

Contra un build de producción (lo que hace la CI, y lo recomendable):

```bash
npm run build
E2E_WEB_COMMAND="npm run start" npm run e2e
```

Si ya hay un servidor escuchando en `E2E_BASE_URL` (por defecto
`http://localhost:3000`), se reutiliza.

El `globalSetup` reserva el usuario, le pone contraseña y un segundo factor
nuevos (`scripts/sesion-de-prueba.mjs`), le resiembra los datos
(`scripts/seed-demo.mjs`) y entra por la interfaz. Guarda la sesión en
`e2e/.auth/` y las credenciales en `sesion-de-prueba.txt`; los dos están en
`.gitignore`.

## Un usuario por dueño de la corrida

Cada corrida le **borra el factor** al usuario (eso revoca todas sus sesiones) y
le **resiembra los datos**. Dos corridas sobre el mismo usuario se pisan.

| Quién | Usuario | Cómo |
|---|---|---|
| CI (`.github/workflows/e2e.yml`) | `ci@cartera.local` | `E2E_EMAIL` en el workflow |
| Trabajo local y agentes | `fase3@cartera.local` | por defecto |
| Un agente o worktree más | `<nombre>@cartera.local` | `E2E_EMAIL=<nombre>@cartera.local` |

- Fuera de la CI, el arnés se niega a usar `ci@cartera.local`. Si sabes que la
  CI no va a correr, `E2E_PERMITIR_CI=1` lo permite.
- Cada corrida **reserva** su usuario con un cerrojo de Postgres mientras dura.
  Si otra corrida lo tiene, espera en fila (hasta `E2E_ESPERA_MIN`, 15 min) en
  vez de tumbarla.
- `sesion-de-prueba.mjs` comprueba el mismo cerrojo y no toca un usuario en uso
  (`--forzar` se lo salta).
- Para que dos agentes no esperen el uno al otro, cada uno con su usuario. Se
  crea así (solo `@cartera.local`, no hace nada si ya existe):

  ```bash
  node --env-file=.env.local scripts/crear-usuario-prueba.mjs agente1@cartera.local
  E2E_EMAIL=agente1@cartera.local npm run e2e
  ```

Los scripts sueltos que entran con un usuario (`sesion-prod.mjs`,
`bench-front.mjs`, `estres-datos.mjs`…) no pasan por el cerrojo: usa con ellos
un usuario que no esté corriendo el e2e.

## En un worktree

El worktree no tiene `.env.local` ni `node_modules` propios. No hace falta
copiar los secretos:

```bash
E2E_ENV_FILE=../../../.env.local npm run e2e
```

`npm run build` necesita, mientras dura, `turbopack.root` apuntando al repo
principal en `next.config.ts`; no se commitea.

## Variables

| Variable | Para qué |
|---|---|
| `E2E_EMAIL` | Usuario de prueba (`@cartera.local`) |
| `E2E_PERMITIR_CI` | `1` para usar `ci@cartera.local` fuera de la CI |
| `E2E_ESPERA_MIN` | Cuánto esperar si el usuario está reservado (15) |
| `E2E_ENV_FILE` | Fichero con los secretos (`.env.local`) |
| `E2E_BASE_URL` | Dónde está la app (`http://localhost:3000`) |
| `E2E_WEB_COMMAND` | Cómo arrancarla si no está (`npm run dev`) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Solo contra un despliegue (abajo) |

## Contra un despliegue: el desafío de Vercel

`playwright.prod.config.ts` corre las pruebas de robustez (red, accesibilidad
completa, desbordes) contra producción o contra `E2E_BASE_URL`, sin resembrar:

```bash
SESION_PRUEBA=sesion-de-prueba.txt npx playwright test -c playwright.prod.config.ts
```

Vercel puede responder `403` con `x-vercel-mitigated: challenge` a un navegador
automático (Playwright headless o `fetch` de Node). Para pasarlo hace falta el
bypass de Vercel:

1. En Vercel: proyecto → Settings → Deployment Protection → **Protection Bypass
   for Automation**. Genera el secreto. (No lo configura el arnés.)
2. Al correr: `VERCEL_AUTOMATION_BYPASS_SECRET=<secreto>`.

Con la variable, el acceso de `e2e/prod-setup.ts` (`scripts/sesion-prod.mjs`)
manda `x-vercel-protection-bypass: <secreto>` y
`x-vercel-set-bypass-cookie: true` **solo a las peticiones del despliegue**,
nunca a Supabase. Vercel deja una cookie de bypass que viaja en el
`storageState`, así que las pruebas que lo reutilizan también pasan. Los
contextos que empiezan sin sesión la añaden con `aplicarBypassVercel`
(`e2e/helpers.ts`).

Si el desafío viene del Firewall (Bot Protection o Attack Challenge Mode) y el
bypass de automatización no lo cubre, la alternativa es una regla del Firewall
con acción **Bypass** para esa cabecera, o correr contra un preview.

## Al escribir pruebas

- Los desplegables son Select de Radix, no `<select>`: usa
  `elegirOpcion(campo, "Opción")` de `helpers.ts`, no `selectOption`.
- Lo que crees, márcalo con un prefijo («E2E-…») y bórralo al terminar, también
  si la prueba falla.
- Un bug conocido de la app va como `test.fail(true, "<id>: …")`: cuando se
  arregle, Playwright avisará de que ya pasa.

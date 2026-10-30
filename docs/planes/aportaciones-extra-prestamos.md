# Préstamos: aportación extra, simulador y «Pagar todo lo que queda»

Estado: **APLICADO y publicado (2026-10-30).** Decisiones del usuario (2026-10-29): los dos modos (reducir
plazo y reducir cuota), con simulador «terminar en N meses» y «Liquidar» visible en la ficha.

---

## 1. Qué se quiere

| Función | Qué hace |
|---|---|
| **Aportación extra** | Pagas capital de más un mes. Eliges **reducir plazo** (misma cuota, terminas antes) o **reducir cuota** (mismo fin, pagas menos al mes). El cuadro se recalcula desde ahí. |
| **Simulador** | «Quiero terminar en N meses» → cuánto pagar de más **cada mes**, o cuánto aportar **una sola vez hoy**, y cuánto ahorras de intereses. Un toque rellena la aportación. |
| **Pagar todo lo que queda** | Es «Liquidar», que ya existe. Sale de la hoja de editar a un botón en la ficha. |

---

## 2. Cómo funciona hoy (y por qué hay que tocar el núcleo)

- El cuadro **no se guarda**: `public.loan_plan(principal, plazo, TIN, primera cuota)` lo calcula
  entero desde las condiciones iniciales, y `src/lib/prestamos.ts` hace lo mismo en TypeScript
  **al céntimo** (lo comprueba `scripts/test-prestamos.mjs`).
- Las cuotas las crea `private.loan_generate` leyendo ese cuadro: intereses = gasto, capital =
  traspaso a la cuenta‑pasivo.
- La deuda real es el saldo de la cuenta‑pasivo (invariante 2). Si hoy mueves dinero a mano a esa
  cuenta, la deuda baja pero el cuadro sigue igual: la ficha avisa de «descuadre» y las cuotas
  siguientes se cobran como si nada.

Quién lee `loan_plan` (todo esto pasa a leer el cuadro **efectivo**):

| Objeto | Para qué |
|---|---|
| `private.loan_generate` | crear cada cuota y cerrar el préstamo con la última |
| `public.loan_schedule` | el cuadro de la ficha y los próximos cargos de **Fijos** |
| `public.v_loan_status` | cuota, pendiente, intereses, próxima cuota, fin |
| `public.month_forecast`, `public.category_forecast` | lo que falta por cobrar este mes |
| `public.claim_loan_installment_notices` | el importe del aviso push de cada cuota |

Se quedan con el cuadro **original** (es lo que dice el contrato): `loan_check_terms` (validar el
alta), `loan_tae` (TAE informativa) y la vista previa del alta.

---

## 3. Modelo de datos

### 3.1 Tabla nueva `public.loan_prepayment`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | FK `auth.users` (cascade) |
| `loan_id` | uuid | FK compuesta `(user_id, loan_id)` → `loan` **on delete cascade** |
| `after_period` | smallint | se aplica **tras** esta cuota (0 = antes de la primera) |
| `paid_on` | date | fecha del pago real |
| `amount_cents` | bigint | > 0 y < pendiente |
| `mode` | text | `'PLAZO'` \| `'CUOTA'` |
| `fee_cents` | bigint | comisión (o intereses) que cobre el banco, 0 por defecto |
| `transaction_id`, `transaction_type` | uuid, entry_type | FK compuesta → `transaction (user_id, id, type)` **on delete cascade** |
| `created_at` | timestamptz | orden entre dos aportaciones del mismo mes |

- RLS forzada; **solo SELECT** para el usuario. Se escribe únicamente con las funciones (§5), igual
  que `loan`. Claves compuestas con `user_id` (invariante 5).
- Ningún saldo guardado: el importe es el del movimiento; la deuda sigue saliendo de la cuenta.

### 3.2 Dos partes nuevas en `transaction.loan_part`

| Parte | Tipo | Qué es |
|---|---|---|
| `AMORTIZACION` | TRANSFER | cuenta de pago → cuenta‑pasivo, por el importe aportado |
| `COMISION_AMORTIZACION` | EXPENSE | la comisión, en la categoría del préstamo |

Se amplían los CHECK `tx_loan_part_valid` y `tx_loan_part_type` (drop + add en la migración). Sin
número de cuota (`loan_period` nulo), como `LIQUIDACION`.

**Cuota entera.** En un préstamo con `counts_full_installment`, la aportación cuenta como gasto en
su categoría, igual que `CAPITAL` y `LIQUIDACION`: se añade `AMORTIZACION` a la lista en
`v_transaction_econ`, `month_forecast`, `category_forecast` y `search_transactions`. En la
previsión cuenta como «ya cobrado recurrente», así que no se extrapola como gasto suelto.

---

## 4. El cuadro efectivo (el corazón)

Función nueva `public.loan_cuadro(p_loan_id)` (SQL, `security invoker`, `stable`) y su espejo
exacto en TypeScript, `cuadroConAportaciones(base, aportaciones)` en `src/lib/prestamos.ts`.

### 4.1 Algoritmo

Estado inicial: pendiente = principal, cuota = la del cuadro original, fin = plazo.

Para cada cuota k = 1, 2, …:

1. **Antes de la cuota k**, se aplican las aportaciones con `after_period = k − 1` (en orden de
   alta): `pendiente −= importe`, y según el modo:
   - **CUOTA**: misma fecha de fin; cuota nueva = fórmula francesa con el pendiente nuevo y los
     meses que quedan (`fin − (k − 1)`). Mismo cálculo exacto en enteros que `loan_plan`.
   - **PLAZO**: misma cuota; el fin se acorta solo (paso 3).
2. `intereses_k = redondeo(pendiente · T / D)` — exactamente como hoy.
3. ¿Es la última? Lo es si `k = fin`, o si **(tramo PLAZO)** `cuota − intereses ≥ pendiente`.
   La última paga **todo** el pendiente (capital = pendiente): la deuda acaba en 0 al céntimo.
   Si no: capital = cuota − intereses.
4. `balance_after` de la fila k = lo que queda tras la cuota k **y** tras las aportaciones
   aplicadas después de ella. La curva baja ese mes. Columna nueva `prepaid_cents` en la fila k.

Garantías que comprueban las pruebas: Σ capital + Σ aportaciones = principal; ningún pendiente
negativo; en PLAZO la cuota no cambia y el fin no se alarga nunca; en CUOTA el fin no cambia;
sin aportaciones, el cuadro es **idéntico** a `loan_plan` fila a fila.

### 4.2 Cuándo se aplica una aportación

Al **límite del mes**: tras la última cuota cobrada a la fecha de la aportación. Si aportas el 10
de marzo y la cuota de marzo (día 1) ya se cobró, se aplica tras la de marzo y la de abril ya sale
recalculada. Si la cuota de ese mes aún no ha vencido, esa misma cuota sale recalculada.

**Simplificación consciente:** no se calculan los intereses por días entre la cuota y la
aportación. El banco puede cobrar unos céntimos o euros por esos días: van en el campo
«comisión o intereses que te cobre el banco», como gasto. El cuadro de la app puede diferir en
céntimos del que te dé el banco; si se aparta, la ficha lo dice con el aviso de «descuadre» que ya
existe.

---

## 5. Funciones de la base (escritura)

Todas `security invoker`, `search_path = ''`, sesión verificada (`private.current_user_id()`),
solo para `authenticated`.

### 5.1 `public.register_loan_prepayment(p_loan_id, p_on, p_amount_cents, p_mode, p_fee_cents)`

1. Préstamo del usuario, `ACTIVO`, bloqueado `for update`.
2. Fecha entre el inicio y hoy; si ya hay una cuota cobrada **después** de esa fecha → error
   («Ya hay una cuota cobrada después de esa fecha»), como en `settle_loan`.
3. Genera antes las cuotas vencidas hasta esa fecha (`loan_generate(…, p_on)`), para que
   `after_period` sea la última cobrada.
4. Importe ≥ 1 € y **menor que lo que debes**. Si es igual o mayor → error con la salida:
   «Para pagarlo entero, usa “Pagar todo lo que queda”».
5. Inserta el traspaso `AMORTIZACION` (y la comisión si la hay) y la fila de `loan_prepayment`.
6. Si tras la aportación el cuadro efectivo ya está cobrado entero (caso límite), cierra el
   préstamo como `LIQUIDADO` igual que la última cuota.

### 5.2 `public.undo_loan_prepayment(p_prepayment_id)`

Solo la **última** aportación, y solo si **no se ha cobrado ninguna cuota desde entonces**
(`last_generated_period = after_period`). Borra sus movimientos (la fila cae en cascada). Si ya
hay cuotas cobradas con el cuadro nuevo, deshacerla dejaría esas cuotas mal: se rechaza y se
explica.

### 5.3 Protecciones

- **Borrar a mano el movimiento de una aportación** desde Movimientos: hoy la RLS deja borrar
  cualquier movimiento de préstamo. Un disparador `BEFORE DELETE` en `transaction` lo impide para
  `AMORTIZACION` con un mensaje («Deshazla desde el préstamo»), salvo dentro de
  `undo_loan_prepayment` o `delete_loan` (marca de sesión, como `cartera.prestamo_a_borrar`).
  Lo mismo para cambiarle importe, cuenta o tipo (`BEFORE UPDATE`).
- **`update_loan_terms`** (cambiar condiciones antes de la primera cuota): si hay aportaciones,
  se rechaza («Deshaz antes las aportaciones»), porque se calcularon sobre las condiciones viejas.
- **`delete_loan`**: activa la marca antes de borrar los movimientos; las aportaciones caen en
  cascada con el préstamo.
- `settle_loan` (liquidar) no cambia: paga el pendiente real, que ya incluye las aportaciones.

### 5.4 Lo que se adapta

| Objeto | Cambio |
|---|---|
| `private.loan_generate` | lee `loan_cuadro`; cierra el préstamo en el **fin efectivo**; la descripción dice «cuota 3/20» con el fin efectivo, no el del contrato |
| `public.loan_schedule` | se recrea (cambia su tabla de salida): + `prepaid_cents`; estados con el fin efectivo |
| `public.v_loan_status` | mismas columnas calculadas con el cuadro efectivo (cuota **vigente**, restantes, intereses, fin, pendiente del cuadro ya con aportaciones) **+ al final**: `effective_term_months`, `prepaid_total_cents`, `interest_saved_cents` (intereses del cuadro original − efectivo) |
| comisiones en `v_loan_status` | `COMISION_AMORTIZACION` cuenta en comisiones y en el coste total |
| previsiones y avisos de cuota | leen `loan_cuadro` |
| `v_transaction_econ`, `search_transactions`, previsiones | `AMORTIZACION` en la lista de partes que cuentan con la cuota entera |

`loan.term_months` **no cambia**: es el plazo del contrato. El fin efectivo se calcula siempre.

---

## 6. La app

### 6.1 Ficha del préstamo (activo)

- Debajo del nombre, dos botones: **«Aportación extra»** y **«Pagar todo lo que queda»** (abre
  directamente el paso de liquidar).
- Un dato nuevo cuando haya aportaciones: **«Intereses que te ahorras: 743 €»** y el fin nuevo.
- El cuadro marca las aportaciones entre cuotas («Aportación extra · 3.000 € · reduce plazo»).
- La curva del capital ya baja sola (sale de `balance_after`).

### 6.2 Hoja «Aportación extra»

- Campos: **importe**, **fecha** (hoy por defecto; mínimo la última cuota cobrada),
  **¿Qué prefieres?** — tarjetas de radio como las del alta:
  - **Reducir plazo** (recomendado: más ahorro) — «misma cuota, terminas antes»
  - **Reducir cuota** — «mismo fin, pagas menos al mes»
  - **Comisión o intereses del banco** (opcional), con nota de que depende del contrato y la ley
    pone un tope.
- **Vista previa en vivo** (calculada con el mismo código que la base, al céntimo):
  antes → después: fecha de fin, cuotas que quedan, cuota, intereses pendientes y **ahorro**.
- Si el importe es igual o mayor que lo que debes: «Para pagarlo entero, usa “Pagar todo”».
- Tras guardar, mientras no se cobre otra cuota: «Deshacer la última aportación».

### 6.3 Simulador «Quiero terminar en…»

Dentro de la misma hoja, arriba: «Terminar en [ 20 ] meses» y dos respuestas:

- **Cada mes**: «Paga 531,19 € al mes (307,69 € más que ahora). Ahorras 998 € de intereses.»
  → botón «Aportar 307,69 € este mes» (rellena el formulario con modo Reducir plazo).
- **Una sola vez**: «O aporta hoy 5.792 € y mantén tu cuota.» → botón que lo rellena.

(Cifras del ejemplo: 10.000 € a 52 meses al 7 % TIN, simulando desde el principio.)

Las aportaciones de cada mes **se registran una a una**: el banco hay que pedírselo cada vez, y la
app apunta lo que has hecho, no lo ordena. (Automatizarlas queda fuera de esta versión.)

### 6.4 Otros sitios

- **Movimientos**: el detalle dice «Aportación extra al préstamo Coche · reduce plazo» y, si
  cuenta la cuota entera, «cuenta como gasto».
- **Fijos**: los próximos cargos del préstamo ya salen con la cuota nueva (vienen de
  `loan_schedule`).
- **Exportar**: añade `loan_prepayment`.
- **Guía** (`docs/guia`, inglés y español): sección de aportaciones y simulador.

---

## 7. Ficheros que se tocan

**Base:** una migración nueva `2026103…_aportaciones_extra.sql` (§3–§5).

**App:**
`src/lib/prestamos.ts` (cuadro con aportaciones, simulador) · `src/lib/prestamos-vista.ts`
(frases, `FilaCuadro.prepaid_cents`, origen del movimiento) · `src/lib/schemas.ts` ·
`src/lib/supabase/database.types.ts` · `src/app/(app)/prestamos/actions.ts` · `page.tsx` ·
`src/components/prestamos/ficha-prestamo.tsx` · `cuadro-amortizacion.tsx` ·
`prestamo-dialog-content.tsx` · `prestamo-dialog.tsx` · un componente nuevo
`aportacion-prestamo.tsx` · `src/app/(app)/movimientos/[id]/page.tsx` ·
`src/app/api/exportar/route.ts` · `docs/guia/README(.es).md`.

---

## 8. Pruebas

1. **Unitarias (vitest)**, `src/lib/prestamos.test.ts`:
   - sin aportaciones = cuadro original, fila a fila;
   - casos a mano: una aportación en PLAZO y en CUOTA; varias en el mismo mes; mezcla de modos;
     aportación antes de la primera cuota; aportación que deja una sola cuota;
   - invariantes en una rejilla aleatoria (Σ capital + aportaciones = principal, pendiente ≥ 0,
     cuota constante en PLAZO, fin fijo en CUOTA, nunca más largo);
   - simulador: pagar lo que dice termina exactamente en N meses.
2. **Base** (`scripts/test-aportaciones.mjs`, en una transacción que se deshace):
   - **TS = SQL al céntimo** en cientos de casos aleatorios;
   - registrar, generar cuotas, deshacer, liquidar después, borrar el préstamo;
   - protecciones: borrar el movimiento a mano, deshacer con cuotas cobradas, cambiar
     condiciones con aportaciones, importe ≥ pendiente, fecha anterior a una cuota cobrada;
   - el préstamo se cierra en el fin nuevo; `v_loan_status` sin descuadre; previsión y avisos
     con la cuota nueva; cuota entera cuenta la aportación como gasto;
   - RLS y claves compuestas; usuarios reales con cifras idénticas (huellas).
3. **Pruebas que ya existen** a actualizar: `test-prestamos.mjs` (y de paso su comprobación de
   «ningún usuario real tiene préstamos», que ya falla porque hay uno), `test-prestamos-categoria.mjs`.
4. **Punta a punta en producción** tras publicar, solo con el usuario de pruebas, y limpieza.

**Aviso operativo:** la prueba de base redefine `v_transaction_econ` y `v_loan_status` dentro de
su transacción y **bloquea esas vistas mientras dura** (1–2 minutos): las pantallas de la app
pueden tardar o fallar en ese rato (ver `pruebas-bd-bloquean-prod`). Se lanzará solo con tu aviso
y a una hora en la que no estéis usando la app.

---

## 9. Orden de ejecución

1. Matemática en TS + pruebas unitarias (sin tocar la base).
2. Migración + `test-aportaciones.mjs` (en transacción que se deshace, con tu aviso).
3. Servidor (acciones, esquemas, tipos).
4. Interfaz (ficha, hoja, simulador, cuadro, movimientos) + revisión en el navegador, móvil y
   escritorio.
5. Guía y exportación.
6. `lint`, `typecheck`, `test`, `build`.
7. **Con tu OK**: aplicar la migración, publicar, comprobar en producción, portafolio.

---

## 10. Decisiones abiertas (por defecto, lo marcado)

| # | Pregunta | Por defecto |
|---|---|---|
| A | La aportación se aplica al límite del mes, sin intereses por días (van en el campo de comisión) | **Sí** |
| B | En un préstamo con «cuota entera», la aportación cuenta como gasto en su categoría | **Sí**, coherente con las cuotas y la liquidación |
| C | Deshacer solo la última aportación y solo antes de la siguiente cuota; borrarla desde Movimientos, bloqueado | **Sí** |
| D | Las aportaciones mensuales se registran a mano cada mes (sin automatizar) | **Sí** en esta versión |
| E | Si el banco recalcula una cuota distinta por céntimos, no hay campo para corregirla (sale el aviso de descuadre) | **Sí** en esta versión |
| F | Importe mínimo de una aportación | **1 €** |

## 11. Fuera de esta versión

Aportaciones automáticas cada mes; intereses por días exactos; corregir a mano la cuota que dé el
banco; cambiar el TIN a mitad (revisiones de tipo variable).

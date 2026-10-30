<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Cartera — reglas del proyecto

App de finanzas personales. Cuatro usuarios, datos reales, privada. El idioma de
la interfaz, los comentarios y los commits es **español**.

## Invariantes que no se negocian

Romper cualquiera de estos produce cifras incorrectas en el dinero de personas
reales. Si una tarea parece exigir saltarse uno, la tarea está mal planteada.

1. **Todo importe es un entero en céntimos.** Nunca coma flotante, en ninguna
   capa. `parseFloat("12,40")` devuelve `12` en JavaScript, y `0.29 * 100` da
   `28.999999999999996`. Para convertir texto a céntimos existe
   `parseAmountToCents()` en `src/lib/money.ts`, que está probada.
2. **Los saldos no se almacenan.** El saldo de una cuenta y el patrimonio neto se
   derivan siempre de los movimientos, en las vistas de `supabase/migrations`.
   No crear jamás una columna `balance`.
3. **Un traspaso no tiene signo.** No afecta a gasto, ingreso, balance del mes,
   reparto por categoría ni límites. Solo mueve saldo entre dos cuentas. La vista
   `v_transaction_econ` ya los excluye: no volver a filtrarlos consulta a consulta.
4. **Un ingreso que reembolsa un gasto no es un ingreso.** Abarata el gasto: se
   imputa a la categoría del gasto enlazado y resta del gasto neto.
5. **Toda clave foránea es compuesta con `user_id`.** La seguridad a nivel de fila
   NO protege las claves foráneas, porque la comprobación de integridad la ejecuta
   el sistema con privilegios internos. Sin la clave compuesta, un usuario puede
   insertar una fila propia que apunte a datos de otro.
6. **Toda vista lleva `security_invoker = true`.** Sin él, la vista se ejecuta con
   los permisos de quien la creó y filtra datos entre usuarios.
7. **Toda función `security definer` lleva `set search_path = ''`** y cualifica los
   nombres con su esquema.
8. **`SUPABASE_SERVICE_ROLE_KEY` nunca lleva prefijo `NEXT_PUBLIC_`** ni se importa
   desde un componente de cliente. La CI falla si aparece en el paquete del cliente.

## Convenciones

- **Diseño**: identidad **Aurora** —fondo espacio oscuro, materiales de cristal
  con profundidad y un acento IRIDISCENTE violeta → cian → oro—, definida entera
  en los tokens de `src/app/globals.css`. Sustituye a la identidad editorial
  anterior (crema, tinta, latón). El modo OSCURO es el héroe y el tema por
  defecto; hay un modo claro Aurora (porcelana fría) legible pero secundario. No
  inventar colores, radios ni sombras: usar las variables. Reglas que la
  sostienen:
  - **Un solo acento.** El acento de verdad es el gradiente iridiscente
    (`--grad-aurora`); para lo que necesita un color sólido (foco, enlace,
    estado activo) está el cian `--accent`. No hay acento conmutable, y no debe
    volver: seis acentos a elegir no son una identidad, son ninguna.
  - **Acciones principales: el botón negro con canto Aurora.** Guardar, entrar,
    el «+» de la barra, «Añadir movimiento»… no son un relleno de color: son un
    cuerpo NEGRO con un canto de 1 px del espectro, la utilidad `boton-aurora`
    (tokens `--btn-*`), que ya lleva la variante primaria de `Button`. Es un
    material, no un modo: negro también en el tema claro. Nada de `bg-accent`
    en un botón. El halo del espectro solo en lo que flota (el «+»). Lo
    destructivo NO usa este material: secundario con texto coral para lo
    reversible o lo que pide un segundo toque, relleno coral para lo que no
    tiene vuelta atrás.
  - **La banda Aurora es la firma.** El espectro horizontal de categorías
    (`src/components/ui/banda-aurora.tsx`) es la viz característica del reparto
    del gasto (Resumen) —reutilizable, con brillo y lectura al tocar—. El donut
    (`donut-aurora`) vuelve solo para composiciones de pocas partes con un total
    que importa (la cartera, las fuentes de ingreso) y, con `ArcoAnillo`, para
    los anillos de presupuesto: el centro para la lectura y los nombres en una
    lista debajo, nunca rótulos en los sectores ni alrededor (se cortan).
  - **Gráficos con la gramática Bolsa/Salud.** Primitivos: `linea-interactiva`,
    `barras-interactivas`, `barras-ranking` (las barras horizontales grandes de
    «Dónde está»), `donut-aurora` y `banda-aurora`; la mecánica de lectura en
    `use-lectura`/`lectura` y la aritmética en `src/lib/graficos.ts`. Al leer, la
    CIFRA de la cabecera se convierte en la lectura y nada flota sobre la curva;
    periodo anterior en discontinua; barras cápsula con la media en un canal
    aparte; MÁX/MÍN/HOY en oro en las curvas de nivel; y solo el gráfico héroe de
    cada pantalla dibuja su trazo al entrar y lleva el punto de oro.
  - **Cristal solo para lo que flota.** La utilidad `glass-card` (desenfoque +
    filete + brillo interior + sombra honda) es para lo superpuesto de verdad (la
    tarjeta de previsión, las hojas). El resto de cajas se cierran con **filete,
    no con sombra**: `hair border-hairline` (0,5 px).
  - **`cifra` (Space Grotesk) para las cifras protagonistas** —la héroe de cada
    pantalla, los valores de una tira de totales, las lecturas de un gráfico—, con
    la utilidad `cifra`. En listas y tablas densas (movimientos) la cifra va en la
    de interfaz (Inter) con `tabular-nums`, que es lo que alinea las columnas.
  - **Nada de texto por debajo de 13 px.** Se lee a un brazo de distancia.
  - **Antes de añadir una tarjeta, comprobar que agrupa algo.** Una cifra sola
    no se agrupa con nada: va sin caja, separada con filete.
- **Responsive**: un único punto de ruptura, `lg:` (1024 px). Primero CSS; solo se
  duplica el markup donde la estructura cambia de verdad: navegación,
  lista/tabla de movimientos, filtros y la curva de saldo de Cuentas. El resto
  es la MISMA maqueta con variantes `lg:`, y el orden del DOM es siempre el de
  móvil: en escritorio las columnas se colocan con `col-start`, no reordenando.
  Si te encuentras escribiendo dos veces la misma cifra —una para cada
  anchura—, está mal: eso es el doble de sitios donde equivocarse.
- **Escritorio**: el cuerpo llega a 1400 px, pero la segunda columna hay que
  ganársela. Vale para un formulario o para grupos de ajustes, que son estrechos
  por naturaleza. NO vale donde hay texto corrido —partir en dos una lista de
  conceptos solo consigue cortar palabras— ni para una barra de filtros, que se
  envuelve sola y en columna se queda pegada encima del listado. Resumen y
  Movimientos son de una sola columna a propósito.
- **Ajustes**: cada sección es una fila (`SeccionAjustes`): título y explicación
  anclados a la izquierda, controles a la derecha. No repartir sus bloques en dos
  columnas de tarjetas: con alturas tan distintas, deja un hueco junto a cada uno
  corto. Dentro de la tarjeta, lo que va en línea se decide con `@container`, no
  con `lg:`: es la única excepción al punto de ruptura único, porque a 1024 px la
  tarjeta aún es estrecha.
- **Nada `sticky` más alto que la ventana.** Un panel anclado que mide más que
  la pantalla deja su parte de abajo —el botón de guardar— fuera de alcance para
  siempre. Antes de anclar algo, medir cuánto ocupa.
- **Losa Aurora**: la pieza héroe de Patrimonio es una TARJETA (`losa-aurora`
  con `hair border-hairline` y el radio de los tokens) que sigue al tema, con un
  amanecer del espectro en el canto. Nada de bandas a sangre ni de piezas que
  se queden oscuras en el tema claro: sin canto se leen como una imagen pegada.
  (`en-tinta`, que da la vuelta a los tokens para un fondo oscuro fijo, sigue
  en `globals.css` pero ya no lo usa ninguna pantalla.)
- **Tipografía**: Space Grotesk (display y cifras) e Inter (interfaz), ambas
  autoalojadas con `next/font/google` desde `src/app/layout.tsx` y expuestas como
  `--font-cifra` y `--font-sans`.
- **Formateo**: usar siempre `src/lib/money.ts`. `Intl` con locale `es-ES` ya
  reproduce la convención del prototipo, incluido no agrupar los millares hasta
  las 5 cifras.
- **Migraciones**: solo hacia delante. Una migración aplicada no se edita nunca;
  se corrige con otra nueva.

## Comprobaciones antes de dar algo por terminado

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

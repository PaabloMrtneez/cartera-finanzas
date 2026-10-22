import { PageBody, PageHeader } from "@/components/app/page-header";
import { FilterControls, FilterSheet, SearchBox } from "@/components/movimientos/filters";
import { ListaMovimientos } from "@/components/movimientos/lista-movimientos";
import { MonthNav } from "@/components/movimientos/month-nav";
import { ButtonLink } from "@/components/ui/button";
import { UnclassifiedBars } from "@/components/movimientos/unclassified-bars";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import {
  argumentosBusqueda,
  filaLigera,
  leerConsulta,
  type Catalogo,
} from "@/lib/consulta-movimientos";
import { monthLabel, todayIso } from "@/lib/dates";
import { activeFilterCount } from "@/lib/filters";
import { formatCents } from "@/lib/money";
import { leerTodo } from "@/lib/supabase/paginar";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Movimientos" };

export default async function MovimientosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hoy = todayIso();
  // Mes, filtros y cuántas filas enseñar, leídos de la dirección igual que los
  // lee «Cargar más» (`lib/consulta-movimientos.ts`). El número de filas vive en
  // la dirección como el mes y los filtros: recargar o abrir un enlace
  // compartido enseña lo mismo.
  const consulta = leerConsulta(params, hoy);
  const { filters, all, month, filas } = consulta;

  const supabase = await createClient();

  // Las cuatro lecturas son independientes y van a la vez. Antes la búsqueda
  // esperaba a que terminaran las otras tres: una ida y vuelta de más a la base
  // en cada visita.
  //
  // Categorías y cuentas se traen enteras (solo las columnas que se pintan):
  // son decenas de filas y así se evita depender de que PostgREST resuelva el
  // anidado sobre claves foráneas compuestas, que es donde suele fallar.
  //
  // Todo el filtrado, la búsqueda y los totales van en una sola llamada: el
  // gasto de la cabecera y el «quedan N» son del conjunto completo, no de lo
  // cargado, y buscar por nombre de categoría llega a todas las filas.
  const [{ data: categories }, { data: accounts }, { data: colaPorMes }, { data: rows }] =
    await Promise.all([
      supabase.from("category").select("id, name, color, icon").order("name"),
      supabase.from("account").select("id, name").order("name"),
      supabase.rpc("unclassified_by_month", { p_months: 6 }),
      // Por páginas (leerTodo): PostgREST corta cada respuesta a 1.000 filas
      // sin avisar. La primera tanda no pasa de 500 (cabe en una página); es la
      // red por si ese tope sube. La búsqueda tiene un orden total (desempate
      // por id), así que las páginas no repiten ni se saltan filas.
      leerTodo(
        (desde, hasta) =>
          supabase
            .rpc("search_transactions", argumentosBusqueda(consulta, filas))
            .range(desde, hasta),
        { maximo: filas },
      ),
    ]);

  // Lo que necesitan los filtros, una vez (las dos variantes reciben el mismo
  // objeto) y sin columnas de más.
  const opcionesCategorias = (categories ?? []).map(({ id, name }) => ({ id, name }));
  const opcionesCuentas = accounts ?? [];

  // El catálogo con que la lista pinta cada fila: se manda una vez, y cada fila
  // viaja solo con sus ids.
  const catalogo: Catalogo = {
    categorias: Object.fromEntries(
      (categories ?? []).map((c) => [c.id, { name: c.name, color: c.color, icon: c.icon }]),
    ),
    cuentas: Object.fromEntries((accounts ?? []).map((a) => [a.id, { name: a.name }])),
  };
  const transactions = (rows ?? []).map(filaLigera);

  // Del conjunto completo, no de lo cargado.
  const total = Number(rows?.[0]?.total_count ?? 0);
  const netExpense = Number(rows?.[0]?.total_net_cents ?? 0);

  // La dirección que identifica esta tanda: si cambia (otro filtro, otro mes,
  // un refresco con más filas), la lista vuelve a empezar desde aquí.
  const claveLista = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
  ).toString();

  const filterCount = activeFilterCount(filters);

  return (
    <>
      <PageHeader
        title="Movimientos"
        actions={
          // En móvil solo se ve el icono: el nombre accesible lo da el aria-label.
          <ButtonLink href="/movimientos/nuevo" size="compact" aria-label="Añadir movimiento">
            <Icon name="plus" size={15} />
            <span className="hidden lg:inline">Añadir</span>
          </ButtonLink>
        }
      />

      <PageBody>
        {/*
          El héroe: el gasto neto del periodo en grande, sin caja, como en
          Cuentas con su total. Una cifra sola no se agrupa con nada, así que va
          separada —no en tarjeta— y entra con el empujón de `animate-rise`. Solo
          cuando hay algo que resumir: con la lista vacía la cifra sería un
          «0,00 €» sin sentido, y manda el estado vacío de más abajo.
        */}
        {transactions.length > 0 ? (
          <section className="flex animate-rise flex-col">
            <Eyebrow className="text-accent-text">
              {all ? "Gasto, todo el histórico" : `Gasto de ${monthLabel(month)}`}
            </Eyebrow>
            <p className="mt-2 cifra-hero">
              {formatCents(netExpense)}
            </p>
            <p className="mt-2 text-[14px] leading-5 text-muted tabular-nums lg:text-[15px]">
              {total} {total === 1 ? "movimiento" : "movimientos"}
              {" · neto, los traspasos no gastan"}
            </p>
          </section>
        ) : null}

        {/*
          Se envuelve: a 320 px el mes, «Todo» y «Filtros» no caben en una línea
          (la página medía 369 px). Entonces «Filtros» baja a la siguiente,
          pegado a la derecha (`ml-auto`), en vez de empujar la página.
        */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MonthNav month={month} all={all} />
          <div className="ml-auto lg:hidden">
            <FilterSheet
              filters={filters}
              categories={opcionesCategorias}
              accounts={opcionesCuentas}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <SearchBox value={filters.q} />
        </div>

        {/*
          En escritorio los filtros van en línea, sin hoja de por medio.

          Se probó a sacarlos a un raíl fijo a la izquierda y no vale: el raíl
          es tan alto como la lista de categorías, se queda pegado y acaba
          montándose sobre el listado. Y una barra que se envuelve sola no
          necesita columna propia.
        */}
        <div className="hidden lg:block">
          <FilterControls
            filters={filters}
            categories={opcionesCategorias}
            accounts={opcionesCuentas}
            layout="linea"
          />
        </div>

        {/* Dónde se acumula la cola de sin clasificar. La RPC devuelve los meses
            aunque estén a cero, y el gráfico no pinta nada sin cola: sin esta
            condición quedaba una tarjeta con solo su título. */}
        {colaPorMes && colaPorMes.some((m) => m.cuantos > 0) ? (
          <Card>
            <CardHeader title="Sin clasificar por mes" />
            <UnclassifiedBars meses={colaPorMes} />
          </Card>
        ) : null}

        {transactions.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="inbox" size={26} />
            </span>
            {/*
              Tres vacíos distintos. Antes un mes sin apuntes decía «Todavía no
              hay movimientos · Añade el primero» aunque hubiera años de
              historia en los meses anteriores.
            */}
            <h2 className="text-[17px] leading-[22px] font-semibold">
              {filterCount > 0 || filters.q
                ? "Nada coincide con esos filtros"
                : all
                  ? "Todavía no hay movimientos"
                  : `Nada en ${monthLabel(month)}`}
            </h2>
            <p className="max-w-sm text-[15px] leading-5 text-muted">
              {filterCount > 0 || filters.q
                ? "Prueba a quitar algún filtro o a mirar otro mes."
                : all
                  ? "Añade el primero a mano, o instala el Atajo del iPhone para que entren solos al pagar."
                  : "Este mes aún no tiene apuntes. Añade uno, o pulsa «Todo» para ver los anteriores."}
            </p>
            {filterCount === 0 && !filters.q ? (
              <ButtonLink href="/movimientos/nuevo">
                {all ? "Añadir el primero" : "Añadir movimiento"}
              </ButtonLink>
            ) : null}
          </Card>
        ) : (
          <>
            {/* La lista entra tras el héroe. */}
            <div className="flex animate-rise flex-col gap-4 lg:gap-6" style={{ animationDelay: "80ms" }}>
              <ListaMovimientos
                key={claveLista}
                inicial={transactions}
                catalogo={catalogo}
                hoy={hoy}
                total={total}
                consulta={claveLista}
              />
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}

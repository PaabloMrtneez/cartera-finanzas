import { NextResponse } from "next/server";
import { todayIso } from "@/lib/dates";
import {
  ETIQUETA_ESTADO,
  ETIQUETA_TIPO,
  centsToDecimalString,
  nombreFichero,
  toCsv,
} from "@/lib/export";
import { leerTodo } from "@/lib/supabase/paginar";
import { createClient } from "@/lib/supabase/server";

/**
 * Descarga de todos tus datos, en CSV o en JSON.
 *
 * Sustituye al «Descargar la base .db» del prototipo, que daba por hecho un
 * SQLite local. Aquí los datos viven en Postgres y son de cuatro personas
 * distintas, así que se exporta lo tuyo y nada más.
 *
 * No hace falta comprobar de quién es cada fila: se usa el cliente con tu
 * sesión, así que la seguridad a nivel de fila ya devuelve solo lo tuyo.
 * Filtrar otra vez aquí daría la falsa impresión de que ese filtro es el que
 * protege, y el día que alguien lo quitara nadie sabría lo que estaba tocando.
 *
 * TODO se lee PAGINADO (leerTodo): PostgREST corta cada respuesta a 1.000 filas
 * sin avisar, y la copia de alguien con más de 1.000 movimientos salía
 * incompleta (la JSON, con los 1.000 más antiguos). Cada consulta lleva un
 * orden total que acaba en una columna única, para que las páginas no repitan
 * ni se salten filas.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No has iniciado sesión." }, { status: 401 });
  }

  const formato = new URL(request.url).searchParams.get("formato") ?? "csv";
  if (formato !== "csv" && formato !== "json") {
    return NextResponse.json({ error: "Formato no reconocido." }, { status: 400 });
  }

  const hoy = todayIso();

  if (formato === "csv") {
    // Los nombres se resuelven con mapas en lugar de con joins embebidos: las
    // claves foráneas son compuestas con user_id y PostgREST no sabe deducir la
    // relación. Es el mismo camino que siguen Movimientos y Resumen.
    const [{ data: movimientos, error }, { data: cuentas }, { data: categorias }] =
      await Promise.all([
        leerTodo((desde, hasta) =>
          supabase
            .from("transaction")
            .select("*")
            .order("occurred_on", { ascending: false })
            .order("occurred_time", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(desde, hasta),
        ),
        leerTodo((desde, hasta) => supabase.from("account").select("id, name").order("id").range(desde, hasta)),
        leerTodo((desde, hasta) => supabase.from("category").select("id, name").order("id").range(desde, hasta)),
      ]);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const nombreCuenta = new Map(cuentas.map((c) => [c.id, c.name]));
    const nombreCategoria = new Map(categorias.map((c) => [c.id, c.name]));

    const csv = toCsv(
      [
        "Fecha",
        "Hora",
        "Tipo",
        "Descripción",
        "Importe",
        "Cuenta",
        "Cuenta destino",
        "Categoría",
        "Comercio",
        "Tarjeta",
        "Origen",
        "Estado",
        "Nota",
      ],
      movimientos.map((t) => [
        t.occurred_on,
        String(t.occurred_time).slice(0, 5),
        ETIQUETA_TIPO[t.type] ?? t.type,
        t.description,
        centsToDecimalString(t.amount_cents),
        nombreCuenta.get(t.account_id) ?? "",
        t.to_account_id ? (nombreCuenta.get(t.to_account_id) ?? "") : "",
        // «Sin categoría» no es una fila que exista: es la ausencia de una.
        t.category_id ? (nombreCategoria.get(t.category_id) ?? "") : "Sin categoría",
        t.merchant_raw ?? "",
        t.card_last4 ?? "",
        t.source,
        ETIQUETA_ESTADO[t.status] ?? t.status,
        t.note ?? "",
      ]),
    );

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nombreFichero("movimientos", "csv", hoy)}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // El JSON es la copia de seguridad completa: todo, en céntimos enteros, para
  // poder restaurar sin perder un céntimo ni depender de cómo se lea una coma.
  //
  // Solo datos de origen. Saldos, patrimonio y cierres de mes no se guardan
  // aquí por la misma razón por la que no se guardan en la base: se derivan.
  // Una copia que llevara cifras derivadas podría restaurarse contradiciéndose.
  //
  // Están todas las tablas con datos del usuario (también ingresos fijos, metas,
  // tarjetas, préstamos y el libro de participaciones, que faltaban). Lo que no
  // va: las cifras derivadas, los catálogos compartidos (instrumentos, precios,
  // cambios) y lo técnico (dispositivos del Atajo, avisos, suscripciones push).
  const [
    cuentas,
    categorias,
    movimientos,
    reglas,
    suscripciones,
    ingresosFijos,
    limites,
    metas,
    tarjetas,
    prestamos,
    aportacionesPrestamos,
    posiciones,
    participaciones,
    valoraciones,
    perfil,
  ] = await Promise.all([
    leerTodo((d, h) => supabase.from("account").select("*").order("id").range(d, h)),
    leerTodo((d, h) => supabase.from("category").select("*").order("id").range(d, h)),
    leerTodo((d, h) =>
      supabase
        .from("transaction")
        .select("*")
        .order("occurred_on")
        .order("occurred_time")
        .order("created_at")
        .order("id")
        .range(d, h),
    ),
    leerTodo((d, h) => supabase.from("merchant_rule").select("*").order("id").range(d, h)),
    leerTodo((d, h) => supabase.from("subscription").select("*").order("id").range(d, h)),
    leerTodo((d, h) => supabase.from("recurring_income").select("*").order("id").range(d, h)),
    leerTodo((d, h) => supabase.from("budget").select("*").order("id").range(d, h)),
    leerTodo((d, h) => supabase.from("savings_goal").select("*").order("id").range(d, h)),
    leerTodo((d, h) => supabase.from("card").select("*").order("id").range(d, h)),
    leerTodo((d, h) => supabase.from("loan").select("*").order("id").range(d, h)),
    leerTodo((d, h) =>
      supabase.from("loan_prepayment").select("*").order("created_at").order("id").range(d, h),
    ),
    leerTodo((d, h) => supabase.from("investment_position").select("*").order("id").range(d, h)),
    leerTodo((d, h) =>
      supabase.from("position_unit_event").select("*").order("date").order("seq").range(d, h),
    ),
    leerTodo((d, h) => supabase.from("valuation").select("*").order("date").order("id").range(d, h)),
    leerTodo((d, h) => supabase.from("profile").select("*").order("user_id").range(d, h)),
  ]);

  const fallo = [
    cuentas,
    categorias,
    movimientos,
    reglas,
    suscripciones,
    ingresosFijos,
    limites,
    metas,
    tarjetas,
    prestamos,
    aportacionesPrestamos,
    posiciones,
    participaciones,
    valoraciones,
    perfil,
  ].find((r) => r.error);
  if (fallo?.error) {
    return NextResponse.json({ error: fallo.error.message }, { status: 500 });
  }

  const copia = {
    formato: "cartera/1",
    exportado_el: new Date().toISOString(),
    unidad_importes: "céntimos enteros",
    cuenta: user.email,
    datos: {
      cuentas: cuentas.data,
      categorias: categorias.data,
      movimientos: movimientos.data,
      reglas: reglas.data,
      suscripciones: suscripciones.data,
      ingresos_fijos: ingresosFijos.data,
      limites: limites.data,
      metas: metas.data,
      tarjetas: tarjetas.data,
      prestamos: prestamos.data,
      aportaciones_prestamos: aportacionesPrestamos.data,
      posiciones: posiciones.data,
      participaciones: participaciones.data,
      valoraciones: valoraciones.data,
      perfil: perfil.data,
    },
  };

  return new NextResponse(JSON.stringify(copia, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nombreFichero("copia", "json", hoy)}"`,
      "Cache-Control": "no-store",
    },
  });
}

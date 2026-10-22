import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { mesMadrid } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { textoAvisoCuota } from "@/lib/prestamos";
import {
  configurarPush,
  enSilencio,
  enviarAviso,
  horaMadrid,
  type Aviso,
} from "@/lib/push";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Envía los avisos push. La llama una tarea programada, no una persona.
 *
 * Antes de avisar, COBRA: genera las cuotas vencidas de los préstamos de todos
 * los usuarios (`generate_loan_installments_all`, solo service_role). Va antes
 * de la ventana de silencio porque cobrar no es avisar: la cuota del día 1 se
 * apunta en la primera pasada desde las 00:00 de Madrid, y su aviso sale en la
 * primera pasada fuera del silencio.
 *
 * Seis avisos y nada más:
 *   · una cuota de préstamo cobrada por el cron («Se ha cobrado la cuota de…»)
 *   · los pagos sin asignar, UNA VEZ AL DÍA a las 9 de la mañana
 *   · un límite que llega al 80 % o al 100 % (reactivo: sobre lo ya gastado)
 *   · un límite que, al ritmo actual, se va a rebasar (predictivo: sobre la
 *     previsión, para avisar ANTES de pasarse; una vez por límite y mes)
 *   · el resumen del mes, al cerrarlo
 *   · la ingesta del Atajo en mal estado (rechazos o dispositivo mudo), una
 *     vez por la mañana y con ventana de reposo para no machacar a diario
 *
 * Y una ventana de silencio: nada entre las 23:00 y las 08:00 de Madrid. Un
 * aviso a las tres de la mañana por algo que puede esperar al desayuno solo
 * enseña a apagar las notificaciones.
 *
 * La confirmación de un pago NO sale de aquí: la manda la ingesta en el momento
 * del cargo, y a esa no se le aplica el silencio. Es la diferencia entre un
 * aviso que interrumpe y uno que responde a algo que acabas de hacer.
 */

/** Lo único que esta ruta escribe en `loan`: devolver un aviso de cuota. */
type TablaAvisosCuota = {
  update(valores: { notified_period: number }): {
    eq(columna: "id", valor: string): {
      eq(columna: "notified_period", valor: number): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// La hora de Madrid, la ventana de silencio y la mecánica de envío viven en
// `lib/push`, compartidas con la ingesta del Atajo, que también avisa. Dos
// copias acabarían tratando distinto un dispositivo caducado.

/**
 * Compara el secreto en tiempo constante.
 *
 * `a !== b` corta en cuanto encuentra el primer byte distinto, y ese tiempo
 * distinto filtra cuántos bytes has acertado: repitiendo, se reconstruye el
 * secreto byte a byte. Sobre HTTP el jitter de red lo hace casi inviable y el
 * secreto es de alta entropía, pero comparar en tiempo constante cuesta lo mismo
 * y cierra la puerta del todo. `timingSafeEqual` exige buffers de igual tamaño,
 * así que la distinta longitud se descarta antes, sin pistas de temporización.
 */
function secretoValido(recibido: string | undefined, esperado: string): boolean {
  if (!recibido) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const esperado = process.env.NOTIFY_SECRET;
  const recibido = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!esperado || !secretoValido(recibido, esperado)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // 0) Las cuotas de los préstamos se COBRAN aquí, en cada pasada del cron, y
  //    antes de la ventana de silencio y de comprobar el push: cobrar no es
  //    avisar. Una cuota del día 1 entra en la primera pasada a partir de las
  //    00:00 de Madrid (la base decide «hoy» con la hora de Madrid). Es
  //    idempotente: el cron puede disparar de más sin cobrar dos veces. Si
  //    fallara, no tumba los avisos: se reintenta en la siguiente pasada.
  const { data: cuotasGeneradas, error: errorCuotas } = await supabase.rpc(
    "generate_loan_installments_all",
  );

  if (!configurarPush()) {
    return NextResponse.json(
      { ok: false, error: "vapid_no_configurado", cuotas_generadas: cuotasGeneradas ?? 0 },
      { status: 500 },
    );
  }

  const hora = horaMadrid();
  const forzar = new URL(request.url).searchParams.get("forzar") === "1";

  if (enSilencio(hora) && !forzar) {
    // El aviso de esas cuotas no se pierde: claim_loan_installment_notices lo
    // devolverá en la primera pasada fuera del silencio.
    return NextResponse.json({
      ok: true,
      omitido: "ventana_de_silencio",
      hora,
      cuotas_generadas: cuotasGeneradas ?? 0,
      ...(errorCuotas ? { error_cuotas: true } : {}),
    });
  }

  // El mes de MADRID (H-07): el día 1 a las 00:30 ya es el mes que empieza.
  const mes = mesMadrid();

  // Los avisos se agrupan por usuario: el reparto de subscripciones va después.
  const porUsuario = new Map<string, Aviso[]>();
  const anadir = (userId: string, aviso: Aviso) => {
    const lista = porUsuario.get(userId) ?? [];
    lista.push(aviso);
    porUsuario.set(userId, lista);
  };

  // H-14: el error de una consulta de avisos no se calla. El resto sigue (un
  // tipo de aviso que falla no deja sin los demás), pero el resumen lo dice.
  const erroresAvisos: string[] = [];
  const anotarError = (consulta: string, error: { message: string } | null) => {
    if (!error) return;
    erroresAvisos.push(consulta);
    console.error(`notificar: ${consulta} ha fallado`, error.message);
  };

  // 1) Recordatorio de pagos sin asignar: una vez al día, desde las 9 de la
  //    mañana de Madrid. La función marca el día antes de devolver, así que da
  //    igual que el cron dispare dos veces o llegue tarde.
  //
  //    No se nombra el Atajo: es un detalle de cómo llegó el dato, no algo que
  //    le importe a quien tiene que sentarse a asignarlos.
  const { data: recordatorios, error: errorRecordatorios } = await supabase.rpc("claim_pending_reminder", {
    p_from_hour: 9,
  });
  anotarError("claim_pending_reminder", errorRecordatorios);

  for (const fila of recordatorios ?? []) {
    anadir(fila.user_id, {
      title:
        fila.cuantos === 1
          ? "Tienes 1 pago sin asignar"
          : `Tienes ${fila.cuantos} pagos sin asignar`,
      body: "Entra y asígnalos: sin categoría no cuentan en el reparto ni en los límites.",
      url: "/movimientos?pendientes=1",
      tag: "pendientes",
    });
  }

  // 2) Límites que han cruzado un umbral.
  //
  //    Una sola llamada devuelve los avisos de todos los usuarios, cada uno con
  //    su dueño. La función anota lo que va a avisar antes de devolverlo, así que
  //    llamarla dos veces no manda el mismo aviso dos veces.
  const { data: avisosLimite, error: errorLimite } = await supabase.rpc("claim_budget_alerts", { p_month: mes });
  anotarError("claim_budget_alerts", errorLimite);

  for (const aviso of avisosLimite ?? []) {
    anadir(aviso.user_id, {
      title:
        aviso.threshold === 100
          ? `Has pasado el límite de ${aviso.category_name}`
          : `Vas por el 80 % en ${aviso.category_name}`,
      body: `${formatCents(aviso.spent_cents)} de ${formatCents(aviso.cap_cents)} este mes.`,
      url: "/analisis",
      tag: `limite-${aviso.category_name}-${aviso.threshold}`,
    });
  }

  // 2b) Límites que, al ritmo actual, se van a rebasar aunque AÚN no se han
  //     pasado. Es el aviso predictivo, hermano del anterior: la misma previsión
  //     que ve el usuario en Análisis, pero como aviso que llega a tiempo. Como el
  //     reactivo, marca antes de devolver y sale una vez por límite y mes.
  const { data: avisosPrevision, error: errorPrevision } = await supabase.rpc("claim_budget_forecast_alerts", {
    p_month: mes,
  });
  anotarError("claim_budget_forecast_alerts", errorPrevision);

  for (const aviso of avisosPrevision ?? []) {
    anadir(aviso.user_id, {
      title: `Camino de pasarte en ${aviso.category_name}`,
      body: `A este ritmo llegarás a ${formatCents(aviso.prevision_cents)} y el tope es ${formatCents(aviso.cap_cents)}.`,
      url: "/analisis",
      tag: `prevision-${aviso.category_name}`,
    });
  }

  // 3) Salud de la ingesta del Atajo: que el dueño se entere de que sus pagos
  //    dejaron de entrar, en vez de descubrirlo días después. La función solo
  //    devuelve a quien toca —una vez por la mañana, con ventana de reposo—, y
  //    marca antes de devolver, así que un cron que dispare de más no repite.
  //
  //    Ambas señales pueden darse a la vez; el aviso las combina. El texto es
  //    accionable y manda a Ajustes, donde ya se ven los rechazos y los días
  //    que el dispositivo lleva callado.
  const { data: saludIngesta, error: errorSalud } = await supabase.rpc("claim_ingest_health_alerts", {
    p_from_hour: 9,
  });
  anotarError("claim_ingest_health_alerts", errorSalud);

  for (const fila of saludIngesta ?? []) {
    const hayRechazos = fila.many_rejections;
    const hayMudo = fila.mute_devices > 0 && fila.max_mute_days !== null;
    const dias = fila.max_mute_days ?? 0;

    // El titular lleva la cifra concreta. El rechazo va primero: hay datos que
    // arreglar hoy, y eso es más urgente que un silencio.
    const title = hayRechazos
      ? fila.rejections_24h === 1
        ? "Un pago del Atajo se ha rechazado"
        : `${fila.rejections_24h} pagos del Atajo se han rechazado`
      : `El Atajo lleva ${dias} ${dias === 1 ? "día" : "días"} sin enviar nada`;

    const body =
      hayRechazos && hayMudo
        ? "Hay envíos rechazados y el Atajo lleva días callado. Entra a Ajustes a revisarlo."
        : hayRechazos
          ? "Han llegado con algún dato que no se entiende. Entra a Ajustes a revisarlos."
          : "Puede que la automatización se haya roto. Entra a Ajustes a revisarlo.";

    anadir(fila.user_id, { title, body, url: "/ajustes", tag: "salud-ingesta" });
  }

  // 3b) Cuotas de préstamo cobradas por el cron (las que cobra el propio usuario
  //     desde la app ya salen marcadas: las está viendo). Marca antes de
  //     devolver, así que un cron que dispare de más no repite el aviso.
  const { data: cuotasCobradas, error: errorAvisosCuotas } = await supabase.rpc(
    "claim_loan_installment_notices",
  );
  anotarError("claim_loan_installment_notices", errorAvisosCuotas);

  for (const fila of cuotasCobradas ?? []) {
    const { title, body } = textoAvisoCuota({
      nombre: fila.loan_name,
      desde: fila.from_period,
      hasta: fila.to_period,
      plazo: fila.term_months,
      importe: formatCents(fila.amount_cents),
    });
    anadir(fila.user_id, { title, body, url: "/prestamos", tag: `prestamo-${fila.loan_id}` });
  }

  // 4) Reparto, con la mecánica compartida.
  let enviados = 0;
  let caducados = 0;
  let devueltos = 0;

  for (const [userId, avisos] of porUsuario) {
    const resultado = await enviarAviso(supabase, userId, avisos);
    enviados += resultado.enviados;
    caducados += resultado.caducados;

    // H-14: las funciones `claim_*` marcan el aviso como enviado ANTES del
    // push. Si el push ha fallado por algo pasajero (un 5xx, un plazo agotado)
    // y no ha llegado nada a ningún dispositivo, el aviso de las cuotas
    // cobradas —el que importa: es dinero que ha salido— se DEVUELVE para que
    // la siguiente pasada lo intente otra vez. Sin dispositivos no se devuelve:
    // no hay a quién reintentar.
    if (resultado.fallidos > 0 && resultado.enviados === 0) {
      for (const fila of (cuotasCobradas ?? []).filter((f) => f.user_id === userId)) {
        // Los tipos declaran `loan` sin UPDATE porque desde la app se cambia
        // por funciones; aquí escribe el service_role, y solo `notified_period`
        // (no es una condición del préstamo: el trigger de inmutables lo deja).
        const { error } = await (supabase.from("loan") as unknown as TablaAvisosCuota)
          .update({ notified_period: fila.from_period - 1 })
          .eq("id", fila.loan_id)
          .eq("notified_period", fila.to_period);
        if (error) console.error("notificar: no se ha podido devolver el aviso de cuota", error.message);
        else devueltos++;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    hora,
    cuotas_generadas: cuotasGeneradas ?? 0,
    ...(errorCuotas ? { error_cuotas: true } : {}),
    ...(erroresAvisos.length > 0 ? { error_avisos: erroresAvisos } : {}),
    usuarios_con_avisos: porUsuario.size,
    enviados,
    caducados,
    ...(devueltos > 0 ? { avisos_devueltos: devueltos } : {}),
  });
}

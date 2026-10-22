"use server";

import { z } from "zod";
import {
  argumentosBusqueda,
  filaLigera,
  leerConsultaDeTexto,
  MAX_DESDE,
  PASO,
  type FilaLigera,
} from "@/lib/consulta-movimientos";
import { createClient } from "@/lib/supabase/server";

/**
 * «Cargar más» de Movimientos: SOLO las filas nuevas.
 *
 * Antes cada pulsación navegaba a `?filas=N+50` y el servidor volvía a pintar
 * y mandar la lista entera desde la primera fila: con 500 movimientos, medio
 * mega de HTML por pulsación para añadir cincuenta. Ahora el cliente pide a
 * partir de lo que ya tiene y recibe datos (la fila ligera), no marcado.
 *
 * Es una lectura: no escribe nada ni revalida nada. Quien decide qué filas ve
 * cada persona es la RLS de `transaction` (la RPC es `security invoker`); sin
 * sesión, la consulta sale vacía. La entrada se valida igual que la dirección
 * de la página (mismos filtros, uuids comprobados) y el desplazamiento se
 * acota.
 *
 * `search_transactions` no tiene desplazamiento propio, solo límite: se pide
 * hasta `desde + PASO` y, con `.range()`, PostgREST devuelve solo el tramo del
 * final (más un margen, `SOLAPE`). Al navegador solo llega lo nuevo. Con
 * `.range()` además no hay corte a 1.000 filas: cada «Cargar más» es una
 * página corta, por lejos que esté.
 *
 * Lo ya cargado se descarta por fecha e id, no solo por posición. La RPC tiene
 * ya un orden total (día, hora, alta e id: migración 20261020090800), pero si
 * entre tanda y tanda entra o se borra un movimiento, las posiciones se corren
 * y cortar por posición repetiría uno o se saltaría otro. Como el orden es
 * primero por día, todo lo de días POSTERIORES al último cargado ya está en el
 * cliente; del último día, el cliente dice qué ids tiene; lo de días
 * anteriores es nuevo. El solape cubre el corrimiento.
 */
const SOLAPE = 50;
const UUID = z.string().uuid();
const entrada = z.object({
  consulta: z.string().max(2_000),
  desde: z.number().int().min(0).max(MAX_DESDE),
  ultimoDia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  idsUltimoDia: z.array(UUID).max(MAX_DESDE),
});

export async function cargarMasMovimientos(
  consulta: string,
  desde: number,
  ultimoDia: string,
  idsUltimoDia: string[],
): Promise<{ ok: true; filas: FilaLigera[] } | { ok: false; error: string }> {
  const parsed = entrada.safeParse({ consulta, desde, ultimoDia, idsUltimoDia });
  if (!parsed.success) return { ok: false, error: "Petición no válida." };

  const supabase = await createClient();
  const hasta = parsed.data.desde + PASO;
  const { data, error } = await supabase
    .rpc("search_transactions", argumentosBusqueda(leerConsultaDeTexto(parsed.data.consulta), hasta))
    .range(Math.max(0, parsed.data.desde - SOLAPE), hasta - 1);
  if (error) return { ok: false, error: "No se han podido cargar más movimientos." };

  const yaEnElDia = new Set(parsed.data.idsUltimoDia);
  const dia = parsed.data.ultimoDia;
  const nuevas = (data ?? []).filter(
    (tx) => tx.occurred_on < dia || (tx.occurred_on === dia && !yaEnElDia.has(tx.id)),
  );
  return { ok: true, filas: nuevas.map(filaLigera) };
}

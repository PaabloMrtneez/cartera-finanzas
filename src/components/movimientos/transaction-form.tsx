"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createExpenseWithSubscription,
  createTransaction,
  updateTransaction,
} from "@/app/(app)/movimientos/actions";
import { volverConTransicion } from "@/components/app/volver-con-transicion";
import { ReimbursePicker, type GastoEnlazable } from "@/components/movimientos/reimburse-picker";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectItem } from "@/components/ui/select";
import {
  borrarBorrador,
  guardarBorrador,
  leerBorrador,
  tieneContenido,
  type BorradorMovimiento,
} from "@/lib/borrador";
import { cn } from "@/lib/cn";
import { dejarRegistroReciente } from "@/lib/cuenta";
import { cargosVencidos, longDate, monthStart, nextCharge, todayIso } from "@/lib/dates";
import { llamarAccion } from "@/lib/llamar-accion";
import { formatDecimalTexto } from "@/lib/mercado";
import { formatCents, formatCentsPlain, parseAmountToCents } from "@/lib/money";
import { parseParticipaciones } from "@/lib/participaciones";
import type { Account, Category, Transaction } from "@/lib/supabase/database.types";
import {
  PERIODICITIES,
  PERIODICITY_LABELS,
  TRANSACTION_TYPE_LABELS,
  TYPE_COLOR_VAR,
  type Periodicity,
  type TransactionType,
} from "@/lib/types";

/** A partir de este número de categorías, en vez de fichas se ofrece un buscador. */
const CHIPS_LIMIT = 8;

/**
 * Lo mínimo de una posición para poder elegirla al traspasar. `instrument_id`
 * dice si sigue un fondo o una acción: entonces la aportación puede traer sus
 * participaciones.
 */
export type PosicionElegible = {
  position_id: string;
  name: string;
  account_id: string;
  instrument_id?: string | null;
};

type PropsFormulario = {
  transaction?: Transaction;
  accounts: Account[];
  /**
   * Si el movimiento es parte de un préstamo (una cuota, el desembolso…), su
   * nombre: el tipo y las cuentas no se tocan aquí —el préstamo los fija— y
   * cambiar el importe descuadra el cuadro, así que se avisa.
   */
  prestamo?: string | null;
  categories: Category[];
  /** El gasto que este ingreso reembolsa, si ya estaba enlazado. */
  reimbursed?: GastoEnlazable | null;
  /** Las posiciones vivas, para poder decir a cuál va un traspaso. */
  positions?: PosicionElegible[];
  /**
   * Las participaciones que ya trae el movimiento, como TEXTO decimal exacto
   * («12.34560000»), o null si se estiman. Solo al editar.
   */
  unidadesTexto?: string | null;
};

/**
 * El formulario de alta y edición de un movimiento.
 *
 * Al CREAR guarda un borrador en `sessionStorage` a cada cambio (lib/borrador)
 * y lo recupera al volver: una recarga, salir a otra pestaña o que el sistema
 * cierre la app ya no se llevan lo escrito. El borrador se lee DESPUÉS de
 * montar —el servidor no lo tiene y la primera pintura debe coincidir con la
 * suya— y, si lo hay, el formulario se vuelve a montar con él (el `key`).
 */
export function TransactionForm(props: PropsFormulario) {
  const [restaurado, setRestaurado] = useState<{ n: number; borrador: BorradorMovimiento | null }>({
    n: 0,
    borrador: null,
  });
  const esAlta = !props.transaction;

  useEffect(() => {
    if (!esAlta) return;
    const borrador = leerBorrador();
    // Una sola vez, al montar, y a propósito después de hidratar: leerlo en el
    // render daría una pintura distinta de la del servidor.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (borrador) setRestaurado({ n: 1, borrador });
  }, [esAlta]);

  return (
    <FormularioMovimiento
      key={restaurado.n}
      {...props}
      borrador={restaurado.borrador}
      onEmpezarDeCero={() => {
        borrarBorrador();
        setRestaurado((r) => ({ n: r.n + 1, borrador: null }));
      }}
    />
  );
}

function FormularioMovimiento({
  transaction,
  accounts,
  categories,
  reimbursed,
  positions = [],
  unidadesTexto = null,
  prestamo = null,
  borrador,
  onEmpezarDeCero,
}: PropsFormulario & {
  /** Lo recuperado de una visita anterior a «Nuevo movimiento», si lo hay. */
  borrador: BorradorMovimiento | null;
  onEmpezarDeCero: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [otro, setOtro] = useState(false);
  const [pending, startTransition] = useTransition();

  const [type, setType] = useState<TransactionType>(
    borrador?.type ?? transaction?.type ?? "EXPENSE",
  );
  const [categoryId, setCategoryId] = useState<string | null>(
    borrador ? borrador.categoryId : (transaction?.category_id ?? null),
  );
  const [search, setSearch] = useState("");
  const [reembolsa, setReembolsa] = useState<GastoEnlazable | null>(
    borrador ? borrador.reembolsa : (reimbursed ?? null),
  );
  // Se sigue el importe escrito solo para poder adelantar cuánto quedará el
  // gasto enlazado. El campo sigue siendo no controlado, para que `field-sizing`
  // pueda crecer con el contenido.
  const importeInicial = borrador
    ? borrador.campos.amount
    : transaction
      ? formatCentsPlain(transaction.amount_cents)
      : "";
  const [importeTexto, setImporteTexto] = useState(importeInicial);

  const isTransfer = type === "TRANSFER";
  const isIncome = type === "INCOME";
  const color = TYPE_COLOR_VAR[type];
  const bloqueado = prestamo !== null && transaction !== undefined;

  /*
    Las cuentas de un préstamo no se eligen a mano: su saldo es la deuda, y lo
    que entra o sale de ella lo apunta el préstamo (el desembolso, el capital
    de cada cuota). Solo se conservan las que ya lleva este movimiento, para
    poder enseñarlas.
  */
  const cuentasElegibles = useMemo(
    () =>
      accounts.filter(
        (a) =>
          a.type !== "PRESTAMO" ||
          a.id === transaction?.account_id ||
          a.id === transaction?.to_account_id,
      ),
    [accounts, transaction?.account_id, transaction?.to_account_id],
  );

  // Un gasto fijo solo puede ser un gasto: el generador de cargos crea
  // gastos y nada más. Y solo al crear, no al editar: convertir un movimiento
  // que ya existe en recurrente es otra operación, y se hace desde su pantalla.
  const puedeRepetirse = type === "EXPENSE" && !transaction;
  const [seRepite, setSeRepite] = useState(borrador?.seRepite ?? false);
  const [periodicidad, setPeriodicidad] = useState<Periodicity>(() => {
    const guardada = borrador?.periodicidad;
    return PERIODICITIES.find((p) => p === guardada) ?? "MENSUAL";
  });
  const [fecha, setFecha] = useState(borrador?.fecha ?? transaction?.occurred_on ?? todayIso());

  /*
    El destino del traspaso SÍ se sigue en estado, al contrario que el origen.

    De él depende que haya posiciones que ofrecer: si el dinero va a una cuenta
    de inversión, hay que poder decir a cuál de sus posiciones. Sin esto, el
    campo `position_id` de la base no lo escribía nadie, y sin él el rendimiento
    de Inversiones no tiene coste contra el que medirse: sale «Aportado 0,00 €»
    por mucho que hayas metido dinero.
  */
  const [destino, setDestino] = useState(borrador?.destino ?? transaction?.to_account_id ?? "");

  /*
    La cuenta (el origen, en un traspaso) también va en estado, y los dos
    desplegables son CONTROLADOS. Son Selects de Radix, no <select> nativos: al
    `form.reset()` de «Guardar y añadir otro» vuelven solos a su valor inicial
    (escuchan el `reset` del formulario), y antes se restauraban buscando un
    <select> que ya no existe, así que la cuenta elegida se perdía. Con el
    valor en estado basta con volver a ponerlo después del reset.
  */
  const [cuenta, setCuenta] = useState(
    borrador?.campos.account_id || transaction?.account_id || "",
  );
  const posicionesDelDestino = useMemo(
    () => positions.filter((p) => p.account_id === destino),
    [positions, destino],
  );

  /*
    La posición elegida también va en estado: si sigue un fondo o una acción, la
    aportación puede decir cuántas participaciones compró. Es opcional: si se
    deja vacío, la base las estima con el precio de ese día y lo marca.
  */
  const [posicionId, setPosicionId] = useState(
    borrador?.posicionId ?? transaction?.position_id ?? "",
  );
  const posicionElegida = posicionesDelDestino.find((p) => p.position_id === posicionId) ?? null;
  const pideParticipaciones = isTransfer && !!posicionElegida?.instrument_id;
  const [unidadesError, setUnidadesError] = useState<string | null>(null);

  // Cuántos cargos han vencido ya entre la fecha del gasto y hoy. Con una fecha
  // vieja no hay «el siguiente cargo»: el generador recupera todos los
  // atrasados, y eso hay que decirlo antes y no después.
  const atrasados = useMemo(() => cargosVencidos(fecha, periodicidad), [fecha, periodicidad]);

  // Al cambiar de tipo, la categoría elegida deja de ser válida: las categorías
  // están tipadas y la base de datos rechazaría la combinación.
  const options = useMemo(() => categories.filter((c) => c.type === type), [categories, type]);
  const validCategory = options.some((c) => c.id === categoryId) ? categoryId : null;

  function changeType(next: TransactionType) {
    setType(next);
    setCategoryId(null);
    setSearch("");
    // El enlace de reembolso solo vive en un ingreso: al dejar de serlo, se cae.
    if (next !== "INCOME") setReembolsa(null);
    // Y la recurrencia solo vive en un gasto.
    if (next !== "EXPENSE") setSeRepite(false);
  }

  const shown = search.trim()
    ? options.filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  const formulario = useRef<HTMLFormElement>(null);
  /** La clave de idempotencia del alta en curso (ver `guardar`). */
  const clientId = useRef<string | null>(null);
  const importe = useRef<HTMLInputElement>(null);

  /*
    ¿Hay algo que se perdería al salir? Al crear, lo dice el contenido del
    borrador (cambiar solo el tipo o la cuenta no cuenta). Al editar, cualquier
    campo tocado. Decide si «Cancelar» pide un segundo toque.
  */
  const [hayCambios, setHayCambios] = useState(borrador !== null);

  /** Lo que hay ahora en el formulario, con la forma del borrador. */
  function instantanea(): BorradorMovimiento | null {
    const form = formulario.current;
    if (!form) return null;
    const fd = new FormData(form);
    const campo = (nombre: string) => String(fd.get(nombre) ?? "");
    return {
      type,
      categoryId: validCategory,
      fecha,
      reembolsa,
      seRepite,
      periodicidad,
      destino,
      posicionId,
      campos: {
        amount: campo("amount"),
        description: campo("description"),
        occurred_time: campo("occurred_time"),
        account_id: campo("account_id"),
        note: campo("note"),
        position_units: campo("position_units"),
      },
    };
  }

  /** En cada cambio del formulario. Síncrono: una recarga puede venir justo después. */
  function alCambiar() {
    if (transaction) {
      setHayCambios(true);
      return;
    }
    const b = instantanea();
    if (!b) return;
    guardarBorrador(b);
    setHayCambios(tieneContenido(b));
  }

  // Lo que vive en el estado de React (fichas, segmentados, la fecha…) también
  // se guarda: no todo pasa por un evento `input` del formulario.
  //
  // Solo si hay algo que guardar: al montar, el formulario vacío borraría el
  // borrador antes de que `TransactionForm` llegue a leerlo (los efectos del
  // hijo corren antes que los del padre).
  useEffect(() => {
    if (transaction || pending) return;
    const b = instantanea();
    if (b && (hayCambios || tieneContenido(b))) guardarBorrador(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, validCategory, fecha, reembolsa, seRepite, periodicidad, destino, posicionId]);

  /*
    El foco en el importe se pone a mano, y no con `autoFocus`.

    Al crear, la pantalla entra como hoja: arranca 72 dvh por debajo y sube. Si
    el navegador enfoca el campo mientras sigue ahí abajo, arrastra el scroll
    del documento persiguiéndolo, y al acabar la animación te encuentras la
    página desplazada hasta el fondo. `preventScroll` es lo único que lo evita;
    `autoFocus` no admite esa opción. Es el mismo problema que ya está resuelto
    así en el diálogo.

    Y solo AL CREAR. Al editar, este formulario vive a media pantalla del
    detalle: robar el foco allí desplazaba la página hasta el campo y levantaba
    el teclado sobre un movimiento que habías abierto para mirarlo.
  */
  useEffect(() => {
    if (!transaction) importe.current?.focus({ preventScroll: true });
  }, [transaction]);

  // Al cambiar de tipo, la cifra cambia de color. Pero Chrome NO repinta el
  // `::placeholder` de un input vacío y sin foco cuando solo cambia su `color`
  // (el «0,00» se quedaba del color del tipo anterior hasta hacer clic). Con el
  // campo vacío se fuerza el repintado alternando el atributo `placeholder`.
  useEffect(() => {
    const el = importe.current;
    if (!el || el.value !== "") return;
    const ph = el.placeholder;
    el.placeholder = "";
    void el.offsetWidth;
    el.placeholder = ph;
  }, [type]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    guardar(false);
  }

  /**
   * `seguir` decide qué pasa después: volver a la lista, o dejar el formulario
   * limpio para el siguiente. Lo que se guarda es idéntico en los dos casos.
   */
  function guardar(seguir: boolean) {
    const form = formulario.current;
    if (!form) return;
    // Con el botón de «añadir otro», que es type="button", el navegador no
    // valida solo: hay que pedírselo, o se enviaría un importe vacío.
    if (!form.reportValidity()) return;

    setError(null);
    setOtro(seguir);
    const formData = new FormData(form);
    // H-22: la clave de idempotencia del alta. Un uuid por formulario, creado
    // al primer envío (no al pintar: el servidor y el navegador darían dos
    // distintos) y REUTILIZADO en los reintentos, para que un doble toque o
    // una respuesta perdida no guarden el movimiento dos veces.
    if (!transaction) {
      clientId.current ??= crypto.randomUUID();
      formData.set("client_id", clientId.current);
    }

    startTransition(async () => {
      // Sin red, el fallo vuelve como un `{ ok: false }` más: el formulario se
      // queda como estaba y el botón, listo para reintentar (ver llamar-accion).
      const result = await llamarAccion(() =>
        transaction
          ? updateTransaction(transaction.id, formData)
          : seRepite
            ? createExpenseWithSubscription(formData)
            : createTransaction(formData),
      );

      if (!result.ok) {
        setError(result.error);
        setOtro(false);
        return;
      }

      // Guardado: el borrador ya no hace falta.
      if (!transaction) borrarBorrador();
      setHayCambios(false);

      // Deja la señal para que la cifra afectada «cuente» al llegar a Resumen.
      // Solo al CREAR (registrar), no al editar, y solo en los casos de cuenta
      // limpia: un gasto sube el «Gasto del mes»; un ingreso que NO reembolsa
      // sube «Ingresos». Un traspaso no mueve ninguna de esas cifras
      // (invariante), y un ingreso que reembolsa ABARATA un gasto en vez de
      // sumar a ingresos, así que ninguno de los dos deja señal.
      if (!transaction) {
        const cents = parseAmountToCents(String(formData.get("amount") ?? ""));
        if (cents !== null && cents > 0) {
          if (type === "EXPENSE") {
            dejarRegistroReciente({ tipo: "EXPENSE", delta: cents, mes: monthStart(fecha) });
          } else if (type === "INCOME" && !reembolsa) {
            dejarRegistroReciente({ tipo: "INCOME", delta: cents, mes: monthStart(fecha) });
          }
        }
      }

      if (seguir) {
        // Se limpia lo que cambia en cada movimiento —importe, descripción,
        // nota— y se conserva lo que en una tanda se repite: cuenta, categoría
        // y fecha. Volver a elegirlos cada vez es justo el trabajo que este
        // botón viene a quitar.
        //
        // La categoría, la fecha, el tipo y las cuentas viven en el estado de
        // React. Los desplegables de cuenta (Radix) se vuelven a su valor
        // inicial al oír el `reset`: se les devuelve el elegido justo después.
        const cuentaElegida = cuenta;
        const destinoElegido = destino;

        form.reset();
        // `reset` vuelve a los valores de partida, y si el formulario arrancó
        // de un borrador esos valores son los del borrador: se vacían a mano.
        for (const nombre of ["amount", "description", "note", "position_units"]) {
          const el = form.querySelector<HTMLInputElement>("#" + nombre);
          if (el) el.value = "";
        }
        const hora = form.querySelector<HTMLInputElement>("#occurred_time");
        if (hora) hora.value = "00:00";
        // El siguiente movimiento es otro alta: lleva su propia clave.
        clientId.current = null;
        setImporteTexto("");
        setSeRepite(false);
        setOtro(false);

        setCuenta(cuentaElegida);
        setDestino(destinoElegido);

        form.querySelector<HTMLInputElement>("#amount")?.focus();
        return;
      }

      router.push("/movimientos");
    });
  }

  return (
    <form
      ref={formulario}
      onSubmit={onSubmit}
      onInput={alCambiar}
      onChange={alCambiar}
      className="@container flex flex-col gap-5"
    >
      {borrador ? (
        <div className="flex items-center gap-3 rounded-md bg-surface-2 py-2 pr-2 pl-3">
          <span className="shrink-0 text-accent-text">
            <Icon name="undo-2" size={16} />
          </span>
          <p className="min-w-0 flex-1 text-[13px] leading-[18px] text-muted">
            Hemos recuperado lo que estabas escribiendo.
          </p>
          <Button
            variant="ghost"
            size="compact"
            className="shrink-0 text-accent-text"
            onClick={onEmpezarDeCero}
          >
            Empezar de cero
          </Button>
        </div>
      ) : null}
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="category_id" value={validCategory ?? ""} />

      {bloqueado ? (
        <p className="flex items-start gap-2 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted">
          <span className="mt-[1px] shrink-0">
            <Icon name="lock" size={15} />
          </span>
          <span>
            <span className="font-semibold text-fg">
              {TRANSACTION_TYPE_LABELS[type]} del préstamo {prestamo}.
            </span>{" "}
            El tipo y las cuentas los fija el préstamo y no se cambian aquí.
          </span>
        </p>
      ) : (
        <Segmented
          label="Tipo de movimiento"
          value={type}
          onChange={changeType}
          options={[
            { value: "EXPENSE", label: "Gasto", color: TYPE_COLOR_VAR.EXPENSE },
            { value: "INCOME", label: "Ingreso", color: TYPE_COLOR_VAR.INCOME },
            { value: "TRANSFER", label: "Traspaso", color: TYPE_COLOR_VAR.TRANSFER },
          ]}
        />
      )}

      {/* El importe, en grande y teñido con el color semántico del tipo. */}
      <div className="flex flex-col items-center gap-1 py-2 lg:items-start">
        <Label htmlFor="amount">Importe</Label>
        <div className="flex items-baseline gap-2">
          <input
            id="amount"
            name="amount"
            inputMode="decimal"
            required
            ref={importe}
            defaultValue={importeInicial}
            onChange={(event) => setImporteTexto(event.target.value)}
            placeholder="0,00"
            style={{ color, fieldSizing: "content" } as React.CSSProperties}
            className={cn(
              "min-w-[2.6ch] max-w-[280px] border-0 bg-transparent p-0",
              "cifra text-[52px] leading-[58px]",
              "placeholder:opacity-40 focus:outline-none",
            )}
          />
          <span
            className="text-[28px] font-semibold tabular-nums"
            style={{ color }}
            aria-hidden
          >
            €
          </span>
        </div>
        <p className="text-[13px] leading-[18px] text-muted">
          Con coma para los decimales: 12,40.
        </p>
        {bloqueado &&
        transaction &&
        parseAmountToCents(importeTexto) !== null &&
        parseAmountToCents(importeTexto) !== transaction.amount_cents ? (
          <p className="flex items-start gap-2 text-[13px] leading-[18px] text-warning">
            <Icon name="triangle-alert" size={14} />
            <span>
              El cuadro del préstamo no se recalcula: con otro importe, lo que debes dejará de cuadrar
              con él.
            </span>
          </p>
        ) : null}
      </div>

      {/*
        Dos columnas según el ancho del FORMULARIO, no el de la ventana. El
        mismo formulario vive en «Nuevo movimiento» (unos 700 px) y en la
        columna de edición del detalle (440 px), los dos en escritorio: con
        `lg:` el del detalle también se partía en dos y a la fecha y la hora
        les tocaban 90 px, con «25/10/» y «02:4» cortados. A partir de 38rem
        caben dos columnas con la fecha y la hora enteras; por debajo, una.
      */}
      <div className="grid gap-4 @[38rem]:grid-cols-2">
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor="description">Descripción</Label>
          <Input
            id="description"
            name="description"
            maxLength={200}
            defaultValue={borrador?.campos.description ?? transaction?.description ?? ""}
            placeholder={isTransfer ? "Traspaso a ahorro" : "Compra en el súper"}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="occurred_on">Fecha</Label>
            <Input
              id="occurred_on"
              name="occurred_on"
              type="date"
              required
              value={fecha}
              onChange={(event) => setFecha(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="occurred_time">Hora</Label>
            <Input
              id="occurred_time"
              name="occurred_time"
              type="time"
              defaultValue={
                borrador?.campos.occurred_time ||
                (transaction?.occurred_time ?? "00:00").slice(0, 5)
              }
            />
          </div>
        </div>

        <div className="flex flex-col gap-[6px]">
          {/* En un traspaso la cuenta deja de ser «la cuenta» y pasa a ser el origen. */}
          <Label htmlFor="account_id">{isTransfer ? "Origen" : "Cuenta"}</Label>
          <AccountSelect
            id="account_id"
            name={bloqueado ? undefined : "account_id"}
            accounts={cuentasElegibles}
            value={cuenta}
            disabled={bloqueado}
            onValueChange={(value) => {
              setCuenta(value);
              // El valor llega al <select> oculto un instante después: el
              // borrador se guarda en la siguiente vuelta.
              queueMicrotask(alCambiar);
            }}
          />
          {/* Un campo deshabilitado no viaja en el formulario: va aparte. */}
          {bloqueado && transaction ? (
            <input type="hidden" name="account_id" value={transaction.account_id} />
          ) : null}
        </div>

        {isTransfer ? (
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="to_account_id">Destino</Label>
            {bloqueado && transaction?.to_account_id ? (
              <input type="hidden" name="to_account_id" value={transaction.to_account_id} />
            ) : null}
            <AccountSelect
              id="to_account_id"
              name={bloqueado ? undefined : "to_account_id"}
              accounts={cuentasElegibles}
              disabled={bloqueado}
              value={destino}
              onValueChange={(value) => {
                setDestino(value);
                // El desplegable de posición se rehace con la cuenta nueva.
                setPosicionId("");
              }}
            />
          </div>
        ) : null}
      </div>

      {/*
        Solo aparece cuando el destino tiene posiciones. Dejarlo en «ninguna» es
        una respuesta válida: el dinero se queda en la cuenta sin desplegar, que
        es justo lo que Patrimonio cuenta aparte.
      */}
      {isTransfer && posicionesDelDestino.length > 0 ? (
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor="position_id">¿A qué posición?</Label>
          {/*
            El `key` fuerza a rehacer el desplegable al cambiar de cuenta. Sin
            él, al pasar de una cuenta de inversión a otra se quedaría marcada
            una posición que ya no está entre las opciones.
          */}
          <Select
            key={destino}
            id="position_id"
            aria-label="¿A qué posición?"
            value={posicionId || "__ninguna"}
            onValueChange={(v) => setPosicionId(v === "__ninguna" ? "" : v)}
          >
            <SelectItem value="__ninguna">Se queda en la cuenta, sin desplegar</SelectItem>
            {posicionesDelDestino.map((p) => (
              <SelectItem key={p.position_id} value={p.position_id}>
                {p.name}
              </SelectItem>
            ))}
          </Select>
          {/* Lo que viaja es el id —o "" si se queda en la cuenta—; el centinela
              «__ninguna» es solo de la interfaz. */}
          <input type="hidden" name="position_id" value={posicionId} />
          <p className="text-[13px] leading-[18px] text-muted">
            Es lo que hace que Inversiones sepa cuánto has metido, y por tanto cuánto ha rendido.
          </p>
        </div>
      ) : null}

      {/*
        Las participaciones de la aportación, solo si la posición sigue un fondo o
        una acción. Texto con coma decimal, tal cual lo da el bróker: nunca pasa
        por un número (lib/participaciones.ts). Vacío es una respuesta válida.
      */}
      {pideParticipaciones ? (
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor="position_units">Participaciones compradas (opcional)</Label>
          <Input
            id="position_units"
            name="position_units"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={
              borrador?.campos.position_units ||
              (transaction?.position_id === posicionId && unidadesTexto
                ? formatDecimalTexto(unidadesTexto)
                : "")
            }
            placeholder="12,345678"
            aria-invalid={unidadesError ? true : undefined}
            aria-describedby="position_units_ayuda"
            onBlur={(event) => {
              const texto = event.target.value;
              if (texto.trim() === "") return setUnidadesError(null);
              const lectura = parseParticipaciones(texto);
              setUnidadesError(lectura.ok ? null : lectura.error);
            }}
            className="tabular-nums"
          />
          <p id="position_units_ayuda" className="text-[13px] leading-[18px] text-muted">
            Las que diga la orden de {posicionElegida?.name}. Si lo dejas vacío, se estimarán con
            el precio de ese día; podrás corregirlas.
          </p>
          <FieldError>{unidadesError}</FieldError>
        </div>
      ) : isTransfer && transaction?.position_id === posicionId && unidadesTexto ? (
        // Si la posición ya no sigue nada, las participaciones que tenía se
        // conservan tal cual: editar otra cosa no reescribe la historia.
        <input type="hidden" name="position_units" value={unidadesTexto} />
      ) : null}

      <div className="flex flex-col gap-2">
        <Label>Categoría</Label>

        {options.length === 0 ? (
          <p className="text-[13px] leading-[18px] text-muted">
            Todavía no tienes categorías de {TRANSACTION_TYPE_LABELS[type].toLowerCase()}. Puedes
            guardarlo sin categorizar y clasificarlo después.
          </p>
        ) : options.length > CHIPS_LIMIT ? (
          <>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              type="search"
              autoComplete="off"
              enterKeyHint="search"
              placeholder="Busca una categoría…"
              aria-label="Buscar categoría"
            />
            <CategoryChips value={validCategory} onChange={setCategoryId} categories={shown} />
          </>
        ) : (
          <CategoryChips value={validCategory} onChange={setCategoryId} categories={options} />
        )}
      </div>

      {isTransfer ? (
        <p className="flex items-start gap-2 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted">
          <Icon name="arrow-left-right" size={16} />
          Un traspaso no es gasto ni ingreso: mueve dinero entre tus cuentas y no entra en el
          balance del mes ni en el reparto por categorías.
        </p>
      ) : null}

      {/*
        Declarar aquí que un gasto se repite ahorra el viaje a Fijos y
        volver a escribir lo mismo. Solo aparece en un gasto: el generador de
        cargos crea gastos, así que un ingreso o un traspaso no pueden repetirse.
      */}
      {puedeRepetirse ? (
        <div className="flex flex-col gap-3 rounded-md bg-surface-2 p-3">
          <button
            type="button"
            onClick={() => setSeRepite(!seRepite)}
            aria-pressed={seRepite}
            className="flex items-start gap-3 text-left"
          >
            <span
              className={cn(
                "mt-[2px] flex size-[20px] shrink-0 items-center justify-center rounded-xs",
                seRepite ? "bg-accent text-accent-ink" : "bg-surface text-transparent",
              )}
            >
              <Icon name="check" size={13} />
            </span>
            <span className="flex flex-col">
              <span className="text-[15px] font-semibold">Se repite</span>
              <span className="text-[13px] leading-[18px] text-muted">
                Netflix, el gimnasio, el seguro. Se dará de alta como gasto fijo y los
                siguientes cargos entrarán solos.
              </span>
            </span>
          </button>

          {seRepite ? (
            <>
              <input type="hidden" name="periodicity" value={periodicidad} />
              <Segmented
                label="Cada cuánto"
                value={periodicidad}
                onChange={setPeriodicidad}
                options={PERIODICITIES.map((p) => ({ value: p, label: PERIODICITY_LABELS[p] }))}
              />
              {atrasados === 0 ? (
                <p className="text-[13px] leading-[18px] text-muted">
                  Se guardará este gasto del {longDate(fecha)} y el siguiente cargo se creará solo
                  el {longDate(nextCharge(fecha, periodicidad))}.
                </p>
              ) : (
                /*
                  Con una fecha vieja no hay «el siguiente cargo»: hay varios
                  vencidos, y el generador los recupera todos. Decir «se creará el
                  28 de febrero» sería mentir por omisión sobre los otros cinco.
                */
                <p className="flex items-start gap-2 text-[13px] leading-[18px] text-warning">
                  <Icon name="triangle-alert" size={14} />
                  <span>
                    Como el gasto es del {longDate(fecha)},{" "}
                    {atrasados === 1
                      ? "ya ha vencido otro cargo desde entonces y se apuntará también"
                      : `ya han vencido otros ${atrasados} cargos desde entonces y se apuntarán también`}
                    . Si no quieres eso, pon la fecha del último cargo que hayas pagado.
                  </span>
                </p>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {/*
        La fila se muestra siempre, apagada cuando no es un ingreso. Enseñar que
        existe pero no aplica explica el modelo mejor que esconderla.
      */}
      <div className="flex flex-col gap-2">
        <Label>Reembolso</Label>
        <ReimbursePicker value={reembolsa} onChange={setReembolsa} disabled={!isIncome} />
      </div>

      {isIncome && reembolsa ? <VistaPreviaNeto gasto={reembolsa} importe={importeTexto} /> : null}

      <div className="flex flex-col gap-[6px]">
        <Label htmlFor="note">Nota</Label>
        <Input
          id="note"
          name="note"
          maxLength={500}
          defaultValue={borrador?.campos.note ?? transaction?.note ?? ""}
          placeholder="Opcional"
        />
      </div>

      <FieldError>{error}</FieldError>

      <div className="flex gap-3 lg:justify-end">
        {/*
          Con algo escrito, «Cancelar» pide un segundo toque («Descartar»): es
          lo único que tira el borrador a propósito. Sin cambios, sale al primero.
        */}
        {hayCambios ? (
          <BotonConfirmar
            block
            confirmar="Descartar"
            onConfirm={() => {
              if (!transaction) borrarBorrador();
              volverConTransicion(router);
            }}
          >
            Cancelar
          </BotonConfirmar>
        ) : (
          <Button
            type="button"
            variant="secondary"
            block
            onClick={() => {
              if (!transaction) borrarBorrador();
              volverConTransicion(router);
            }}
          >
            Cancelar
          </Button>
        )}
        {/*
          «Guardar y añadir otro» solo al crear y solo en escritorio, como en el
          prototipo: es para meter varios de golpe delante del teclado, y en un
          móvil un tercer botón en la fila deja los tres por debajo de los 44 px
          de toque.
        */}
        {!transaction ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            className="hidden lg:inline-flex"
            onClick={() => guardar(true)}
          >
            {pending && otro ? "Guardando…" : "Guardar y añadir otro"}
          </Button>
        ) : null}
        <Button type="submit" disabled={pending} block>
          {pending ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Adelanta cuánto acabará costando el gasto enlazado. Es el concepto que
 * recorre toda la app: lo que pagaste frente a lo que te costó de verdad.
 */
function VistaPreviaNeto({ gasto, importe }: { gasto: GastoEnlazable; importe: string }) {
  const devuelto = parseAmountToCents(importe);
  if (devuelto === null || devuelto <= 0) return null;

  const neto = gasto.amount_cents - devuelto;
  const excede = neto < 0;

  return (
    <p className="flex items-start gap-2 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted">
      <span className={excede ? "text-warning" : "text-accent"}>
        <Icon name={excede ? "triangle-alert" : "undo-2"} size={16} />
      </span>
      <span>
        {excede ? (
          <>
            Estás devolviendo más de lo que costó «{gasto.description}»:{" "}
            {formatCents(devuelto)} sobre {formatCents(gasto.amount_cents)}. Se puede guardar, pero
            revisa si de verdad es un reembolso.
          </>
        ) : (
          <>
            «{gasto.description}» pasará a costarte{" "}
            <span className="font-semibold text-fg tabular-nums">{formatCents(neto)}</span> en lugar
            de <span className="tabular-nums">{formatCents(gasto.amount_cents)}</span>.
          </>
        )}
      </span>
    </p>
  );
}

function AccountSelect({
  accounts,
  ...props
}: {
  accounts: Account[];
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select required placeholder="Elige una cuenta" {...props}>
      {accounts.map((account) => (
        <SelectItem key={account.id} value={account.id}>
          {account.name}
        </SelectItem>
      ))}
    </Select>
  );
}

function CategoryChips({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {categories.map((category) => {
        const selected = category.id === value;
        return (
          <button
            key={category.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? null : category.id)}
            className={cn(
              "flex min-h-11 items-center gap-2 rounded-full py-[6px] pr-[14px] pl-2",
              "text-[15px] transition-colors duration-150 ease-ui",
              selected ? "bg-accent-soft font-semibold text-fg" : "bg-surface-2 text-muted",
            )}
          >
            <span
              className="flex size-[30px] items-center justify-center rounded-full tint-16"
              style={{ color: category.color }}
            >
              <Icon name={category.icon} size={16} />
            </span>
            {category.name}
          </button>
        );
      })}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { createCard, deleteCard, updateCard } from "@/app/(app)/cuentas/actions";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import type { Card } from "@/lib/supabase/database.types";
import { CARD_TYPES, CARD_TYPE_LABELS, type CardType } from "@/lib/types";
import { llamarAccion } from "@/lib/llamar-accion";

/**
 * Gestión de las tarjetas de una cuenta, dentro del diálogo de edición.
 *
 * Cada operación —añadir, editar, borrar— es una acción de servidor inmediata,
 * no un cambio que espera al «Guardar» de la cuenta: una tarjeta necesita el
 * `account_id` de una cuenta que YA existe (la clave foránea lo exige), así que
 * solo se gestionan aquí, sobre una cuenta guardada. Al crear una cuenta nueva,
 * en su lugar se enseña una nota: las tarjetas llegan cuando la cuenta existe.
 *
 * La lista local es la fuente de verdad mientras el diálogo está abierto, y se
 * actualiza con lo que devuelve cada acción. La pantalla de Cuentas y el Atajo
 * se ponen al día solos: cada acción revalida sus rutas, y la respuesta de la
 * acción ya trae la pantalla actual repintada (un `router.refresh()` encima la
 * volvía a pedir entera).
 */
export function CardManager({ accountId, cards: iniciales }: { accountId: string; cards: Card[] }) {
  const [cards, setCards] = useState<Card[]>(iniciales);
  // `null` = nada abierto; "nueva" = el editor de alta; un id = editando esa una.
  const [editando, setEditando] = useState<string | "nueva" | null>(null);
  const [borrando, startBorrado] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function trasGuardar(card: Card) {
    setCards((prev) => {
      const resto = prev.filter((c) => c.id !== card.id);
      return [...resto, card].sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
    setEditando(null);
    setError(null);
  }

  function borrar(card: Card) {
    setError(null);
    startBorrado(async () => {
      const result = await llamarAccion(() => deleteCard(card.id), "borrado");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCards((prev) => prev.filter((c) => c.id !== card.id));
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>Tarjetas</Label>
      <p className="text-[13px] leading-[18px] text-muted">
        Cada tarjeta son sus cuatro últimos dígitos: el Atajo del iPhone manda a esta cuenta los
        pagos que lleguen con ellos. Todas gastan de su saldo; el tipo es solo una etiqueta.
      </p>

      <div className="hair border-hairline rounded-md">
        {cards.length === 0 && editando !== "nueva" ? (
          <p className="px-3 py-3 text-[13px] leading-[18px] text-muted">
            Todavía no hay ninguna tarjeta en esta cuenta.
          </p>
        ) : null}

        {cards.length > 0 ? (
          <ul>
            {cards.map((card) =>
              editando === card.id ? (
                <li key={card.id} className="hair-t border-separator first:border-t-0">
                  <CardEditor card={card} onDone={trasGuardar} onCancel={() => setEditando(null)} />
                </li>
              ) : (
                <li
                  key={card.id}
                  className="flex items-center gap-2 hair-t border-separator px-3 py-[9px] first:border-t-0"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px] font-semibold tabular-nums">···{card.last4}</span>
                    <span className="truncate text-[13px] leading-[18px] text-muted">
                      {CARD_TYPE_LABELS[card.type]}
                      {card.nickname ? ` · ${card.nickname}` : ""}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Editar la tarjeta acabada en ${card.last4}`}
                    onClick={() => setEditando(card.id)}
                    disabled={borrando}
                  >
                    <Icon name="pencil" size={16} />
                  </Button>
                  <BotonConfirmar
                    variant="ghost"
                    size="icon"
                    confirmar="Borrar"
                    aria-label={`Borrar la tarjeta acabada en ${card.last4}`}
                    onConfirm={() => borrar(card)}
                    disabled={borrando}
                    className="text-expense"
                  >
                    <Icon name="trash-2" size={16} />
                  </BotonConfirmar>
                </li>
              ),
            )}
          </ul>
        ) : null}

        {editando === "nueva" ? (
          <div className="hair-t border-separator first:border-t-0">
            <CardEditor accountId={accountId} onDone={trasGuardar} onCancel={() => setEditando(null)} />
          </div>
        ) : null}
      </div>

      <FieldError>{error}</FieldError>

      {editando === "nueva" ? null : (
        <Button
          variant="secondary"
          size="compact"
          onClick={() => setEditando("nueva")}
          className="self-start"
        >
          <Icon name="plus" size={15} />
          Añadir tarjeta
        </Button>
      )}
    </div>
  );
}

/**
 * El editor de una tarjeta, para alta (`accountId`) o edición (`card`). No es un
 * `<form>` propio —vive dentro del formulario de la cuenta y anidar formularios
 * es HTML inválido—: sus campos son controlados y el guardado va por su botón.
 * Un Intro en un campo de texto guarda la tarjeta sin enviar el de la cuenta.
 */
function CardEditor({
  card,
  accountId,
  onDone,
  onCancel,
}: {
  card?: Card;
  accountId?: string;
  onDone: (card: Card) => void;
  onCancel: () => void;
}) {
  const [last4, setLast4] = useState(card?.last4 ?? "");
  const [type, setType] = useState<CardType>(card?.type ?? "DEBITO");
  const [nickname, setNickname] = useState(card?.nickname ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function guardar() {
    setError(null);
    const formData = new FormData();
    formData.set("last4", last4);
    formData.set("type", type);
    formData.set("nickname", nickname);

    startTransition(async () => {
      let result;
      if (card) {
        result = await llamarAccion(() => updateCard(card.id, formData));
      } else {
        formData.set("account_id", accountId ?? "");
        result = await llamarAccion(() => createCard(formData));
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone(result.card);
    });
  }

  return (
    <div
      className="flex flex-col gap-3 px-3 py-3"
      onKeyDown={(event) => {
        // Intro en un campo de texto guarda la tarjeta; sin esto burbujearía al
        // formulario de la cuenta y lo enviaría por error.
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          guardar();
        }
      }}
    >
      <div className="flex flex-col gap-[6px]">
        <Label htmlFor="card-last4">Últimos 4 dígitos</Label>
        <Input
          id="card-last4"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={last4}
          onChange={(event) => setLast4(event.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="1234"
          className="tabular-nums"
        />
      </div>

      <div className="flex flex-col gap-[6px]">
        <Label>Tipo</Label>
        <Segmented
          label="Tipo de tarjeta"
          value={type}
          onChange={setType}
          options={CARD_TYPES.map((t) => ({ value: t, label: CARD_TYPE_LABELS[t] }))}
        />
      </div>

      <div className="flex flex-col gap-[6px]">
        <Label htmlFor="card-nickname">Alias</Label>
        <Input
          id="card-nickname"
          maxLength={40}
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="Opcional: «física», «Apple Pay»…"
        />
      </div>

      <FieldError>{error}</FieldError>

      <div className="flex gap-2">
        <Button variant="secondary" size="compact" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button size="compact" onClick={guardar} disabled={pending}>
          {pending ? "Guardando…" : card ? "Guardar" : "Añadir"}
        </Button>
      </div>
    </div>
  );
}

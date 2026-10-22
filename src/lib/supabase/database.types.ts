/**
 * Tipos del esquema, escritos a mano.
 *
 * `supabase gen types` necesita Docker para levantar un contenedor de
 * introspección, y aquí no lo hay. Mantener esto al día es responsabilidad de
 * quien toque una migración: si cambias `supabase/migrations`, cambia también
 * este fichero.
 *
 * Los importes son `number` a propósito. PostgREST serializa los `bigint` como
 * número JSON (verificado, no supuesto), y un doble representa enteros exactos
 * hasta 2^53 céntimos, que son unos 90 billones de euros. De sobra.
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type AccountType = "BANCO" | "EFECTIVO" | "AHORRO" | "INVERSION" | "PRESTAMO";
export type CardType = "DEBITO" | "CREDITO" | "PREPAGO";
export type EntryType = "EXPENSE" | "INCOME" | "TRANSFER";
export type TxSource = "SHORTCUT" | "MANUAL" | "RECURRING" | "IMPORT";
export type TxStatus = "PENDING" | "CONFIRMED" | "DISCARDED";
export type Periodicity = "SEMANAL" | "MENSUAL" | "TRIMESTRAL" | "ANUAL";
export type InstrumentKind = "FONDO" | "ETF" | "ACCION";
export type PositionEventKind = "ALTA" | "AJUSTE" | "BAJA";
/** De dónde sale el valor de una posición (private.position_value_on). */
export type FuenteValor = "MERCADO" | "RESPALDO" | "MANUAL";
/** Estado de un préstamo (loan.status, texto con CHECK). */
export type LoanStatus = "ACTIVO" | "LIQUIDADO" | "CANCELADO";
/** Parte de un préstamo a la que pertenece un movimiento (transaction.loan_part). */
export type LoanPart =
  | "DESEMBOLSO"
  | "COMISION"
  | "INTERESES"
  | "CAPITAL"
  | "LIQUIDACION"
  | "COMISION_CANCELACION";

type Timestamps = { created_at: string; updated_at: string };

export type Database = {
  public: {
    Tables: {
      profile: {
        Row: {
          user_id: string;
          display_name: string;
          last_shown_month: string | null;
          default_ingest_account_id: string | null;
        } & Timestamps;
        Insert: {
          user_id: string;
          display_name?: string;
          last_shown_month?: string | null;
          default_ingest_account_id?: string | null;
        };
        Update: {
          display_name?: string;
          last_shown_month?: string | null;
          default_ingest_account_id?: string | null;
        };
        Relationships: [];
      };

      account: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          type: AccountType;
          initial_balance_cents: number;
          color: string;
          archived: boolean;
          archived_at: string | null;
        } & Timestamps;
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          type: AccountType;
          initial_balance_cents?: number;
          color?: string;
          archived?: boolean;
          archived_at?: string | null;
        };
        Update: {
          name?: string;
          type?: AccountType;
          initial_balance_cents?: number;
          color?: string;
          archived?: boolean;
          archived_at?: string | null;
        };
        Relationships: [];
      };

      card: {
        Row: {
          id: string;
          user_id: string;
          account_id: string;
          last4: string;
          type: CardType;
          nickname: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          account_id: string;
          last4: string;
          type?: CardType;
          nickname?: string | null;
        };
        Update: {
          account_id?: string;
          last4?: string;
          type?: CardType;
          nickname?: string | null;
        };
        Relationships: [];
      };

      category: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          type: EntryType;
          color: string;
          icon: string;
        } & Timestamps;
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          type: EntryType;
          color?: string;
          icon?: string;
        };
        // `type` no está: es inmutable, y el privilegio de columna lo impide.
        Update: { name?: string; color?: string; icon?: string };
        Relationships: [];
      };

      transaction: {
        Row: {
          id: string;
          user_id: string;
          type: EntryType;
          amount_cents: number;
          description: string;
          occurred_on: string;
          occurred_time: string;
          occurred_at: string | null;
          account_id: string;
          to_account_id: string | null;
          category_id: string | null;
          category_type: EntryType | null;
          note: string | null;
          reimburses_id: string | null;
          reimburses_target_type: EntryType | null;
          source: TxSource;
          status: TxStatus;
          merchant_raw: string | null;
          card_last4: string | null;
          external_id: string | null;
          device_id: string | null;
          subscription_id: string | null;
          position_id: string | null;
          /**
           * Participaciones de la aportación. `numeric(24,8)`: PostgREST lo manda
           * como número JSON y aquí llega como doble. Sirve para ENSEÑARLO; nada
           * de dinero se calcula con él en JavaScript (el valor sale de la base).
           * Para escribirlo, mándalo como texto decimal.
           */
          position_units: number | null;
          recurring_income_id: string | null;
          /** Préstamo al que pertenece (lo escriben las funciones de préstamos). */
          loan_id: string | null;
          /** Nº de cuota; solo en las partes INTERESES y CAPITAL. */
          loan_period: number | null;
          loan_part: LoanPart | null;
          /** Clave de idempotencia del alta manual (un uuid por formulario). */
          client_id: string | null;
          period_month: string;
        } & Timestamps;
        Insert: {
          id?: string;
          user_id: string;
          type: EntryType;
          amount_cents: number;
          description?: string;
          occurred_on: string;
          occurred_time?: string;
          occurred_at?: string | null;
          account_id: string;
          to_account_id?: string | null;
          category_id?: string | null;
          category_type?: EntryType | null;
          note?: string | null;
          reimburses_id?: string | null;
          reimburses_target_type?: EntryType | null;
          source?: TxSource;
          status?: TxStatus;
          merchant_raw?: string | null;
          card_last4?: string | null;
          external_id?: string | null;
          device_id?: string | null;
          subscription_id?: string | null;
          position_id?: string | null;
          position_units?: string | null;
          recurring_income_id?: string | null;
          loan_id?: string | null;
          loan_period?: number | null;
          loan_part?: LoanPart | null;
          client_id?: string | null;
        };
        Update: {
          type?: EntryType;
          amount_cents?: number;
          description?: string;
          occurred_on?: string;
          occurred_time?: string;
          account_id?: string;
          to_account_id?: string | null;
          category_id?: string | null;
          category_type?: EntryType | null;
          note?: string | null;
          reimburses_id?: string | null;
          reimburses_target_type?: EntryType | null;
          status?: TxStatus;
          position_id?: string | null;
          position_units?: string | null;
        };
        Relationships: [];
      };

      /**
       * Préstamo personal (sistema francés). Ningún saldo: el pendiente es
       * −saldo de la cuenta-pasivo (v_loan_status) y el cuadro sale de
       * loan_plan. Se escribe SOLO con las funciones (create_loan, update_loan,
       * update_loan_terms, cancel_loan, settle_loan, delete_loan).
       * tin_pct / tae_pct son numeric(7,4): llegan como número JSON y sirven
       * para ENSEÑARLOS; para escribirlos se mandan como texto decimal.
       */
      loan: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          payment_account_id: string;
          liability_account_id: string;
          liability_account_type: AccountType;
          principal_cents: number;
          term_months: number;
          tin_pct: number;
          tae_pct: number | null;
          opening_fee_cents: number;
          charge_day: number;
          start_on: string;
          first_charge_on: string;
          disbursed: boolean;
          tracked_from_period: number;
          last_generated_period: number;
          notified_period: number;
          interest_category_id: string | null;
          interest_category_type: EntryType | null;
          status: LoanStatus;
          closed_on: string | null;
        } & Timestamps;
        Insert: never;
        Update: never;
        Relationships: [];
      };

      merchant_rule: {
        Row: {
          id: string;
          user_id: string;
          match_text: string;
          match_norm: string;
          category_id: string;
          category_type: EntryType;
          hit_count: number;
        } & Timestamps;
        Insert: {
          id?: string;
          user_id: string;
          match_text: string;
          category_id: string;
          category_type: EntryType;
        };
        Update: { match_text?: string; category_id?: string; category_type?: EntryType };
        Relationships: [];
      };

      subscription: {
        Row: {
          id: string;
          user_id: string;
          description: string;
          amount_cents: number;
          periodicity: Periodicity;
          next_charge_date: string;
          category_id: string | null;
          category_type: EntryType | null;
          account_id: string;
          active: boolean;
          started_at: string;
          last_generated_on: string | null;
          /** Día del mes en que se cobra cuando el mes lo tiene (lo mantiene un disparador). */
          anchor_day: number;
        } & Timestamps;
        Insert: {
          id?: string;
          user_id: string;
          description: string;
          amount_cents: number;
          periodicity: Periodicity;
          next_charge_date: string;
          category_id?: string | null;
          category_type?: EntryType | null;
          account_id: string;
          active?: boolean;
          started_at?: string;
          anchor_day?: number;
        };
        Update: {
          description?: string;
          amount_cents?: number;
          periodicity?: Periodicity;
          next_charge_date?: string;
          category_id?: string | null;
          category_type?: EntryType | null;
          account_id?: string;
          active?: boolean;
          started_at?: string;
          last_generated_on?: string | null;
        };
        Relationships: [];
      };

      recurring_income: {
        Row: {
          id: string;
          user_id: string;
          description: string;
          amount_cents: number;
          periodicity: Periodicity;
          next_income_date: string;
          category_id: string | null;
          category_type: EntryType | null;
          account_id: string;
          active: boolean;
          started_at: string;
          last_generated_on: string | null;
          /** Día del mes en que se cobra cuando el mes lo tiene (lo mantiene un disparador). */
          anchor_day: number;
        } & Timestamps;
        Insert: {
          id?: string;
          user_id: string;
          description: string;
          amount_cents: number;
          periodicity: Periodicity;
          next_income_date: string;
          category_id?: string | null;
          category_type?: EntryType | null;
          account_id: string;
          active?: boolean;
          started_at?: string;
          anchor_day?: number;
        };
        Update: {
          description?: string;
          amount_cents?: number;
          periodicity?: Periodicity;
          next_income_date?: string;
          category_id?: string | null;
          category_type?: EntryType | null;
          account_id?: string;
          active?: boolean;
          started_at?: string;
          last_generated_on?: string | null;
        };
        Relationships: [];
      };

      budget: {
        Row: {
          id: string;
          user_id: string;
          category_id: string;
          category_type: EntryType;
          monthly_cap_cents: number;
          warn_at_80: boolean;
          discount_reimbursements: boolean;
          rollover_unspent: boolean;
        } & Timestamps;
        Insert: {
          id?: string;
          user_id: string;
          category_id: string;
          category_type?: EntryType;
          monthly_cap_cents: number;
          warn_at_80?: boolean;
          discount_reimbursements?: boolean;
          rollover_unspent?: boolean;
        };
        Update: {
          monthly_cap_cents?: number;
          warn_at_80?: boolean;
          discount_reimbursements?: boolean;
          rollover_unspent?: boolean;
        };
        Relationships: [];
      };

      savings_goal: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          target_cents: number;
          account_id: string;
          deadline: string | null;
        } & Timestamps;
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          target_cents: number;
          account_id: string;
          deadline?: string | null;
        };
        Update: {
          name?: string;
          target_cents?: number;
          account_id?: string;
          deadline?: string | null;
        };
        Relationships: [];
      };

      budget_alert: {
        Row: {
          user_id: string;
          budget_id: string;
          period_month: string;
          threshold: number;
          notified_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };

      budget_forecast_alert: {
        Row: {
          user_id: string;
          budget_id: string;
          period_month: string;
          notified_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };

      investment_position: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          account_id: string;
          account_type: AccountType;
          color: string;
          since: string;
          archived: boolean;
        } & Timestamps;
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          account_id: string;
          account_type?: AccountType;
          color?: string;
          since?: string;
          archived?: boolean;
        };
        Update: { name?: string; color?: string; archived?: boolean };
        Relationships: [];
      };

      valuation: {
        Row: {
          id: string;
          user_id: string;
          position_id: string;
          date: string;
          value_cents: number;
          created_at: string;
          period_month: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          position_id: string;
          date: string;
          value_cents: number;
        };
        Update: { date?: string; value_cents?: number };
        Relationships: [];
      };

      instrument: {
        Row: {
          id: string;
          kind: InstrumentKind;
          isin: string | null;
          yahoo_symbol: string;
          name: string;
          currency: string;
          exchange: string | null;
        } & Timestamps;
        Insert: {
          id?: string;
          kind: InstrumentKind;
          isin?: string | null;
          yahoo_symbol: string;
          name: string;
          currency: string;
          exchange?: string | null;
        };
        Update: { isin?: string | null; name?: string; exchange?: string | null };
        Relationships: [];
      };

      instrument_price: {
        /** `close` es numeric(20,6): se escribe como texto decimal, nunca un float. */
        Row: {
          instrument_id: string;
          date: string;
          close: number;
          source: string;
          fetched_at: string;
        };
        Insert: {
          instrument_id: string;
          date: string;
          close: string;
          source?: string;
          fetched_at?: string;
        };
        Update: { close?: string; fetched_at?: string };
        Relationships: [];
      };

      fx_rate: {
        /** `rate` son unidades de `currency` por 1 EUR (BCE), numeric(20,8). */
        Row: {
          currency: string;
          date: string;
          rate: number;
          source: string;
          fetched_at: string;
        };
        Insert: {
          currency: string;
          date: string;
          rate: string;
          source?: string;
          fetched_at?: string;
        };
        Update: { rate?: string; fetched_at?: string };
        Relationships: [];
      };

      position_unit_event: {
        Row: {
          id: string;
          seq: number;
          user_id: string;
          position_id: string;
          kind: PositionEventKind;
          date: string;
          instrument_id: string | null;
          units: number | null;
          contributed_cents: number | null;
          note: string | null;
          created_at: string;
        };
        /** Solo se añade: no hay Update (ni política ni privilegio). */
        Insert: {
          id?: string;
          user_id: string;
          position_id: string;
          kind: PositionEventKind;
          date: string;
          instrument_id?: string | null;
          units?: string | null;
          contributed_cents?: number | null;
          note?: string | null;
        };
        Update: Record<never, never>;
        Relationships: [];
      };

      ingest_device: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          token_prefix: string;
          created_at: string;
          last_used_at: string | null;
          last_error_at: string | null;
          request_count: number;
          rejected_count: number;
          revoked_at: string | null;
        };
        // Se crea y se revoca con funciones dedicadas, nunca directamente.
        Insert: never;
        Update: never;
        Relationships: [];
      };

      push_subscription: {
        Row: {
          id: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent: string | null;
          created_at: string;
          last_sent_at: string | null;
          failed_at: string | null;
        };
        Insert: {
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent?: string | null;
        };
        Update: { last_sent_at?: string | null; failed_at?: string | null };
        Relationships: [];
      };

      ingest_dead_letter: {
        Row: {
          id: number;
          device_id: string | null;
          user_id: string | null;
          received_at: string;
          reason: string;
          payload: Json;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };

    Views: {
      v_account_balance: {
        Row: {
          user_id: string;
          account_id: string;
          name: string;
          type: AccountType;
          color: string;
          card_last4: string | null;
          archived: boolean;
          initial_balance_cents: number;
          balance_cents: number;
          movement_count: number;
        };
        Relationships: [];
      };

      v_account_worth: {
        Row: {
          user_id: string;
          account_id: string;
          type: AccountType;
          balance_cents: number;
          worth_cents: number;
        };
        Relationships: [];
      };

      v_savings_goal_progress: {
        Row: {
          user_id: string;
          id: string;
          name: string;
          target_cents: number;
          account_id: string;
          deadline: string | null;
          created_at: string;
          account_name: string;
          account_color: string;
          account_archived: boolean;
          saved_cents: number;
          remaining_cents: number;
          pct: number;
          reached: boolean;
        };
        Relationships: [];
      };

      v_account_movement: {
        Row: {
          user_id: string;
          account_id: string;
          transaction_id: string;
          occurred_on: string;
          period_month: string;
          delta_cents: number;
        };
        Relationships: [];
      };

      v_transaction_econ: {
        Row: {
          user_id: string;
          id: string;
          period_month: string;
          occurred_on: string;
          type: EntryType;
          amount_cents: number;
          status: TxStatus;
          econ_category_id: string | null;
          net_expense_cents: number;
          real_income_cents: number;
          is_reimbursement: boolean;
        };
        Relationships: [];
      };

      v_month_summary: {
        Row: {
          user_id: string;
          period_month: string;
          income_cents: number;
          net_expense_cents: number;
          month_balance_cents: number;
          gross_expense_cents: number | null;
          reimbursed_cents: number | null;
          unclassified_count: number;
          pending_count: number;
        };
        Relationships: [];
      };

      v_subscription_summary: {
        Row: {
          user_id: string;
          id: string;
          description: string;
          amount_cents: number;
          periodicity: Periodicity;
          next_charge_date: string;
          category_id: string | null;
          account_id: string;
          active: boolean;
          started_at: string;
          yearly_cents: number;
          monthly_cents: number;
          due: boolean;
        };
        Relationships: [];
      };

      v_recurring_income_summary: {
        Row: {
          user_id: string;
          id: string;
          description: string;
          amount_cents: number;
          periodicity: Periodicity;
          next_income_date: string;
          category_id: string | null;
          account_id: string;
          active: boolean;
          started_at: string;
          yearly_cents: number;
          monthly_cents: number;
          due: boolean;
        };
        Relationships: [];
      };

      /**
       * net_worth_cents = cash_cents + invested_cents + idle_cents + debt_cents.
       * La caja ya NO incluye las cuentas de préstamo: la deuda va en
       * debt_cents (≤ 0), el saldo de las cuentas-pasivo.
       */
      v_net_worth: {
        Row: {
          user_id: string;
          net_worth_cents: number;
          cash_cents: number;
          invested_cents: number;
          idle_cents: number;
          debt_cents: number;
        };
        Relationships: [];
      };

      /**
       * Resumen de cada préstamo. principal_pending_cents = −saldo de la
       * cuenta-pasivo (derivado de los movimientos); schedule_pending_cents es
       * el del cuadro, para comprobar que cuadran. paid_count incluye las
       * cuotas previas al alta de un préstamo «ya apuntado».
       */
      v_loan_status: {
        Row: {
          loan_id: string;
          user_id: string;
          name: string;
          status: LoanStatus;
          payment_account_id: string;
          liability_account_id: string;
          principal_cents: number;
          term_months: number;
          tin_pct: number;
          tae_pct: number | null;
          /** TAE calculada (principal − comisión frente a las cuotas), en %. */
          tae_calc_pct: number | null;
          /** La del contrato si la hay; si no, la calculada. */
          tae_effective_pct: number | null;
          opening_fee_cents: number;
          charge_day: number;
          start_on: string;
          first_charge_on: string;
          disbursed: boolean;
          tracked_from_period: number;
          payment_cents: number;
          last_payment_cents: number;
          paid_count: number;
          remaining_count: number;
          principal_pending_cents: number;
          schedule_pending_cents: number;
          principal_paid_cents: number;
          interest_total_cents: number;
          interest_paid_cents: number;
          interest_pending_cents: number;
          fees_paid_cents: number;
          /** Intereses (pagados + pendientes) + comisiones pagadas. */
          total_cost_cents: number;
          next_period: number | null;
          next_due_on: string | null;
          next_payment_cents: number | null;
          end_on: string;
          closed_on: string | null;
          interest_category_id: string | null;
        };
        Relationships: [];
      };

      v_position_value: {
        Row: {
          user_id: string;
          position_id: string;
          name: string;
          color: string;
          account_id: string;
          since: string;
          archived: boolean;
          contributed_cents: number;
          valued_on: string | null;
          value_cents: number;
          sin_valorar: boolean;
          fuente: FuenteValor;
          instrument_id: string | null;
        };
        Relationships: [];
      };

      v_position_market: {
        /**
         * Lo que la interfaz enseña de cada posición sincronizada (y de las
         * manuales, con seguida = false). Participaciones, precio y cambio son
         * numeric: llegan como doble y son para ENSEÑAR; el valor ya viene en
         * céntimos calculado en la base.
         */
        Row: {
          user_id: string;
          position_id: string;
          name: string;
          archived: boolean;
          seguida: boolean;
          instrument_id: string | null;
          yahoo_symbol: string | null;
          isin: string | null;
          instrument_name: string | null;
          instrument_kind: InstrumentKind | null;
          currency: string | null;
          exchange: string | null;
          alta_date: string | null;
          anchor_date: string | null;
          units: number | null;
          units_estimadas: boolean | null;
          price: number | null;
          price_date: string | null;
          fx_rate: number | null;
          fx_date: string | null;
          value_cents: number;
          fuente: FuenteValor;
          valued_on: string | null;
          sin_precio: boolean;
          contributed_cents: number;
          gain_cents: number;
          return_pct: number | null;
          dias_sin_precio: number | null;
          desactualizado: boolean;
        };
        Relationships: [];
      };

      v_pending_valuation: {
        Row: {
          user_id: string;
          position_id: string;
          name: string;
          last_valued_on: string | null;
        };
        Relationships: [];
      };

      v_closed_months: {
        Row: {
          user_id: string;
          period_month: string;
          income_cents: number;
          net_expense_cents: number;
          month_balance_cents: number;
          gross_expense_cents: number | null;
          reimbursed_cents: number | null;
        };
        Relationships: [];
      };

      v_rule_suggestions: {
        Row: {
          user_id: string;
          merchant: string;
          occurrences: number;
          total_cents: number;
          last_seen: string;
        };
        Relationships: [];
      };

      v_ingest_health: {
        Row: {
          user_id: string;
          rejections_24h: number;
          mute_devices: number;
          max_mute_days: number | null;
          many_rejections: boolean;
          unhealthy: boolean;
        };
        Relationships: [];
      };
    };

    Functions: {
      category_breakdown: {
        Args: { p_month: string };
        Returns: {
          category_id: string | null;
          name: string;
          color: string;
          icon: string;
          net_cents: number;
          share: number;
        }[];
      };
      apply_merchant_rule: {
        Args: { p_rule_id: string };
        Returns: number;
      };
      preview_merchant_rule: {
        Args: { p_match_text: string };
        Returns: { occurrences: number; total_cents: number }[];
      };
      create_ingest_device: {
        Args: { p_name: string };
        Returns: Json;
      };
      /**
       * Solo la puede ejecutar el rol de servicio: el Atajo no tiene sesión, se
       * autentica con su propio token de dispositivo dentro de la función.
       */
      ingest_transaction: {
        Args: { p_token: string; p_amount_cents: number; p_payload: Json };
        Returns: Json;
      };
      revoke_ingest_device: {
        Args: { p_device_id: string };
        Returns: undefined;
      };
      /**
       * Qué borraría `delete_account`, sin borrar nada. El objeto lo valida y
       * tipa `parseAccountDeletePreview` (src/lib/eliminar-cuenta.ts).
       */
      account_delete_preview: {
        Args: { p_account_id: string };
        Returns: Json;
      };
      /**
       * Borra la cuenta con todo lo suyo si `p_confirm_name` coincide con su
       * nombre (tras btrim). Devuelve los recuentos de lo borrado.
       */
      delete_account: {
        Args: { p_account_id: string; p_confirm_name: string };
        Returns: Json;
      };
      /**
       * Qué borraría `delete_position`, sin borrar nada. El objeto lo valida y
       * tipa `parsePositionDeletePreview` (src/lib/eliminar-fondo.ts).
       */
      position_delete_preview: {
        Args: { p_position_id: string };
        Returns: Json;
      };
      /**
       * Borra la posición con sus valoraciones, su libro de participaciones y
       * sus aportaciones si `p_confirm_name` coincide con su nombre (tras
       * btrim). Devuelve los recuentos de lo borrado.
       */
      delete_position: {
        Args: { p_position_id: string; p_confirm_name: string };
        Returns: Json;
      };
      /** Devuelve cuántos movimientos ha creado. */
      generate_subscription_charges: {
        Args: Record<string, never>;
        Returns: number;
      };
      budget_status: {
        Args: { p_month: string };
        Returns: {
          budget_id: string;
          category_id: string;
          name: string;
          color: string;
          icon: string;
          cap_cents: number;
          rollover_cents: number;
          effective_cap_cents: number;
          spent_cents: number;
          pct: number | null;
          warn_at_80: boolean;
          rollover_unspent: boolean;
          discount_reimbursements: boolean;
        }[];
      };
      category_avg_6m: {
        Args: { p_month: string };
        Returns: {
          category_id: string | null;
          name: string;
          color: string;
          icon: string;
          avg_cents: number;
          current_cents: number;
          months_with_data: number;
        }[];
      };
      /** Solo el rol de servicio: reclama los avisos pendientes sin repetir. */
      claim_budget_alerts: {
        Args: { p_month: string };
        Returns: {
          user_id: string;
          category_name: string;
          threshold: number;
          spent_cents: number;
          cap_cents: number;
        }[];
      };
      claim_budget_forecast_alerts: {
        Args: {
          p_month: string;
          p_min_dias?: number;
          p_frac_num?: number;
          p_frac_den?: number;
        };
        Returns: {
          user_id: string;
          category_name: string;
          prevision_cents: number;
          cap_cents: number;
        }[];
      };
      create_expense_with_subscription: {
        Args: {
          p_amount_cents: number;
          p_description: string;
          p_occurred_on: string;
          p_account_id: string;
          p_category_id: string | null;
          p_periodicity: Periodicity;
          p_note?: string | null;
          p_occurred_time?: string;
        };
        Returns: {
          transaction_id: string;
          subscription_id: string;
          next_charge_date: string;
        }[];
      };
      import_transactions: {
        Args: {
          p_account_id: string;
          p_rows: Json;
          p_skip_duplicates?: boolean;
          p_dry_run?: boolean;
        };
        Returns: {
          insertadas: number;
          duplicadas: number;
          clasificadas: number;
          sin_clasificar: number;
        }[];
      };
      search_transactions: {
        Args: {
          p_from?: string | null;
          p_to?: string | null;
          p_type?: EntryType | null;
          p_account?: string | null;
          p_category?: string | null;
          p_uncategorized?: boolean;
          p_only_shortcut?: boolean;
          p_only_pending?: boolean;
          p_q?: string | null;
          p_limit?: number;
        };
        Returns: (Tables<"transaction"> & {
          total_count: number;
          total_net_cents: number;
        })[];
      };
      unclassified_by_month: {
        Args: { p_months?: number };
        Returns: { period_month: string; cuantos: number; cents: number }[];
      };
      category_context: {
        Args: { p_category: string | null; p_month: string; p_months?: number };
        Returns: { period_month: string; cents: number }[];
      };
      account_balance_history: {
        Args: { p_months?: number };
        Returns: { period_month: string; cents: number }[];
      };
      account_spend_history: {
        Args: { p_months?: number };
        Returns: { account_id: string; period_month: string; gasto_cents: number }[];
      };
      monthly_savings: {
        Args: { p_months?: number };
        Returns: {
          period_month: string;
          income_cents: number;
          net_expense_cents: number;
          saved_cents: number;
        }[];
      };
      yearly_close: {
        Args: Record<string, never>;
        Returns: {
          anio: number;
          income_cents: number;
          net_expense_cents: number;
          saved_cents: number;
          en_curso: boolean;
        }[];
      };
      position_performance: {
        Args: { p_from: string; p_to: string };
        Returns: {
          position_id: string;
          name: string;
          color: string;
          fecha: string;
          value_cents: number;
          cost_cents: number;
          return_pct: number | null;
        }[];
      };
      commitment_history: {
        Args: { p_months?: number };
        Returns: { period_month: string; monthly_cents: number; cuantas: number }[];
      };
      category_comparison: {
        Args: { p_month: string };
        Returns: {
          category_id: string | null;
          name: string;
          color: string;
          icon: string;
          actual_cents: number;
          previo_cents: number;
          delta_cents: number;
        }[];
      };
      record_ingest_rejection: {
        Args: { p_token: string; p_reason: string; p_payload: unknown };
        Returns: { ok: boolean; error?: string };
      };
      claim_pending_reminder: {
        Args: { p_from_hour?: number };
        Returns: { user_id: string; cuantos: number }[];
      };
      /** Solo el rol de servicio: reclama los avisos de salud de la ingesta sin repetir. */
      claim_ingest_health_alerts: {
        Args: { p_from_hour?: number; p_cooldown_days?: number };
        Returns: {
          user_id: string;
          rejections_24h: number;
          many_rejections: boolean;
          mute_devices: number;
          max_mute_days: number | null;
        }[];
      };
      month_pace: {
        Args: { p_month: string };
        Returns: {
          dia: number;
          actual_cents: number | null;
          anterior_cents: number;
        }[];
      };
      year_over_year: {
        Args: { p_month: string; p_months?: number };
        Returns: {
          period_month: string;
          net_expense_cents: number | null;
          income_cents: number | null;
          prev_net_expense_cents: number | null;
          prev_income_cents: number | null;
        }[];
      };
      category_trend: {
        Args: { p_month: string; p_months?: number };
        Returns: {
          category_id: string | null;
          name: string;
          color: string;
          icon: string;
          period_month: string;
          net_cents: number;
        }[];
      };
      month_forecast: {
        Args: { p_month: string };
        Returns: {
          dias_transcurridos: number;
          dias_totales: number;
          dias_restantes: number;
          gasto_real_cents: number;
          suscripciones_cents: number;
          extrapolado_cents: number;
          prevision_cents: number;
          ingresos_real_cents: number;
        }[];
      };
      category_forecast: {
        Args: { p_month: string };
        Returns: {
          category_id: string;
          name: string;
          color: string;
          icon: string;
          cap_cents: number;
          gastado_cents: number;
          prevision_cents: number;
          rebasa: boolean;
        }[];
      };
      net_worth_history: {
        Args: { p_months?: number };
        Returns: { period_month: string; net_worth_cents: number }[];
      };
      position_return: {
        Args: { p_from: string; p_to: string };
        Returns: {
          position_id: string;
          name: string;
          color: string;
          account_id: string;
          start_cents: number;
          end_cents: number;
          contributions_cents: number;
          gain_cents: number;
          return_pct: number | null;
          valued_on: string | null;
          sin_valorar: boolean;
        }[];
      };
      unfollow_instrument: {
        Args: { p_position_id: string; p_date: string };
        Returns: number;
      };
      instruments_to_refresh: {
        Args: Record<string, never>;
        Returns: {
          instrument_id: string;
          yahoo_symbol: string;
          currency: string;
          last_price_date: string | null;
          desde: string;
        }[];
      };
      portfolio_return: {
        Args: { p_from: string; p_to: string };
        Returns: {
          start_cents: number;
          end_cents: number;
          contributions_cents: number;
          gain_cents: number;
          return_pct: number | null;
        }[];
      };
      month_changes: {
        Args: { p_month: string };
        Returns: {
          category_id: string | null;
          name: string;
          color: string;
          icon: string;
          current_cents: number;
          previous_cents: number;
          delta_cents: number;
        }[];
      };
      mark_month_seen: {
        Args: { p_month: string };
        Returns: undefined;
      };
      month_findings: {
        Args: { p_month: string };
        Returns: {
          kind: string;
          title: string;
          detail: string;
          cents: number;
          count: number;
          href: string;
          tono: "aviso" | "bien";
        }[];
      };
      upcoming_charges: {
        Args: { p_days?: number };
        Returns: {
          subscription_id: string;
          description: string;
          amount_cents: number;
          charge_date: string;
          category_id: string | null;
        }[];
      };
      /** Devuelve cuántos movimientos de ingreso ha creado. */
      generate_recurring_income: {
        Args: Record<string, never>;
        Returns: number;
      };
      upcoming_income: {
        Args: { p_days?: number };
        Returns: {
          recurring_income_id: string;
          description: string;
          amount_cents: number;
          income_date: string;
          category_id: string | null;
        }[];
      };
      pending_recurring_income: {
        Args: { p_month: string };
        Returns: number;
      };
      /**
       * Patrimonio por día (recortado a hoy y a 5 años). Un día sin cuentas
       * sale a 0. net_worth_cents = cash_cents + invested_cents + idle_cents
       * + debt_cents (la deuda de los préstamos, ≤ 0).
       */
      net_worth_daily: {
        Args: { p_desde: string; p_hasta: string };
        Returns: {
          fecha: string;
          net_worth_cents: number;
          cash_cents: number;
          invested_cents: number;
          idle_cents: number;
          debt_cents: number;
        }[];
      };
      /** Mismos cierres que net_worth_history, con las partes del patrimonio. */
      net_worth_monthly: {
        Args: { p_months?: number };
        Returns: {
          period_month: string;
          net_worth_cents: number;
          cash_cents: number;
          invested_cents: number;
          idle_cents: number;
          debt_cents: number;
        }[];
      };
      /** Saldo contable y valor de cada cuenta (también archivadas) al cierre de cada mes. */
      account_balance_monthly: {
        Args: { p_months?: number };
        Returns: {
          account_id: string;
          name: string;
          color: string;
          type: AccountType;
          archived: boolean;
          period_month: string;
          balance_cents: number;
          worth_cents: number;
        }[];
      };
      savings_goal_projection: {
        Args: { p_months?: number };
        Returns: {
          goal_id: string;
          account_id: string;
          name: string;
          target_cents: number;
          deadline: string | null;
          saved_cents: number;
          remaining_cents: number;
          ritmo_cents: number;
          meses_para_meta: number | null;
          fecha_estimada: string | null;
          necesario_mensual_cents: number | null;
        }[];
      };
      /**
       * Top comercios por gasto neto del periodo, más las filas OTROS y
       * SIN_COMERCIO (puesto y merchant_key/merchant a null). Σ net_cents =
       * gasto neto del periodo.
       */
      merchant_spend: {
        Args: { p_desde: string; p_hasta: string; p_limite?: number };
        Returns: {
          grupo: "COMERCIO" | "OTROS" | "SIN_COMERCIO";
          puesto: number | null;
          merchant_key: string | null;
          merchant: string | null;
          net_cents: number;
          gross_cents: number;
          reimbursed_cents: number;
          cargos: number;
          comercios: number;
          share: number | null;
        }[];
      };
      /** 175 celdas: dia_semana 1 (lunes) … 7; hora 0-23 o null = sin hora. */
      spend_heatmap: {
        Args: { p_desde: string; p_hasta: string };
        Returns: {
          dia_semana: number;
          hora: number | null;
          net_cents: number;
          cargos: number;
        }[];
      };
      /** Gasto neto del mes por cuenta y tarjeta; card_id null = sin tarjeta. */
      account_card_spend: {
        Args: { p_month: string };
        Returns: {
          account_id: string;
          account_name: string;
          account_color: string;
          account_type: AccountType;
          account_archived: boolean;
          card_id: string | null;
          last4: string | null;
          nickname: string | null;
          card_type: CardType | null;
          net_cents: number;
          gross_cents: number;
          reimbursed_cents: number;
          cargos: number;
          account_net_cents: number;
        }[];
      };
      /** Ingreso real por categoría del mes y del anterior (sin reembolsos). */
      income_breakdown: {
        Args: { p_month: string };
        Returns: {
          category_id: string | null;
          name: string;
          color: string;
          icon: string;
          income_cents: number;
          previo_cents: number;
          recurrente_cents: number;
          cuantos: number;
          share: number | null;
        }[];
      };
      commitment_by_subscription: {
        Args: { p_months?: number };
        Returns: {
          period_month: string;
          subscription_id: string;
          description: string;
          periodicity: Periodicity;
          amount_cents: number;
          monthly_cents: number;
          cuenta: boolean;
          alta: boolean;
          pausada: boolean;
        }[];
      };

      // ── Préstamos ────────────────────────────────────────────────────────
      /** Cuadro francés puro (céntimos exactos). Espejo de cuadroAmortizacion(). */
      loan_plan: {
        Args: {
          p_principal_cents: number;
          p_term_months: number;
          /** Texto decimal exacto («6.5»): nunca un doble. */
          p_tin_pct: string;
          p_first_charge_on: string;
        };
        Returns: {
          period: number;
          due_on: string;
          payment_cents: number;
          interest_cents: number;
          principal_cents: number;
          balance_after_cents: number;
        }[];
      };
      /** TAE informativa en %, o null. Espejo de taeCalculada(). */
      loan_tae: {
        Args: {
          p_principal_cents: number;
          p_term_months: number;
          p_tin_pct: string;
          p_opening_fee_cents: number;
        };
        Returns: number | null;
      };
      create_loan: {
        Args: {
          p_name: string;
          p_payment_account_id: string;
          p_principal_cents: number;
          p_term_months: number;
          p_tin_pct: string;
          p_tae_pct: string | null;
          p_opening_fee_cents: number;
          p_charge_day: number;
          p_start_on: string;
          p_first_charge_on: string | null;
          p_disbursed: boolean;
        };
        Returns: Json;
      };
      update_loan: {
        Args: { p_loan_id: string; p_name: string; p_tae_pct: string | null };
        Returns: undefined;
      };
      update_loan_terms: {
        Args: {
          p_loan_id: string;
          p_payment_account_id: string;
          p_principal_cents: number;
          p_term_months: number;
          p_tin_pct: string;
          p_opening_fee_cents: number;
          p_charge_day: number;
          p_start_on: string;
          p_first_charge_on: string | null;
          p_disbursed: boolean;
        };
        Returns: Json;
      };
      cancel_loan: {
        Args: { p_loan_id: string };
        Returns: undefined;
      };
      settle_loan: {
        Args: { p_loan_id: string; p_on: string | null; p_fee_cents: number };
        Returns: Json;
      };
      loan_delete_preview: {
        Args: { p_loan_id: string };
        Returns: Json;
      };
      delete_loan: {
        Args: { p_loan_id: string; p_confirm_name: string };
        Returns: Json;
      };
      /** Genera las cuotas vencidas del usuario. Devuelve cuántas creó. */
      generate_loan_installments: {
        Args: Record<string, never>;
        Returns: number;
      };
      /** SOLO service_role (cron): las de todos los usuarios. */
      generate_loan_installments_all: {
        Args: Record<string, never>;
        Returns: number;
      };
      /** SOLO service_role: avisos de cuota cobrada, una vez por cuota. */
      claim_loan_installment_notices: {
        Args: Record<string, never>;
        Returns: {
          user_id: string;
          loan_id: string;
          loan_name: string;
          from_period: number;
          to_period: number;
          term_months: number;
          amount_cents: number;
        }[];
      };
      loan_schedule: {
        Args: { p_loan_id: string };
        Returns: {
          period: number;
          due_on: string;
          payment_cents: number;
          interest_cents: number;
          principal_cents: number;
          balance_after_cents: number;
          state: "PREVIA" | "COBRADA" | "PENDIENTE" | "ANULADA";
          has_movement: boolean;
        }[];
      };
    };

    Enums: {
      account_type: AccountType;
      card_type: CardType;
      entry_type: EntryType;
      tx_source: TxSource;
      tx_status: TxStatus;
      periodicity: Periodicity;
      instrument_kind: InstrumentKind;
      position_event_kind: PositionEventKind;
    };

    CompositeTypes: Record<never, never>;
  };
};

// Atajos para no repetir Database["public"]["Tables"][...] por todas partes.
type PublicSchema = Database["public"];
export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"];
export type Views<T extends keyof PublicSchema["Views"]> = PublicSchema["Views"][T]["Row"];

export type Account = Tables<"account">;
export type Card = Tables<"card">;
export type Category = Tables<"category">;
export type Transaction = Tables<"transaction">;
export type MerchantRule = Tables<"merchant_rule">;
export type Profile = Tables<"profile">;
export type AccountBalance = Views<"v_account_balance">;
export type MonthSummary = Views<"v_month_summary">;
export type Loan = Tables<"loan">;
export type LoanStatusRow = Views<"v_loan_status">;

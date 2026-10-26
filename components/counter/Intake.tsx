"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { PERSONA_PRESETS, personaPayload } from "@/lib/client/personas";
import { parseStatement } from "@/lib/client/statement";
import s from "./counter.module.css";

/** Who the counter is for: the one line of copy on the front door. */
export const AUDIENCE = "For anyone whose card says more about their taste than their budget.";

export const PRIVACY = "Your statement stays in this browser. Only merchant names and totals are sent.";

/**
 * The door's stub row (3vw in, ~364px wide) would reach the 3D receipt, whose
 * left edge sits at 50vw - 0.315 x the height on a landscape screen (measured
 * from the scene at 1920x1080 to 1024x768). Then the stubs move under it too.
 */
function crowded(): boolean {
  const w = window.innerWidth, h = window.innerHeight;
  return w / h > 4 / 5 && 0.47 * w - 0.315 * h < 388;
}
function onResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
export const useCrowdedDoor = () => useSyncExternalStore(onResize, crowded, () => false);

/** The three sample statements as torn paper stubs. */
export function PersonaStubs({ onPick, current }: { onPick: (id: string) => void; current?: string }) {
  const lines = useMemo(
    () =>
      Object.fromEntries(
        PERSONA_PRESETS.map((p) => {
          const csv = personaPayload(p.id)?.csv;
          return [p.id, csv ? parseStatement(csv).transactions.length : 0];
        }),
      ),
    [],
  );
  return (
    <div className={s.stubs} role="group" aria-label="Sample statements" data-door="stubs">
      {PERSONA_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`${s.paper} ${s.torn} ${s.stub}`}
          onClick={() => onPick(p.id)}
          aria-pressed={current === p.id}
          aria-label={`${p.name}, ${p.place}: ${lines[p.id]} lines`}
        >
          <span className={s.stubName}>{p.name}</span>
          <span className={s.stubPlace}>{p.place}</span>
          <span className={s.stubLines} aria-hidden />
          <span className={s.stubPen} aria-hidden>
            {lines[p.id]} lines
          </span>
        </button>
      ))}
    </div>
  );
}

/** Where your own statement goes. The whole page also takes a drop. */
export function StatementSlip({ onChoose, error }: { onChoose: () => void; error?: string }) {
  return (
    <div className={`${s.paper} ${s.torn} ${s.slip}`} data-door="drop">
      <div className={s.slipHead}>
        <span>Statement</span>
        <span>.csv</span>
      </div>
      <p className={`${s.slipPen} ${error ? s.red : ""}`} role={error ? "alert" : undefined}>
        {error ?? "Drop yours here"}
      </p>
      <div className={s.slipActions}>
        <button type="button" className={s.stamp} onClick={onChoose}>
          Choose file
        </button>
      </div>
      <p className={s.fine}>{PRIVACY}</p>
    </div>
  );
}

/** An upload has no place yet; the agent needs one. */
export function PlaceSlip({ onPlace, rows }: { onPlace: (label: string) => void; rows: number }) {
  const [v, setV] = useState("");
  return (
    <form
      className={`${s.paper} ${s.torn} ${s.slip}`}
      onSubmit={(e) => {
        e.preventDefault();
        const label = v.trim();
        if (label) onPlace(label);
      }}
    >
      <div className={s.slipHead}>
        <span>Where</span>
        <span>{rows} lines</span>
      </div>
      <label htmlFor="place" className={s.srOnly}>
        Neighbourhood and city
      </label>
      <input
        id="place"
        className={s.field}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Astoria, Queens"
        autoComplete="address-level2"
        autoFocus
        maxLength={120}
      />
      <div className={s.slipActions}>
        <button type="submit" className={s.stamp} disabled={!v.trim()}>
          Read it
        </button>
      </div>
    </form>
  );
}

export function DropVeil() {
  return (
    <div className={s.veil} aria-hidden>
      <div className={`${s.paper} ${s.torn} ${s.slip}`}>
        <div className={s.slipHead}>
          <span>Statement</span>
          <span>.csv</span>
        </div>
        <p className={s.slipPen}>Let go</p>
      </div>
    </div>
  );
}

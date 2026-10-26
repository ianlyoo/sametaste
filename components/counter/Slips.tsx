"use client";

import { useState } from "react";
import type { AgentQuestion, Answer } from "@/lib/contract";
import type { RunError, RunState } from "@/lib/client/flow";
import { cleanAddress, printerLine } from "@/lib/client/view";
import s from "./counter.module.css";

/**
 * The agent asks; the options are written in pen and circled when chosen. On a wide screen the slip lies on the counter beside the
 * receipt (the scene lays it there: CounterScene's `counter` slot). `tab`: on a phone it is a small tab until tapped, then a sheet
 * over the lower screen with a close (PM, v5: the slip never covers the stacked receipts unless the reader opens it).
 */
export function QuestionSlip({ q, onAnswer, tab = false }: { q: AgentQuestion; onAnswer: (a: Answer) => void; tab?: boolean }) {
  const [picked, setPicked] = useState<string>();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const send = (a: Omit<Answer, "questionId" | "merchantKey">) => onAnswer({ questionId: q.id, merchantKey: q.merchantKey, ...a });
  if (tab && !open)
    return (
      <button type="button" className={`${s.paper} ${s.qtab}`} aria-expanded={false} aria-label={`A question: ${q.prompt}`} onClick={() => setOpen(true)}>
        <b aria-hidden>?</b> Question
      </button>
    );
  return (
    <div className={`${s.paper} ${s.torn} ${s.question} ${tab ? s.sheet : s.onCounter}`} role="dialog" aria-labelledby={`q-${q.id}`}>
      <div className={s.slipHead}>
        <span>Question</span>
        {tab ? (
          <button type="button" className={s.clear} aria-label="Fold the question" onClick={() => setOpen(false)}>
            ×
          </button>
        ) : (
          <span>?</span>
        )}
      </div>
      <p id={`q-${q.id}`} className={s.prompt}>
        {q.prompt}
      </p>
      <ul className={s.options}>
        {q.options.map((o) => {
          const detail = cleanAddress(o.detail);
          return (
            <li key={o.id}>
              <button
                type="button"
                className={s.option}
                aria-pressed={picked === o.id}
                onClick={() => {
                  setPicked(o.id);
                  send({ optionId: o.id, entityId: o.entityId });
                }}
              >
                {o.label}
                {detail && <small>{detail}</small>}
              </button>
            </li>
          );
        })}
      </ul>
      {q.allowFreeText && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send({ text: text.trim() });
          }}
        >
          <label htmlFor={`qt-${q.id}`} className={s.srOnly}>
            Your answer
          </label>
          <input id={`qt-${q.id}`} className={s.field} value={text} onChange={(e) => setText(e.target.value)} placeholder="or write it" maxLength={500} />
        </form>
      )}
    </div>
  );
}

export function ErrorSlip({ error, onRetry, onClear }: { error: RunError | string; onRetry?: () => void; onClear?: () => void }) {
  const message = typeof error === "string" ? error : error.message;
  const retry = typeof error === "string" || error.retryable ? onRetry : undefined;
  return (
    <div className={`${s.paper} ${s.torn} ${s.error}`} role="alert">
      <div className={s.slipHead}>
        <span>Stopped</span>
        <span>{typeof error === "string" ? "" : error.code.replace(/_/g, " ")}</span>
      </div>
      <p className={`${s.slipPen} ${s.red}`}>{message}</p>
      <div className={s.slipActions}>
        {retry && (
          <button type="button" className={s.stamp} onClick={retry}>
            Try again
          </button>
        )}
        {onClear && (
          <button type="button" className={s.link} onClick={onClear}>
            Another statement
          </button>
        )}
      </div>
    </div>
  );
}

/** One printing line: what the agent is doing, and how many Qloo calls so far. */
export function Printer({ run, label }: { run: RunState; label?: string }) {
  const { text, qloo } = printerLine(run);
  return (
    <div>
      <div className={s.printer}>
        <span className={s.head} aria-hidden />
        <span className={s.text}>{label ?? text}</span>
        {qloo > 0 && <span className={s.count}>Qloo {qloo}</span>}
      </div>
      <div className={s.feed} aria-hidden />
    </div>
  );
}

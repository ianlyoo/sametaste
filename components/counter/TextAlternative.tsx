"use client";

import type { SceneReceipt } from "@/components/scene";
import type { FlowState } from "@/lib/client/flow";
import { formatMoney } from "@/lib/client/format";
import { affinityRows, evidenceLine, nextMonth, statementPeriod } from "@/lib/client/view";
import type { SharedMoney } from "./money";
import { proofText, swapLines } from "./receipt";
import s from "./counter.module.css";

/**
 * The scene as text, with the paper's figures: the statement lines, the taste
 * read, each swap as the pen writes it (the hero bridge in full), keyboard
 * reject/undo, and the measured proof against a model alone. Hidden until
 * something inside has focus, then it lies on the counter as a sheet of paper.
 */
export function TextAlternative({
  state,
  receipt,
  money,
  onReject,
  onUndo,
}: {
  state: FlowState;
  receipt: SceneReceipt;
  money: SharedMoney;
  onReject: (swapId: string) => void;
  onUndo: (swapId: string) => void;
}) {
  if (!state.statement) return null;
  const cur = money.currency;
  const baseline = state.baseline.suggestions;
  const taste = affinityRows(state);
  const swaps = swapLines(state);
  const proof = proofText(state.plan?.proof, state.baseline.proof, state.baseline.proofRuns);
  return (
    <section id="receipt-text" className={`${s.paper} ${s.alt}`} aria-label="Receipt as text" tabIndex={-1}>
      <h2>{statementPeriod(state.statement)} receipt</h2>
      <table>
        <caption className={s.srOnly}>Statement lines</caption>
        <thead className={s.srOnly}>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Merchant</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {receipt.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.date.slice(5).replace("-", "/")}</td>
              <td>
                {r.name}
                {r.where ? `, ${r.where}` : ""}
              </td>
              <td>{formatMoney(r.amount, cur)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              Total
            </th>
            <td>{formatMoney(money.statement, cur)}</td>
          </tr>
        </tfoot>
      </table>

      {taste.length > 0 && (
        <>
          <hr className={s.rule} />
          <h2>Read as taste</h2>
          <ul>
            {taste.map((r) => (
              <li key={r.domain}>
                <span>
                  {r.domain}: {r.names.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {swaps.length > 0 && (
        <>
          <hr className={s.rule} />
          <h2>Swaps</h2>
          <table>
            <caption className={s.srOnly}>Each swapped merchant, its twin at the twin&apos;s own monthly price, and the monthly saving</caption>
            <tbody>
              {swaps.map((l) => {
                const sw = l.swap;
                const why = [evidenceLine(sw), l.bridge].filter(Boolean).join(". ");
                return (
                  <SwapRows
                    key={sw.id}
                    head={`${l.count}× ${l.name}`}
                    spend={formatMoney(l.spend, cur)}
                    twin={l.live ? `→ ${sw.to.entity.name}, ${formatMoney(l.twinMonthly, cur)} a month` : "Kept"}
                    saving={l.live ? formatMoney(-l.saving, cur) : ""}
                    why={l.live ? why : ""}
                    struck={l.live}
                    action={
                      l.busy ? (
                        <span>Re-planning</span>
                      ) : l.live ? (
                        <button type="button" className={s.link} onClick={() => onReject(sw.id)}>
                          Keep {sw.from.name}
                        </button>
                      ) : (
                        <button type="button" className={s.link} onClick={() => onUndo(sw.id)}>
                          Take {sw.to.entity.name}
                        </button>
                      )
                    }
                  />
                );
              })}
            </tbody>
            {money.saved > 0 && (
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>
                    Saved a month in {nextMonth(state.statement)}
                  </th>
                  <td>{formatMoney(-money.saved, cur)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </>
      )}

      {(baseline.length > 0 || proof.length > 0) && (
        <>
          <hr className={s.rule} />
          <h2>A model alone</h2>
          {proof.length > 0 && (
            <table>
              <caption className={s.srOnly}>The measured proof: our twins against a model alone, the same Qloo checks on both</caption>
              <thead>
                <tr>
                  <th scope="col" className={s.srOnly}>
                    Measure
                  </th>
                  <th scope="col">Twins</th>
                  <th scope="col">Model alone</th>
                </tr>
              </thead>
              <tbody>
                {proof.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    <td className={r.worse === "ours" ? s.worse : undefined}>{r.ours}</td>
                    <td className={r.worse === "theirs" ? s.worse : undefined}>{r.theirs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ul>
            {baseline.map((x) => (
              <li key={x.merchantKey}>
                <span>
                  {x.fromName} → {x.suggestedName}
                </span>
                <span>
                  {x.verification === "pending_key"
                    ? "not checked"
                    : !x.existsInQloo
                      ? "not found"
                      : x.cheaper === false
                        ? "not cheaper"
                        : x.cheaper
                          ? "cheaper"
                          : "no price"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function SwapRows({
  head,
  spend,
  twin,
  saving,
  why,
  struck,
  action,
}: {
  head: string;
  spend: string;
  twin: string;
  saving: string;
  why: string;
  struck: boolean;
  action: React.ReactNode;
}) {
  return (
    <>
      <tr>
        <th scope="row" colSpan={2}>
          {head}
        </th>
        <td className={struck ? s.struck : undefined}>{spend}</td>
      </tr>
      <tr>
        <td colSpan={2} className={s.twinCell}>
          {twin}
        </td>
        <td className={s.twinCell}>{saving}</td>
      </tr>
      <tr>
        <td colSpan={2}>{why}</td>
        <td>{action}</td>
      </tr>
    </>
  );
}

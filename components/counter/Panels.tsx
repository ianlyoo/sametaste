"use client";

import Link from "next/link";
import { useState } from "react";
import { SCENE_SECTIONS, type SceneSection } from "@/components/scene";
import { proofSentence } from "@/components/scene/lines";
import type { FlowState } from "@/lib/client/flow";
import { formatMoney } from "@/lib/client/format";
import { nextMonth, resolvedCount, statementPeriod, whoLabel } from "@/lib/client/view";
import type { SharedMoney } from "./money";
import s from "./counter.module.css";

const SECTION_LABEL: Record<SceneSection, string> = {
  statement: "Statement",
  understood: "Understood",
  swaps: "Swaps",
  november: "November",
  proof: "Proof",
};

/** Section label; "November" follows the statement's month. */
export function sectionLabel(sec: SceneSection, st?: FlowState["statement"]): string {
  return sec === "november" ? nextMonth(st) : SECTION_LABEL[sec];
}

/**
 * The one nav for `/` and `/demo`: brand, sections, the "Sample Qloo" label
 * while the data is mock, and who. `/demo` passes `sample` (its fixtures are
 * mock before the run starts) and no `onReset` (the brand links home, no ×).
 */
export function TopBar({
  state,
  section,
  onSection,
  onReset,
  sample = state.run.qlooMock,
}: {
  state: FlowState;
  section: SceneSection;
  onSection: (sec: SceneSection) => void;
  onReset?: () => void;
  sample?: boolean;
}) {
  const loaded = !!state.statement;
  const who = whoLabel(state);
  return (
    <header className={s.top}>
      {onReset ? (
        <button type="button" className={s.brand} onClick={onReset} aria-label="SameTaste, start over">
          SameTaste
        </button>
      ) : (
        <Link className={s.brand} href="/">
          SameTaste
        </Link>
      )}
      {loaded ? (
        <nav className={s.nav} aria-label="Sections">
          {SCENE_SECTIONS.map((sec, k) => (
            <a
              key={sec}
              href={`#${k}`}
              aria-current={sec === section ? "step" : undefined}
              onClick={(e) => {
                e.preventDefault();
                onSection(sec);
              }}
            >
              {sectionLabel(sec, state.statement)}
            </a>
          ))}
        </nav>
      ) : (
        <span />
      )}
      <div className={s.who}>
        {sample && (
          <span className={s.sample} title="Qloo answers are simulated in this run">
            Sample Qloo
          </span>
        )}
        {who && <span>{who}</span>}
        {loaded && onReset && (
          <button type="button" className={s.clear} onClick={onReset} aria-label="Put this statement away">
            ×
          </button>
        )}
      </div>
    </header>
  );
}

/** The text column: one number per section, one line under it. Only numbers the paper prints. */
export function Figure({ state, money, section, theirsShown = true }: { state: FlowState; money: SharedMoney; section: SceneSection; /** the model-alone rows show on the counter (the scene's onTheirsPrinted) */ theirsShown?: boolean }) {
  const cur = money.currency;
  let big: React.ReactNode;
  let sub: React.ReactNode;
  let red = false;

  switch (section) {
    case "statement":
      big = formatMoney(money.statement, cur);
      sub = `${statementPeriod(state.statement) ?? ""}, ${state.statement?.transactions.length ?? 0} lines.`;
      break;
    case "understood": {
      const n = resolvedCount(state);
      if (!n) return null;
      big = n;
      sub = "places found on Qloo.";
      break;
    }
    case "swaps":
      if (!money.kept) return null;
      big = money.kept;
      sub = `taste twin${money.kept === 1 ? "" : "s"} nearby. Click a red line to say no.`;
      break;
    case "november":
      if (!money.saved) return null;
      big = formatMoney(-money.saved, cur);
      red = true;
      sub = `a month in ${nextMonth(state.statement)}.`;
      break;
    case "proof": {
      // the model alone is quoted once its rows show on its paper, which prints as the reader scrolls (v7, M2: no caption popping in with the data)
      if (!theirsShown) return null;
      // the measured proof in /demo's one line (PM, v5), from the rows the paper prints; the receipts carry the numbers, so no big figure
      const ours = state.plan?.proof, theirs = state.baseline.proof;
      if (ours && theirs) {
        const p = proofSentence(ours, theirs, state.baseline.proofRuns);
        big = null;
        sub = (
          <>
            <span className={s.nowrap}>{p.ours}</span> {p.what}. A model alone: <span className={s.nowrap}>{p.theirs}</span>.
          </>
        );
        break;
      }
      // the paper's EXISTS line: "pending_key" picks were never checked, so they don't count
      const checked = state.baseline.suggestions.filter((x) => x.verification !== "pending_key");
      if (!checked.length) return null;
      big = `${checked.filter((x) => x.existsInQloo).length} of ${checked.length}`;
      sub = "picks by a model alone exist on Qloo.";
      break;
    }
  }

  return (
    <div className={`${s.figure} ${s.halo}`}>
      {big != null && <p className={`${s.big} ${red ? s.red : ""}`}>{big}</p>}
      <p className={`${s.sub} ${big == null ? s.one : ""}`}>{sub}</p>
    </div>
  );
}

/**
 * Right column (landscape, swaps only): the twin in focus and its button. The
 * paper prints the taste read, the evidence and the bridge; this only acts.
 */
export function SidePanel({
  state,
  section,
  onReject,
  onUndo,
}: {
  state: FlowState;
  section: SceneSection;
  onReject: (swapId: string) => void;
  onUndo: (swapId: string) => void;
}) {
  return section === "swaps" ? <Swaps state={state} onReject={onReject} onUndo={onUndo} /> : null;
}

function Swaps({ state, onReject, onUndo }: { state: FlowState; onReject: (id: string) => void; onUndo: (id: string) => void }) {
  const [i, setI] = useState(0);
  const list = state.swaps;
  if (!list.length) {
    return state.run.status === "done" ? (
      <div className={`${s.panel} ${s.halo}`}>
        <p className={s.panelTitle}>No cheaper twins nearby.</p>
      </div>
    ) : null;
  }
  const k = Math.min(i, list.length - 1);
  const sw = list[k];
  const busy = state.replanning.includes(sw.merchantKey);
  const rejected = sw.status === "rejected";
  return (
    <div className={`${s.panel} ${s.halo}`}>
      <p className={`${s.twin} ${rejected ? s.struckTwin : ""}`}>
        {sw.from.name}
        <span className={s.arrow} aria-label="to">
          →
        </span>
        {sw.to.entity.name}
      </p>
      <div className={s.row}>
        {list.length > 1 && (
          <span className={s.pager}>
            <button type="button" onClick={() => setI((k - 1 + list.length) % list.length)} aria-label="Previous twin">
              ←
            </button>
            <span aria-live="polite">
              {k + 1}/{list.length}
            </span>
            <button type="button" onClick={() => setI((k + 1) % list.length)} aria-label="Next twin">
              →
            </button>
          </span>
        )}
        {busy ? (
          <span className={s.plain} aria-live="polite">
            Re-writing
          </span>
        ) : rejected ? (
          <button type="button" className={s.penButton} onClick={() => onUndo(sw.id)}>
            Take {sw.to.entity.name}
          </button>
        ) : (
          <button type="button" className={s.penButton} onClick={() => onReject(sw.id)}>
            Keep {sw.from.name}
          </button>
        )}
      </div>
    </div>
  );
}

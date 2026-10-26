"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CounterScene, SCENE_SECTIONS, type CounterSceneHandle, type SceneSection } from "@/components/scene";
import { TopBar } from "@/components/counter/Panels";
import s from "@/components/counter/counter.module.css";
import { money, proofSentence, sceneLabels, totals } from "@/components/scene/lines";
import { useAgentFlow } from "@/lib/client/useAgentFlow";
import { makeDemoFetch } from "./replay";
import type { ProofSide } from "@/lib/contract";

/** The proof's sentence: one short line (PM, scene-9: the receipts carry the numbers; the sentence sits under them, never over), from the same rows the paper prints (lines.ts proofSentence; `/` says the same). */
function ProofLine({ ours, theirs, runs }: { ours: ProofSide; theirs: ProofSide; runs?: ProofSide[] }) {
  const p = proofSentence(ours, theirs, runs), nb = (t: string) => <span style={{ whiteSpace: "nowrap" }}>{t}</span>; // a range ("3–6 of 9") stays on one line
  return <p className="lab">{nb(p.ours)} {p.what}. A model alone: {nb(p.theirs)}.</p>;
}
/** A section's panel as B had it: one big number from the live data and a short line under it. */
function Hero({ big, red, children }: { big: string; red?: boolean; children: React.ReactNode }) {
  return (
    <div className="hero">
      <div className="big" style={red ? { color: "#c8321f" } : undefined}>{big}</div>
      <p className="lab">{children}</p>
    </div>
  );
}

const PERSONAS: Record<string, { id: string; location: { label: string; lat: number; lon: number; radiusM: number } }> = {
  maya: { id: "maya-williamsburg", location: { label: "Williamsburg, Brooklyn, NY", lat: 40.7081, lon: -73.9571, radiusM: 2500 } },
};

declare global {
  interface Window { __demo?: { run: string; baseline: string; swaps: number } }
}

export default function DemoClient() {
  const q = useSearchParams();
  const persona = PERSONAS[q.get("persona") ?? "maya"] ? (q.get("persona") ?? "maya") : "maya";
  const instant = q.has("instant");
  const scene = useRef<CounterSceneHandle>(null);
  // contract 1.3/1.6: the model's side of the measured proof (and every one of its runs) rides on `baseline_ready`; the replay hands it over until the flow keeps it
  const [theirProof, setTheirProof] = useState<{ proof: ProofSide; runs?: ProofSide[] } | undefined>(undefined);
  // the recording lands whole and at once (scene-12: the scroll is the only clock on /demo; every frame is a function of the reader's position, so nothing may arrive on its own time)
  const demoFetch = useMemo(() => makeDemoFetch("/api/recording", PERSONAS[persona].id, true, { onBaselineProof: (proof, runs) => setTheirProof({ proof, runs }) }), [persona]);
  const flow = useAgentFlow({ fetch: demoFetch });
  const { state, loadCsv, start, reject, undo, answer, runBaseline } = flow;
  const [section, setSection] = useState<SceneSection>("statement");
  const [theirsShown, setTheirsShown] = useState(false); // the model-alone rows show on the counter: the proof line quotes them only then (v7, M2)
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const onResize = () => setPortrait(window.innerWidth / window.innerHeight < 0.8);
    onResize();
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
  const started = useRef(false);

  // the statement prints at once and the recorded run loads right behind it, before the reader's first move; the scene shows it only as the reader scrolls
  const loaded = useRef(false), runStarted = useRef(false);
  const startRun = () => { if (runStarted.current || !loaded.current) return; runStarted.current = true; void start(); };
  const latestStart = useRef(startRun); useEffect(() => { latestStart.current = startRun; });
  useEffect(() => {
    if (started.current) return; started.current = true;
    const p = PERSONAS[persona];
    fetch(`/scene/demo/${persona}.csv`).then((r) => r.text()).then((csv) => loadCsv(csv, { personaId: p.id, location: p.location, autoRun: false }));
  }, [persona, loadCsv]);
  useEffect(() => {
    if (!state.statement || loaded.current) return; loaded.current = true;
    latestStart.current();
  }, [state.statement]);

  // the baseline runs once the plan is in (or when the proof section is reached first)
  const baselineStarted = useRef(false);
  const startBaseline = () => { if (baselineStarted.current || state.merchants.length === 0) return; baselineStarted.current = true; void runBaseline(); };
  useEffect(() => { if (state.run.status === "done") startBaseline(); });
  useEffect(() => { window.__demo = { run: state.run.status, baseline: state.baseline.status, swaps: state.swaps.length }; });

  const data = useMemo(() => { const b = state.baseline as { proof?: ProofSide; proofRuns?: ProofSide[] }; return { ...state, baseline: { ...state.baseline, proof: b.proof ?? theirProof?.proof, proofRuns: b.proofRuns ?? theirProof?.runs } }; }, [state, theirProof]);
  const labels = sceneLabels(state), tot = totals(state);
  const i = SCENE_SECTIONS.indexOf(section);
  const go = (k: number) => scene.current?.seek(k);
  const merged = new Set(state.swaps.flatMap((s) => s.mergedKeys ?? []));
  const read = Object.values(state.resolutions).filter((r) => r.status !== "skipped" && !merged.has(r.merchantKey)).length;
  // B's panels, with the live numbers: the statement's total, the places read, the month after swaps, the saving, the proof in one line
  const statementTotal = (state.statement?.transactions ?? []).filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const monthName = cap(labels.month.split(" ")[0] ?? "This month"), saving = <b style={{ color: "#c8321f" }}>−{money(tot.saving)}</b>;
  const line = [
    state.statement ? <Hero big={money(statementTotal)}>{monthName}, on the counter. <b>{labels.lines} lines</b>, one card, nothing typed.</Hero> : null,
    read ? <Hero big={String(read)}><b>merchants</b>, resolved to Qloo entities. Each one is a taste signal.</Hero> : state.run.status === "running" ? <p className="lab">{state.run.statusMessage ?? "Reading it as taste."}</p> : null,
    state.swaps.length ? <Hero big={money(tot.after)}>after swaps. {saving} a month, same taste. Click a line to say no.</Hero> : state.run.status === "running" ? <p className="lab">Looking for taste twins.</p> : null,
    state.plan ? <Hero big={"−" + money(tot.saving)} red>in {cap(labels.nextMonth)}, planned on the same strip. <b>Nothing you love given up.</b></Hero> : null,
    !theirsShown
      ? null // asking, the scene's mark on the blank paper says so; the data landing changes nothing until the reader scrolls
      : data.baseline.proof && state.plan?.proof
      ? <ProofLine ours={state.plan.proof} theirs={data.baseline.proof} runs={data.baseline.proofRuns} />
      : state.baseline.suggestions.length
      ? <p className="lab">{state.baseline.suggestions.every((s) => s.verification === "pending_key")
        ? `A model alone: ${state.baseline.suggestions.length} places, none checked on Qloo yet.`
        : `A model alone: ${state.baseline.suggestions.filter((s) => s.existsInQloo).length} of ${state.baseline.suggestions.filter((s) => s.verification !== "pending_key").length} exist on Qloo.`}</p>
      : state.baseline.status === "running" ? <p className="lab">Asking a model alone.</p> : null,
  ][i];

  // the same bar as the front door (Panels' TopBar): brand (home), the sections, the "Sample Qloo" label while the recording is the bundled mock, who
  const bar = <TopBar state={state} section={section} onSection={(sec) => go(SCENE_SECTIONS.indexOf(sec))} />;
  const left = line ? (
    <div className="demo-panel">
      <style>{`
        .demo-panel{position:relative}
        .demo-panel::before{content:'';position:absolute;inset:-2.6rem -3.2rem;background:rgba(232,226,214,.62);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);-webkit-mask-image:radial-gradient(ellipse at center,#000 48%,transparent 100%);mask-image:radial-gradient(ellipse at center,#000 48%,transparent 100%);pointer-events:none}
        .demo-panel>*{position:relative}
        .demo-panel .big{font-size:clamp(56px,6vw,124px);font-weight:600;letter-spacing:-.045em;line-height:.95;font-variant-numeric:tabular-nums;color:#1d1a16}
        .demo-panel .lab{margin:.8rem 0 0;font-size:clamp(16px,1.2vw,23px);color:#5f5950;line-height:1.35}
        .demo-panel .lab b{color:#1d1a16;font-weight:500}
        @media (max-aspect-ratio: 4/5){.demo-panel::before{content:none}.demo-panel .big{font-size:34px}.demo-panel .lab{font-size:14px;margin-top:.35rem;line-height:1.3}}
      `}</style>
      {line}
    </div>
  ) : null;
  const bottom = i === 0 ? <span style={{ fontSize: 13, color: "#6f6960" }}>scroll</span> : null;
  // a phone: the caption goes in the strip under the bar, as on `/` (v14, HIGH: in the bottom stack it lay on the model-alone receipt's
  // rows at Proof, with no band under it since nav A); the scene frames each section below the strip and its veil fades what runs under it
  const top = portrait ? (
    <div className={s.strip}>
      {bar}
      {(left || bottom) && <div className={s.band}>{left}{bottom}</div>}
    </div>
  ) : bar;
  // B's plan summary at the lower right: two big numbers from the live data (swaps kept; a year of the same taste) under the month's name
  const right = i === 3 && state.plan ? (
    <div className="demo-panel demo-sum">
      <style>{`
        .demo-sum h3{font-weight:500;font-size:clamp(20px,1.5vw,30px);letter-spacing:-.02em;line-height:1.15;margin:0 0 .5rem;color:#1d1a16}
        .demo-sum .vs{display:grid;grid-template-columns:1fr 1fr;gap:1rem 1.4rem;margin-top:.4rem;align-items:end}
        .demo-sum .n{font-size:clamp(36px,3.2vw,64px);font-weight:600;letter-spacing:-.04em;line-height:1;font-variant-numeric:tabular-nums;color:#1d1a16}
        .demo-sum .n{white-space:nowrap}
        .demo-sum .n.long{font-size:clamp(30px,2.5vw,50px)}
        .demo-sum .t{color:#5f5950;font-size:clamp(13px,.95vw,17px);margin-top:.35rem;line-height:1.3}
      `}</style>
      <h3>{cap(labels.nextMonth)}, planned</h3>
      <div className="vs">
        <div><div className="n">{tot.kept} of {tot.all}</div><div className="t">swaps kept</div></div>
        <div><div className="n long" style={{ color: "#c8321f" }}>−${Math.round(tot.saving * 12).toLocaleString("en-US")}</div><div className="t">a year, same taste</div></div>
      </div>
    </div>
  ) : null;

  return (
    <CounterScene
      ref={scene}
      data={data}
      onReject={(id) => reject(id)}
      onUndo={(id) => undo(id)}
      onAnswer={answer}
      onSectionChange={setSection}
      onProofVisible={startBaseline}
      onTheirsPrinted={setTheirsShown}
      instant={instant}
      poster
      slots={portrait ? { top } : { top, left, bottom, right }}
    />
  );
}

const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

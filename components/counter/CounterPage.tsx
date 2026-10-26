"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CounterScene, deriveReceipt, type CounterSceneHandle, type SceneSection, sectionTopVh } from "@/components/scene";
import { PERSONA_PRESETS } from "@/lib/client/personas";
import { useAgentFlow } from "@/lib/client/useAgentFlow";
import { foldMerges } from "@/lib/client/view";
import { AUDIENCE, DropVeil, PersonaStubs, PlaceSlip, StatementSlip, useCrowdedDoor } from "./Intake";
import { sharedMoney } from "./money";
import { Figure, sectionLabel, SidePanel, TopBar } from "./Panels";
import { ErrorSlip, Printer, QuestionSlip } from "./Slips";
import { TextAlternative } from "./TextAlternative";
import s from "./counter.module.css";

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "]);

declare global {
  interface Window {
    __app?: { run: string; baseline: string; swaps: number; question: boolean };
  }
}

/** The scene owns the scroll track (its stages in viewport heights: STAGE_VH). */
/** ms the door takes to fade out after a sample pick (the .leaving transition) */
const DOOR_FADE_MS = 420;
const scrollToSection = (i: number, smooth = true) =>
  window.scrollTo({ top: sectionTopVh(i, window.innerWidth / window.innerHeight < 0.8) * window.innerHeight, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });

export default function CounterPage() {
  const flow = useAgentFlow();
  const { state, loadPersona, runBaseline } = flow;
  const [section, setSection] = useState<SceneSection>("statement");
  const [portrait, setPortrait] = useState(false);
  const [theirsShown, setTheirsShown] = useState(false); // the model-alone rows show on the counter: the proof caption quotes them only then
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const drags = useRef(0);
  const scene = useRef<CounterSceneHandle>(null);

  // the paper's view: lines the agent announced as one place are one merchant from the start
  const paper = useMemo(() => foldMerges(state), [state]);
  const money = useMemo(() => sharedMoney(paper), [paper]);
  const receipt = useMemo(() => deriveReceipt(paper), [paper]);
  const loaded = !!state.statement;
  const running = state.run.status === "running";

  useEffect(() => {
    const onResize = () => setPortrait(window.innerWidth / window.innerHeight < 0.8);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ?persona=maya opens a sample straight away (demo links, shots).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("persona")?.toLowerCase();
    const p = id && PERSONA_PRESETS.find((x) => x.id === id || x.name.toLowerCase() === id);
    if (p) loadPersona(p.id);
  }, [loadPersona]);

  // for scripted checks and shots
  useEffect(() => {
    window.__app = { run: state.run.status, baseline: state.baseline.status, swaps: state.swaps.length, question: !!state.question };
  });

  // The model-alone receipt is asked for when October or the proof comes into view.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const startBaseline = useCallback(() => {
    const cur = stateRef.current;
    if (cur.merchants.length && cur.location && cur.baseline.status === "idle") void runBaseline();
  }, [runBaseline]);

  // No scroll of ours (v6, H3): after a pick the scene waits at the statement for the reader's own scroll.
  // The model-alone receipt is asked for a section ahead (October), so it is usually on the counter by the proof.
  const onSectionChange = useCallback(
    (sec: SceneSection) => {
      setSection(sec);
      if (sec === "november" || sec === "proof") startBaseline();
    },
    [startBaseline],
  );

  // the nav scrolls; the scene's timeline follows the scroll everywhere (owner, #354: no auto mode)
  const goSection = useCallback((sec: SceneSection) => scene.current?.seek(sec), []);

  // a sample pick starts its run (a replay of the recording); the reader scrolls through it. The door fades out first and the scene
  // eases into the statement
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef(0);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const pick = useCallback(
    (id: string) => {
      if (leaving) return;
      scrollToSection(0, false);
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        loadPersona(id);
        return;
      }
      setLeaving(true);
      leaveTimer.current = window.setTimeout(() => {
        setLeaving(false);
        loadPersona(id);
      }, DOOR_FADE_MS);
    },
    [loadPersona, leaving],
  );

  const { reset: resetFlow, loadFile } = flow;
  // ×: the flow empties and the scene goes back to the door in place (its timeline to 0, no remount)
  const reset = useCallback(() => {
    resetFlow();
    scene.current?.reset();
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, [resetFlow]);

  const pickFile = useCallback(() => file.current?.click(), []);
  const takeFile = useCallback(
    (f: File | undefined) => {
      if (!f) return;
      scrollToSection(0, false);
      // an upload keeps the place typed for a previous upload, never a sample's
      void loadFile(f, { autoRun: !!state.location && !state.personaId });
    },
    [loadFile, state.location, state.personaId],
  );

  // The door doesn't scroll: nothing is on the paper until a pick or a drop. Wheel, touch and the
  // scroll keys are held at the window before the scene's own key handler sees them.
  useEffect(() => {
    if (loaded) return;
    const els = [document.documentElement, document.body];
    const prev = els.map((el) => el.style.overflow);
    els.forEach((el) => (el.style.overflow = "hidden"));
    window.scrollTo(0, 0);
    const hold = (e: Event) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      e.stopImmediatePropagation();
      // a focused stub or button still takes Space
      if (e.key === " " && (e.target as Element | null)?.closest?.("button, a, input, select, textarea")) return;
      e.preventDefault();
    };
    const opts = { capture: true, passive: false } as const;
    window.addEventListener("wheel", hold, opts);
    window.addEventListener("touchmove", hold, opts);
    window.addEventListener("keydown", onKey, true);
    return () => {
      els.forEach((el, k) => (el.style.overflow = prev[k]));
      window.removeEventListener("wheel", hold, opts);
      window.removeEventListener("touchmove", hold, opts);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [loaded]);

  // --- slots ---------------------------------------------------------------

  const crowdedDoor = useCrowdedDoor();

  let left: React.ReactNode = null;
  // Slips, the printer, and on landscape the figure and the swap panel too, ride in the top strip: the
  // one zone the scene frames around (it measures the slot), so no HTML sits on a polaroid, the cup or a receipt.
  let slip: React.ReactNode = null;
  let figure: React.ReactNode = null;
  let hint: React.ReactNode = null;
  let side: React.ReactNode = null;
  // the question (PM, v5): never over the receipt. A wide screen lays it on the counter beside the row it asks about (the scene's
  // `counter` slot, scrolling with the world); a phone folds it to a small tab beside the figure that opens a sheet on tap
  let counter: React.ReactNode = null;
  let tab: React.ReactNode = null;

  if (!loaded) {
    left = (
      <div className={`${s.intake} ${crowdedDoor ? s.crowded : ""} ${leaving ? s.leaving : ""}`}>
        <p className={s.audience} data-door="audience">{AUDIENCE}</p>
        <PersonaStubs onPick={pick} />
        {/* the phone: the place the scene frames our paper's head in (its height from the scene), between the stubs and the slip */}
        <div className={s.paperSlot} data-paper-slot aria-hidden />
        {/* on the bare counter under the receipt, clear of the cup */}
        <div className={s.drop}>
          <StatementSlip onChoose={pickFile} error={state.parseError} />
        </div>
      </div>
    );
  } else {
    figure = <Figure state={paper} money={money} section={section} theirsShown={theirsShown} />;
    const question = state.question && <QuestionSlip key={state.question.id} q={state.question} onAnswer={flow.answer} tab={portrait} />;
    if (portrait) tab = question;
    else counter = question;
    if (state.parseError) slip = <ErrorSlip error={state.parseError} onRetry={pickFile} onClear={reset} />;
    else if (!state.location)
      slip = (
        <PlaceSlip
          rows={state.statement?.transactions.length ?? 0}
          onPlace={(label) => {
            flow.setLocation({ label });
            void flow.start();
          }}
        />
      );
    else if (state.run.status === "error" && state.run.error) slip = <ErrorSlip error={state.run.error} onRetry={() => void flow.start()} onClear={reset} />;
    else if (running) slip = <Printer run={state.run} label={state.replanning.length ? "Re-writing" : undefined} />;
    // the model-alone receipt on its way: the scene's quiet mark where it will lie, not a strip over our paper (v6, M4)
    else if (section === "proof" && state.baseline.status === "error" && state.baseline.error)
      slip = <ErrorSlip error={state.baseline.error} onRetry={() => void runBaseline()} />;
    else if (section === "statement")
      hint = (
        <div className={s.hint} aria-hidden>
          <i />
          scroll
        </div>
      );
    if (!portrait && section !== "proof") side = <SidePanel state={paper} section={section} onReject={flow.reject} onUndo={flow.undo} />;
  }

  // landscape: figure | slip | panel across the strip (the proof's two receipts leave no bare counter
  // for its sentence). Phone: the slip, the figure, then the scroll hint, all in the strip, so the frame's
  // bottom band is the credits' row in every section (v6, H4).
  const band = !loaded ? null : portrait ? (
    <div className={s.bandStack}>
      {slip}
      {(figure || tab) && (
        <div className={s.figRow}>
          {figure ?? <span />}
          {tab}
        </div>
      )}
      {hint}
    </div>
  ) : (
    <div className={s.bandRow}>
      <div>
        {figure}
        {hint}
      </div>
      <div>{slip}</div>
      <div>{side}</div>
    </div>
  );

  // Status for screen readers.
  const live = running
    ? (state.run.statusMessage ?? "Reading the statement")
    : state.run.status === "done"
      ? `${money.kept} taste twins. ${sectionLabel("november", state.statement)} planned.`
      : "";

  return (
    <main
      className={s.page}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        drags.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        drags.current = Math.max(0, drags.current - 1);
        if (!drags.current) setDragging(false);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        drags.current = 0;
        setDragging(false);
        takeFile(e.dataTransfer.files[0]);
      }}
    >
      {loaded && (
        <a href="#receipt-text" className={`${s.skip} ${s.paper} ${s.link}`}>
          Receipt as text
        </a>
      )}
      <h1 className={s.srOnly}>SameTaste</h1>

      <CounterScene
        ref={scene}
        data={paper}
        onReject={flow.reject}
        onUndo={flow.undo}
        onAnswer={flow.answer}
        onSectionChange={onSectionChange}
        onProofVisible={startBaseline}
        onTheirsPrinted={setTheirsShown}
        slots={{
          top: (
            <div className={band ? s.strip : undefined}>
              <TopBar state={state} section={section} onSection={goSection} onReset={reset} />
              {band && <div className={`${s.band} ${s.enter}`}>{band}</div>}
            </div>
          ),
          left: left ?? undefined,
          counter: counter ?? undefined,
        }}
      />

      <TextAlternative state={paper} receipt={receipt} money={money} onReject={flow.reject} onUndo={flow.undo} />

      <p className={s.srOnly} aria-live="polite">
        {live}
      </p>

      <input
        ref={file}
        type="file"
        accept=".csv,text/csv,text/plain"
        hidden
        onChange={(e) => {
          takeFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {dragging && <DropVeil />}
    </main>
  );
}

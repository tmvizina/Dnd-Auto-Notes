import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PageIntro, StatePanel } from "../components.js";
import { ClipPlayer } from "../components/ClipPlayer.js";
import type { RendererTransport, ReviewFlag } from "../transport.js";

export interface ReviewPageProps {
  readonly sessionId: string | null;
  readonly transport: RendererTransport;
}
/**
 * What a keypress means on this page. Reviewing 150 flags has to be a
 * keyboard exercise, so the bindings are the feature — and they are pulled out
 * of the effect so they can be tested without a DOM, the same way
 * `ClipUrlRegistry` is.
 */
export type ReviewKeyAction =
  | { readonly kind: "play" }
  | { readonly kind: "next" }
  | { readonly kind: "previous" }
  | { readonly kind: "candidate"; readonly index: number }
  | { readonly kind: "out_of_character" }
  | { readonly kind: "unresolvable" }
  | { readonly kind: "bulk" }
  | { readonly kind: "rerun" }
  | { readonly kind: "revert" };

export interface ReviewKeyContext {
  readonly hasFlags: boolean;
  readonly hasSession: boolean;
  readonly hasJournal: boolean;
}

export function reviewKeyAction(key: string, context: ReviewKeyContext): ReviewKeyAction | null {
  if (!context.hasFlags) return null;
  // Space and "p" both play. "p" previously moved to the previous flag, which
  // duplicated ArrowLeft and left play reachable only from the space bar.
  if (key === " " || key === "p") return { kind: "play" };
  if (key === "ArrowRight" || key === "n") return { kind: "next" };
  if (key === "ArrowLeft") return { kind: "previous" };
  if (/^[1-9]$/u.test(key)) return { kind: "candidate", index: Number(key) - 1 };
  if (key === "o") return { kind: "out_of_character" };
  if (key === "u") return { kind: "unresolvable" };
  if (key === "b") return { kind: "bulk" };
  if (key === "r") return context.hasSession ? { kind: "rerun" } : null;
  if (key === "v") return context.hasSession && context.hasJournal ? { kind: "revert" } : null;
  return null;
}

function grouped(flags: readonly ReviewFlag[]): readonly ReviewFlag[] {
  return [...flags].sort(
    (a, b) =>
      b.impactS - a.impactS ||
      a.code.localeCompare(b.code) ||
      a.utteranceId.localeCompare(b.utteranceId),
  );
}
export function ReviewPage({ sessionId, transport }: ReviewPageProps): ReactNode {
  const [flags, setFlags] = useState<readonly ReviewFlag[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [offer, setOffer] = useState(false);
  const [journalId, setJournalId] = useState<string>();
  const ordered = useMemo(() => grouped(flags), [flags]);
  const refresh = async (): Promise<void> => {
    if (sessionId === null) return;
    try {
      setError(undefined);
      setFlags((await transport.review.list({ sessionId })).flags);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review flags could not be loaded.");
    }
  };
  useEffect(() => {
    void refresh();
  }, [sessionId, transport]);
  const resolve = async (
    flag: ReviewFlag,
    action: "candidate" | "out_of_character" | "unresolvable",
    candidate?: { label: string; characterId: string | null },
  ): Promise<void> => {
    if (sessionId === null) return;
    setBusy(true);
    try {
      const result = await transport.review.resolve({
        sessionId,
        utteranceId: flag.utteranceId,
        action,
        ...(candidate === undefined
          ? {}
          : { label: candidate.label, characterId: candidate.characterId }),
      });
      setOffer(result.rerunSuggested);
      setJournalId(result.journalId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The correction could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const bulk = async (flag: ReviewFlag): Promise<void> => {
    if (sessionId === null || flag.clusterId === null) return;
    setBusy(true);
    try {
      const result = await transport.review.bulk({
        sessionId,
        clusterId: flag.clusterId,
        action: "candidate",
        ...(flag.candidates[0] === undefined
          ? {}
          : { label: flag.candidates[0].label, characterId: flag.candidates[0].characterId }),
      });
      setOffer(result.rerunSuggested);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The cluster could not be labeled.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const action = reviewKeyAction(event.key, {
        hasFlags: ordered.length > 0,
        hasSession: sessionId !== null,
        hasJournal: journalId !== undefined,
      });
      if (action === null) return;
      const current = ordered[selected];
      switch (action.kind) {
        case "play":
          document.querySelector<HTMLButtonElement>('[aria-label^="Play "]')?.click();
          return;
        case "next":
          setSelected((value) => Math.min(ordered.length - 1, value + 1));
          return;
        case "previous":
          setSelected((value) => Math.max(0, value - 1));
          return;
        case "candidate": {
          const candidate = current?.candidates[action.index];
          if (current !== undefined && candidate !== undefined)
            void resolve(current, "candidate", candidate);
          return;
        }
        case "out_of_character":
          if (current !== undefined) void resolve(current, "out_of_character");
          return;
        case "unresolvable":
          if (current !== undefined) void resolve(current, "unresolvable");
          return;
        case "bulk":
          if (current !== undefined) void bulk(current);
          return;
        case "rerun":
          if (sessionId !== null)
            void transport.review.rerun({
              sessionId,
              utteranceIds: ordered.map((item) => item.utteranceId),
            });
          return;
        case "revert":
          if (sessionId !== null && journalId !== undefined)
            void transport.review
              .revert({ sessionId, journalId })
              .then(() => setJournalId(undefined));
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (sessionId === null)
    return (
      <div className="page-content">
        <StatePanel
          kind="empty"
          message="Choose a session before reviewing flagged spans."
          title="No session selected"
        />
      </div>
    );
  if (error !== undefined)
    return (
      <div className="page-content">
        <StatePanel kind="error" message={error} title="Review unavailable" />
      </div>
    );
  const flag = ordered[selected];
  return (
    <div className="page-content">
      <PageIntro
        description="Resolve uncertain speakers without losing the evidence behind the decision."
        kicker="Quality"
        title="Review"
      />
      {offer ? (
        <div className="review-offer" role="status">
          <span>Profile changed. Re-run persona attribution for affected utterances?</span>
          <button
            className="button"
            onClick={() => {
              void transport.review
                .rerun({ sessionId, utteranceIds: ordered.map((item) => item.utteranceId) })
                .then(() => setOffer(false));
            }}
            type="button"
          >
            Re-run attribution
          </button>
          {journalId === undefined ? null : (
            <button
              className="button button--secondary"
              onClick={() => {
                void transport.review
                  .revert({ sessionId, journalId })
                  .then(() => setJournalId(undefined));
              }}
              type="button"
            >
              Revert profile update
            </button>
          )}
          <button
            className="button button--secondary"
            onClick={() => setOffer(false)}
            type="button"
          >
            Later
          </button>
        </div>
      ) : null}
      {flag?.clusterId === null || flag === undefined ? null : (
        <button
          className="button button--secondary"
          disabled={busy}
          onClick={() => void bulk(flag)}
          type="button"
        >
          Label cluster (B)
        </button>
      )}
      {flag === undefined ? (
        <StatePanel
          kind="empty"
          message="All flagged spans are resolved."
          title="Nothing needs review"
        />
      ) : (
        <section aria-label="Flagged span review" className="review-card">
          <div className="review-card__header">
            <span>
              {selected + 1} of {ordered.length}
            </span>
            <span className="badge">{flag.code}</span>
          </div>
          <p className="review-time">
            {flag.timestampS.toFixed(2)}s · {flag.speaker}
          </p>
          <p className="review-text">{flag.text || "Transcript text unavailable"}</p>
          <details>
            <summary>Evidence</summary>
            <pre>{JSON.stringify(flag.evidence, null, 2)}</pre>
          </details>
          <div aria-label="Candidate labels" className="review-candidates">
            {flag.candidates.map((candidate, index) => (
              <button
                className="button button--secondary"
                disabled={busy}
                key={`${candidate.label}-${candidate.characterId ?? "none"}`}
                onClick={() => void resolve(flag, "candidate", candidate)}
                type="button"
              >
                <kbd>{index + 1}</kbd> {candidate.label} {candidate.characterId ?? ""} (
                {candidate.score.toFixed(2)})
              </button>
            ))}
          </div>
          <div className="review-actions">
            <button
              className="button button--secondary"
              disabled={busy}
              onClick={() => void resolve(flag, "out_of_character")}
              type="button"
            >
              Mark out of character
            </button>
            <button
              className="button button--secondary"
              disabled={busy}
              onClick={() => void resolve(flag, "unresolvable")}
              type="button"
            >
              Unresolvable
            </button>
          </div>
          <ClipPlayer
            label={`Audio for ${flag.utteranceId}`}
            load={async () => {
              const clip = await transport.review.clip({
                sessionId,
                utteranceId: flag.utteranceId,
              });
              const response = await fetch(clip.path);
              if (!response.ok) throw new Error("Clip could not be loaded.");
              return response.blob();
            }}
          />
          <div className="review-nav">
            <button
              className="button button--secondary"
              disabled={selected === 0}
              onClick={() => setSelected((value) => value - 1)}
              type="button"
            >
              Previous
            </button>
            <button
              className="button button--secondary"
              disabled={selected >= ordered.length - 1}
              onClick={() => setSelected((value) => value + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

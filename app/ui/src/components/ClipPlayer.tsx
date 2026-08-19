import { useEffect, useRef, useState, type ReactNode } from "react";

let activeAudio: HTMLAudioElement | null = null;
export interface ObjectUrlApi {
  readonly revokeObjectURL: (url: string) => void;
}
export class ClipUrlRegistry {
  private active: { readonly element: HTMLAudioElement; readonly url: string } | null = null;
  constructor(private readonly api: ObjectUrlApi = URL) {}
  activate(element: HTMLAudioElement, url: string): void {
    this.release();
    this.active = { element, url };
  }
  release(element?: HTMLAudioElement): void {
    if (this.active !== null && (element === undefined || this.active.element === element)) {
      this.active.element.removeAttribute("src");
      this.api.revokeObjectURL(this.active.url);
      this.active = null;
    }
  }
  get activeUrl(): string | null {
    return this.active?.url ?? null;
  }
}
const registry = new ClipUrlRegistry();
function release(): void {
  const element = activeAudio;
  activeAudio = null;
  if (element !== null) {
    element.pause();
    element.removeAttribute("src");
  }
  registry.release(element ?? undefined);
}

export interface ClipPlayerProps {
  readonly label: string;
  readonly load: () => Promise<Blob>;
  readonly onError?: (message: string) => void;
}
export function ClipPlayer({ label, load, onError }: ClipPlayerProps): ReactNode {
  const audio = useRef<HTMLAudioElement>(null);
  const requestId = useRef(0);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const stop = (): void => {
    requestId.current += 1;
    if (activeAudio === audio.current) release();
    setPlaying(false);
  };
  const play = async (): Promise<void> => {
    const element = audio.current;
    if (element === null) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      release();
      const blob = await load();
      if (currentRequest !== requestId.current || audio.current !== element) return;
      const url = URL.createObjectURL(blob);
      activeAudio = element;
      registry.activate(element, url);
      element.src = url;
      await element.play();
      setPlaying(true);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "The clip could not be played.");
      stop();
    } finally {
      setLoading(false);
    }
  };
  useEffect(
    () => () => {
      if (activeAudio === audio.current) release();
    },
    [],
  );
  return (
    <div className="clip-player">
      <button
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        className="button button--secondary"
        disabled={loading}
        onClick={() => (playing ? stop() : void play())}
        type="button"
      >
        {loading ? "Loading..." : playing ? "Pause" : "Play"}
      </button>
      <audio
        aria-label={label}
        onEnded={stop}
        onPause={() => {
          if (activeAudio === audio.current && !audio.current?.ended) stop();
        }}
        ref={audio}
      />
    </div>
  );
}

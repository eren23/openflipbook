import {
  DEFAULTS,
  type LoopyStrategy,
  type LTXStreamStartMessage,
} from "@openflipbook/config";
import { parseLTXF } from "./ltxf-parser";
import { attachMSE, canPlayLTXStream } from "./mse-player";

export type StreamStatus =
  | "idle"
  | "connecting"
  | "waiting_for_first_chunk"
  | "playing"
  | "degraded_to_image"
  | "error";

export interface StreamClient {
  status: StreamStatus;
  close(): void;
}

export interface StreamConfig {
  wsUrl: string;
  video: HTMLVideoElement;
  prompt: string;
  startImageDataUrl: string;
  onStatus?: (status: StreamStatus) => void;
  onError?: (message: string) => void;
  /** Dev knob: override the anchor-loop strategy per stream. Settable from
   * devtools via localStorage("openflipbook.ltxLoopyStrategy") at the call
   * site; absent -> DEFAULTS.loopyStrategy. */
  loopyStrategy?: LoopyStrategy;
}

/** How many times a dropped socket is re-dialed before giving up. */
export const MAX_RECONNECTS = 3;

/** Backoff for reconnect attempt N (0-based): 500ms, 1s, 2s, capped 4s.
 * Pure — pinned by tests. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(4000, 500 * 2 ** attempt);
}

function newStreamId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `ltx_stream_${crypto.randomUUID()}`;
  }
  return `ltx_stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function startLTXStream(config: StreamConfig): StreamClient {
  const statusRef = { current: "connecting" as StreamStatus };
  const setStatus = (status: StreamStatus) => {
    statusRef.current = status;
    config.onStatus?.(status);
  };

  if (!canPlayLTXStream()) {
    setStatus("degraded_to_image");
    config.onError?.("Browser does not support MediaSource with H.264 fMP4.");
    return { get status() {
      return statusRef.current;
    }, close() {
      // noop
    } };
  }

  const controller = attachMSE(config.video);
  // One session id across re-dials: the worker resumes the SAME stream from
  // `position` instead of starting a new generation.
  const sessionId = newStreamId();
  let ended = false;
  const endStream = () => {
    if (ended) return;
    ended = true;
    controller.endOfStream();
  };
  let socket: WebSocket | null = null;
  let lastSequence = -1;
  let gotFinal = false;
  let closedByUser = false;
  let reconnects = 0;
  let reconnectTimer: number | null = null;

  const connect = () => {
    socket = new WebSocket(config.wsUrl);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      const msg: LTXStreamStartMessage = {
        action: "start",
        session_id: sessionId,
        prompt: config.prompt,
        width: DEFAULTS.videoWidth,
        height: DEFAULTS.videoHeight,
        num_frames: DEFAULTS.numFrames,
        frame_rate: DEFAULTS.frameRate,
        max_segments: 9999,
        loopy_mode: true,
        loopy_strategy: config.loopyStrategy ?? DEFAULTS.loopyStrategy,
        start_image: config.startImageDataUrl,
        target_image: config.startImageDataUrl,
        // Resume point: the next segment after the last one we appended.
        // 0 on a fresh stream — identical to the pre-hardening message.
        position: lastSequence + 1,
      };
      socket?.send(JSON.stringify(msg));
      if (lastSequence < 0) setStatus("waiting_for_first_chunk");
    });

    socket.addEventListener("message", async (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      try {
        const packet = parseLTXF(event.data);
        const seq = packet.header.sequence;
        // After a resume the worker may replay segments we already appended
        // — drop duplicates (re-appending confuses the SourceBuffer); init
        // segments always pass (a re-dial needs the codec init again).
        if (!packet.header.is_init_segment && seq <= lastSequence) {
          if (packet.header.final) {
            gotFinal = true;
            endStream();
          }
          return;
        }
        await controller.appendPacket(packet);
        if (!packet.header.is_init_segment) {
          lastSequence = Math.max(lastSequence, seq);
        }
        if (statusRef.current !== "playing") {
          setStatus("playing");
          void config.video.play().catch(() => {
            // Autoplay may be blocked; user must click the video. Non-fatal.
          });
        }
        if (packet.header.final) {
          gotFinal = true;
          endStream();
        }
      } catch (err) {
        // Corrupt data is not a network blip — no retry.
        config.onError?.((err as Error).message);
        setStatus("error");
      }
    });

    socket.addEventListener("close", (event) => {
      if (closedByUser || gotFinal || statusRef.current === "error") {
        if (gotFinal) endStream();
        return;
      }
      if (event.code === 1000) {
        // A clean server close without `final`: the worker is done — end
        // playback gracefully (the pre-hardening behaviour).
        endStream();
        return;
      }
      // Dropped mid-stream: re-dial and resume from lastSequence + 1.
      if (reconnects < MAX_RECONNECTS) {
        const delay = reconnectDelayMs(reconnects);
        reconnects += 1;
        reconnectTimer = window.setTimeout(connect, delay);
        return;
      }
      setStatus("error");
      config.onError?.("Stream dropped and could not be resumed.");
    });

    socket.addEventListener("error", () => {
      // `close` always follows and drives the retry/teardown decision.
    });
  };
  connect();

  return {
    get status() {
      return statusRef.current;
    },
    close() {
      closedByUser = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      controller.destroy();
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close(1000);
      }
    },
  };
}

export function getWSUrl(): string | null {
  return process.env.NEXT_PUBLIC_LTX_WS_URL || null;
}

import {
  DEFAULTS,
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
  const socket = new WebSocket(config.wsUrl);
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    const msg: LTXStreamStartMessage = {
      action: "start",
      session_id: newStreamId(),
      prompt: config.prompt,
      width: DEFAULTS.videoWidth,
      height: DEFAULTS.videoHeight,
      num_frames: DEFAULTS.numFrames,
      frame_rate: DEFAULTS.frameRate,
      max_segments: 9999,
      loopy_mode: true,
      loopy_strategy: DEFAULTS.loopyStrategy,
      start_image: config.startImageDataUrl,
      target_image: config.startImageDataUrl,
      position: 0,
    };
    socket.send(JSON.stringify(msg));
    setStatus("waiting_for_first_chunk");
  });

  socket.addEventListener("message", async (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    try {
      const packet = parseLTXF(event.data);
      await controller.appendPacket(packet);
      if (statusRef.current !== "playing") {
        setStatus("playing");
        void config.video.play().catch(() => {
          // Autoplay may be blocked; user must click the video. Non-fatal.
        });
      }
      if (packet.header.final) {
        controller.endOfStream();
      }
    } catch (err) {
      config.onError?.((err as Error).message);
      setStatus("error");
    }
  });

  socket.addEventListener("error", () => {
    setStatus("error");
    config.onError?.("WebSocket connection error.");
  });

  socket.addEventListener("close", () => {
    if (statusRef.current !== "error" && statusRef.current !== "degraded_to_image") {
      controller.endOfStream();
    }
  });

  return {
    get status() {
      return statusRef.current;
    },
    close() {
      controller.destroy();
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000);
      }
    },
  };
}

export function hasWSStreaming(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_LTX_WS_URL);
}

export function getWSUrl(): string | null {
  return process.env.NEXT_PUBLIC_LTX_WS_URL || null;
}

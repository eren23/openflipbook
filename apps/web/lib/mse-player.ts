import { codecsFromHeader, type LTXFPacket } from "./ltxf-parser";

export interface MSEController {
  appendPacket(packet: LTXFPacket): Promise<void>;
  endOfStream(): void;
  destroy(): void;
}

export function canPlayLTXStream(): boolean {
  if (typeof window === "undefined") return false;
  if (!("MediaSource" in window)) return false;
  return window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"');
}

/**
 * Attach a MediaSource to a <video> element and return a controller that
 * appends LTXF payloads into its SourceBuffer. The first packet must have
 * `is_init_segment: true`.
 */
export function attachMSE(video: HTMLVideoElement): MSEController {
  const mediaSource = new MediaSource();
  const blobUrl = URL.createObjectURL(mediaSource);
  video.src = blobUrl;

  let sourceBuffer: SourceBuffer | null = null;
  const pending: Uint8Array[] = [];
  let destroyed = false;

  const drain = (): void => {
    if (destroyed || !sourceBuffer) return;
    if (sourceBuffer.updating) return;
    const next = pending.shift();
    if (!next) return;
    try {
      sourceBuffer.appendBuffer(next as BufferSource);
    } catch (err) {
      console.error("[ltx-mse] appendBuffer failed", err);
    }
  };

  const ensureSourceBuffer = (mime: string): void => {
    if (sourceBuffer) return;
    if (mediaSource.readyState !== "open") return;
    sourceBuffer = mediaSource.addSourceBuffer(mime);
    sourceBuffer.mode = "sequence";
    sourceBuffer.addEventListener("updateend", drain);
  };

  mediaSource.addEventListener("sourceopen", () => {
    drain();
  });

  return {
    async appendPacket(packet: LTXFPacket): Promise<void> {
      if (destroyed) return;
      if (packet.header.is_init_segment) {
        const mime = `${packet.header.media_type}; codecs="${codecsFromHeader(packet.header)}"`;
        ensureSourceBuffer(mime);
      }
      pending.push(packet.payload);
      drain();
      if (packet.header.final) {
        await waitForDrain(() => pending.length === 0 && !sourceBuffer?.updating);
        if (!destroyed && mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      }
    },
    endOfStream(): void {
      if (!destroyed && mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream();
        } catch {
          // already ended
        }
      }
    },
    destroy(): void {
      destroyed = true;
      pending.length = 0;
      try {
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      } catch {
        // noop
      }
      URL.revokeObjectURL(blobUrl);
    },
  };
}

function waitForDrain(predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) resolve();
      else setTimeout(tick, 20);
    };
    tick();
  });
}

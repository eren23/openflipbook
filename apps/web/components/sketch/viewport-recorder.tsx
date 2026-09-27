"use client";
import { useEffect, useRef, useState } from "react";
import { Download, Square, Video } from "lucide-react";
import s from "./world-editor.module.css";

export default function ViewportRecorder({ canvas, boundary, viewKey }: { canvas: () => HTMLCanvasElement | null; boundary: unknown; viewKey: string }) {
  const active = useRef<{ recorder: MediaRecorder; stream: MediaStream; source: HTMLCanvasElement; timer: ReturnType<typeof setTimeout> } | null>(null);
  const mounted = useRef(true), resultUrl = useRef<string | null>(null);
  const [recording, setRecording] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<{ url: string; extension: string } | null>(null);
  const stop = () => {
    const current = active.current;
    if (!current) return;
    clearTimeout(current.timer);
    if (current.recorder.state !== "inactive") current.recorder.stop();
    current.stream.getTracks().forEach(track => track.stop());
    delete current.source.dataset.recording;
    active.current = null;
    if (mounted.current) setRecording(false);
  };
  useEffect(() => { stop(); }, [boundary, viewKey]); // A recording belongs to one rendered scene, not a replacement canvas.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; stop();
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
    };
  }, []);
  function start() {
    if (active.current) return;
    setError("");
    let stream: MediaStream | undefined;
    try {
      const source = canvas();
      if (!source) throw new Error("Wait for the scene to finish loading.");
      if (!source.captureStream || typeof MediaRecorder === "undefined") throw new Error("Video recording is unavailable in this browser.");
      const mimeType = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("This browser has no supported video encoder.");
      stream = source.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      const chunks: Blob[] = [];
      let bytes = 0, failed = false;
      recorder.ondataavailable = event => {
        if (!event.data.size) return;
        chunks.push(event.data); bytes += event.data.size;
        if (bytes >= 64 * 1024 * 1024) stop();
      };
      recorder.onerror = () => { failed = true; stop(); if (mounted.current) setError("Recording failed. No replacement video was created."); };
      recorder.onstop = () => {
        if (!mounted.current || failed) return;
        if (!chunks.length) { setError("The browser returned an empty recording."); return; }
        if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
        const url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
        resultUrl.current = url;
        setResult({ url, extension: recorder.mimeType.startsWith("video/mp4") ? "mp4" : "webm" });
      };
      recorder.start(1000);
      source.dataset.recording = "true";
      active.current = { recorder, stream, source, timer: setTimeout(stop, 120_000) };
      setRecording(true);
    } catch (e) {
      stream?.getTracks().forEach(track => track.stop());
      setError((e as Error).message);
    }
  }
  return <div className={s.viewportRecorder} role="group" aria-label="Viewport video">
    <button aria-label={recording ? "Stop viewport recording" : "Record viewport video"} title={recording ? "Stop recording" : "Record silent viewport video (up to 2 minutes)"} onClick={recording ? stop : start}>
      {recording ? <Square size={16}/> : <Video size={16}/>}
    </button>
    {recording && <span role="status">Recording</span>}
    {result && !recording && <a href={result.url} download={`OpenFlipbook-viewport-${new Date().toISOString().replaceAll(":", "-")}.${result.extension}`} aria-label="Download viewport video" title="Download viewport video"><Download size={16}/></a>}
    {error && <span role="alert">{error}</span>}
  </div>;
}

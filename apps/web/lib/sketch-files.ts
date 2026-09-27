import JSZip from "jszip";
import {
  blankSketch,
  MAX_SKETCH_BYTES,
  parseSketch,
  rasterDataUrl,
  type SketchState,
} from "./sketch-types";

async function boundedText(
  entry: JSZip.JSZipObject,
  limit: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    // JSZip exposes this streaming API at runtime but omits it from JSZipObject's types.
    const stream = (
      entry as JSZip.JSZipObject & {
        internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
      }
    ).internalStream("uint8array");
    stream.on("data", (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > limit) {
        stream.pause();
        reject(new Error("Bundle entry exceeds its size limit"));
      } else chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(new TextDecoder().decode(bytes));
    });
    stream.resume();
  });
}

export async function fileData(file: Blob): Promise<string> {
  if (file.size > MAX_SKETCH_BYTES)
    throw new Error("Image exceeds the 8 MiB limit");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
export async function imageSize(src: string) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return { width: image.naturalWidth, height: image.naturalHeight };
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function importSketch(
  file: File,
): Promise<{ state: SketchState; source?: string }> {
  if (file.size > 20 * 1024 * 1024) throw new Error("Import exceeds 20 MiB");
  if (file.name.endsWith(".ofb-sketch")) {
    const zip = await JSZip.loadAsync(file);
    const manifest = zip.file("sketch.json");
    if (!manifest) throw new Error("Sketch bundle is missing its drawing");
    const text = await boundedText(manifest, MAX_SKETCH_BYTES);
    if (text.length > MAX_SKETCH_BYTES) throw new Error("Drawing is too large");
    const state = parseSketch(JSON.parse(text));
    const sourceFile = zip.file("source.txt");
    const source = sourceFile
      ? await boundedText(sourceFile, MAX_SKETCH_BYTES * 1.4)
      : undefined;
    if (source && !rasterDataUrl(source))
      throw new Error("Invalid source image in bundle");
    return { state, ...(source ? { source } : {}) };
  }
  const raw = JSON.parse(await file.text());
  if (raw.version === 1 && raw.scene) return { state: parseSketch(raw) };
  if (raw.type !== "excalidraw" || !Array.isArray(raw.elements))
    throw new Error("Choose an Excalidraw scene or OpenFlipbook bundle");
  if (raw.elements.length > 5000)
    throw new Error("Drawing has too many elements");
  const elements = raw.elements.filter(
    (e: { isDeleted?: boolean }) => !e.isDeleted,
  );
  const xs = elements.map((e: { x: number }) => e.x),
    ys = elements.map((e: { y: number }) => e.y);
  const minX = Math.min(0, ...xs),
    minY = Math.min(0, ...ys);
  const width = Math.max(
    1024,
    ...elements.map(
      (e: { x: number; width: number }) => e.x + e.width - minX + 24,
    ),
  );
  const height = Math.max(
    768,
    ...elements.map(
      (e: { y: number; height: number }) => e.y + e.height - minY + 24,
    ),
  );
  return {
    state: parseSketch({
      ...blankSketch(),
      title: file.name.replace(/\.[^.]+$/, ""),
      frame: { width: Math.ceil(width), height: Math.ceil(height) },
      scene: {
        elements: elements.map((e: Record<string, unknown>) => ({
          ...e,
          x: Number(e.x) - minX,
          y: Number(e.y) - minY,
        })),
        files: raw.files ?? {},
      },
    }),
  };
}
export async function exportBundle(
  state: SketchState,
  source: string | null,
  guide: string,
  mask?: string,
) {
  const zip = new JSZip();
  zip.file("sketch.json", JSON.stringify(state));
  zip.file(
    "scene.excalidraw",
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "openflipbook",
      elements: state.scene.elements,
      files: state.scene.files,
      appState: { viewBackgroundColor: "#ffffff" },
    }),
  );
  if (source) zip.file("source.txt", source);
  zip.file("preview.png", guide.split(",")[1]!, { base64: true });
  if (mask) zip.file("mask.png", mask.split(",")[1]!, { base64: true });
  return zip.generateAsync({ type: "blob" });
}

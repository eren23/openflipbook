"use client";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  exportToCanvas,
  CaptureUpdateAction,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  BinaryFiles,
  AppState,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeleted,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import { Circle, Paintbrush, Square, Pencil, Scan } from "lucide-react";
import type { SketchScene, SketchState } from "@/lib/sketch-types";
import "@excalidraw/excalidraw/index.css";
import s from "./sketch.module.css";

export interface SketchCanvasHandle {
  export: (requireMask?: boolean) => Promise<{ guide: string; mask?: string }>;
}
interface Props {
  state: SketchState;
  source: string | null;
  disabled: boolean;
  onChange: (scene: SketchScene) => void;
}

const SketchCanvas = forwardRef<SketchCanvasHandle, Props>(
  function SketchCanvas({ state, source, disabled, onChange }, ref) {
    const api = useRef<ExcalidrawImperativeAPI | null>(null);
    const [region, setRegion] = useState(false);
    const mode = useRef(false);
    const [initial] = useState(() => {
      const convertedFrame = convertToExcalidrawElements(
        [
          {
            type: "frame",
            id: "ofb-frame",
            children: [],
            name: "Artwork",
            locked: true,
          },
        ],
        { regenerateIds: false },
      )[0] as ExcalidrawFrameLikeElement;
      // The skeleton converter derives frame bounds from children, even when empty.
      const frame = {
        ...convertedFrame,
        x: 0,
        y: 0,
        width: state.frame.width,
        height: state.frame.height,
      };
      const background = source
        ? convertToExcalidrawElements(
            [
              {
                type: "image",
                id: "ofb-source",
                x: 0,
                y: 0,
                width: state.frame.width,
                height: state.frame.height,
                fileId: "ofb-source-file" as FileId,
                locked: true,
                frameId: frame.id,
              },
            ],
            { regenerateIds: false },
          )[0]
        : null;
      const files = {
        ...state.scene.files,
        ...(source
          ? {
              "ofb-source-file": {
                id: "ofb-source-file",
                dataURL: source,
                mimeType: "image/png",
                created: 0,
              },
            }
          : {}),
      } as BinaryFiles;
      const availableWidth =
        window.innerWidth - (window.innerWidth > 720 ? 380 : 60);
      const availableHeight = window.innerHeight - 360;
      const zoom = {
        value: Math.max(
          0.1,
          Math.min(
            1,
            availableWidth / state.frame.width,
            availableHeight / state.frame.height,
          ),
        ),
      } as AppState["zoom"];
      return {
        frame,
        background,
        files,
        zoom,
        elements: [
          frame,
          ...(background ? [background] : []),
          ...state.scene.elements,
        ] as ExcalidrawElement[],
      };
    });
    const last = useRef(JSON.stringify(state.scene));
    useImperativeHandle(
      ref,
      () => ({
        export: async (requireMask = false) => {
          const editor = api.current;
          if (!editor) throw new Error("Drawing is still loading");
          const elements = editor
            .getSceneElements()
            .filter((e) => !e.isDeleted);
          const annotations = elements.filter(
            (e) => e.customData?.role !== "mask",
          );
          const masks = elements.filter((e) => e.customData?.role === "mask");
          const canvas = await exportToCanvas({
            elements: annotations as NonDeleted<ExcalidrawElement>[],
            files: editor.getFiles(),
            exportingFrame: initial.frame,
            exportPadding: 0,
            appState: {
              exportBackground: true,
              exportWithDarkMode: false,
              viewBackgroundColor: "#ffffff",
            },
          });
          if (
            canvas.width !== state.frame.width ||
            canvas.height !== state.frame.height
          )
            throw new Error("Drawing export changed the image frame");
          let mask: string | undefined;
          if (source && state.scope === "region") {
            if (!masks.length && requireMask)
              throw new Error("Select an editable region first");
            const white = masks.map((e) => ({
              ...e,
              opacity: 100,
              strokeColor: "#ffffff",
              backgroundColor:
                e.type === "freedraw" ? "transparent" : "#ffffff",
              fillStyle: "solid",
              roughness: 0,
            }));
            const maskCanvas = await exportToCanvas({
              elements: [
                initial.frame,
                ...white,
              ] as NonDeleted<ExcalidrawElement>[],
              files: {},
              exportingFrame: initial.frame,
              exportPadding: 0,
              appState: {
                exportBackground: true,
                exportWithDarkMode: false,
                viewBackgroundColor: "#000000",
              },
            });
            if (masks.length) mask = maskCanvas.toDataURL("image/png");
          }
          return {
            guide: canvas.toDataURL("image/png"),
            ...(mask ? { mask } : {}),
          };
        },
      }),
      [initial.frame, source, state.frame, state.scope],
    );
    function chooseRegion(tool: "rectangle" | "ellipse" | "freedraw") {
      mode.current = true;
      setRegion(true);
      api.current?.updateScene({
        appState: {
          currentItemStrokeColor: "#148aa8",
          currentItemBackgroundColor:
            tool === "freedraw" ? "transparent" : "#148aa8",
          currentItemFillStyle: "solid",
          currentItemOpacity: 30,
          currentItemRoughness: 0,
          currentItemStrokeWidth: tool === "freedraw" ? 20 : 1,
        },
      });
      api.current?.setActiveTool({ type: tool });
    }
    return (
      <div className={s.canvasWrap}>
        <div className={s.canvasModes}>
          <button
            title="Draw instructions"
            aria-pressed={!region}
            disabled={disabled}
            onClick={() => {
              mode.current = false;
              setRegion(false);
              api.current?.updateScene({
                appState: {
                  currentItemStrokeColor: "#d94841",
                  currentItemBackgroundColor: "transparent",
                  currentItemOpacity: 100,
                  currentItemStrokeWidth: 2,
                  currentItemRoughness: 0,
                },
              });
              api.current?.setActiveTool({ type: "freedraw" });
            }}
          >
            <Pencil size={16} />
            {source ? "Annotate" : "Draw"}
          </button>
          {source && state.scope === "region" && (
            <span
              className={s.regionTools}
              role="group"
              aria-label="Editable region"
            >
              <span>Edit area</span>
              <button
                title="Rectangle region"
                aria-label="Rectangle region"
                aria-pressed={region}
                disabled={disabled}
                onClick={() => chooseRegion("rectangle")}
              >
                <Square size={16} />
              </button>
              <button
                title="Ellipse region"
                aria-label="Ellipse region"
                disabled={disabled}
                onClick={() => chooseRegion("ellipse")}
              >
                <Circle size={16} />
              </button>
              <button
                title="Brush region"
                aria-label="Brush region"
                disabled={disabled}
                onClick={() => chooseRegion("freedraw")}
              >
                <Paintbrush size={16} />
              </button>
            </span>
          )}
          <button
            className={s.fit}
            title="Fit artwork"
            aria-label="Fit artwork"
            onClick={() =>
              api.current?.scrollToContent(initial.frame, {
                fitToViewport: true,
                viewportZoomFactor: 0.75,
              })
            }
          >
            <Scan size={16} />
          </button>
        </div>
        <div
          className={s.drawing}
          data-region={region}
          data-testid="sketch-canvas"
        >
          <Excalidraw
            initialData={{
              elements: initial.elements,
              files: initial.files,
              appState: {
                zoom: initial.zoom,
                viewBackgroundColor: "#f5f6f5",
                currentItemStrokeColor: "#d94841",
                currentItemRoughness: 0,
                currentItemFontFamily: 2,
                frameRendering: {
                  enabled: true,
                  clip: true,
                  name: false,
                  outline: true,
                },
              },
              scrollToContent: true,
            }}
            excalidrawAPI={(value) => {
              api.current = value;
            }}
            viewModeEnabled={disabled}
            theme="light"
            autoFocus
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                changeViewBackgroundColor: false,
                toggleTheme: false,
              },
            }}
            onChange={(elements, appState, files) => {
              // Replacing an in-progress element interrupts Excalidraw's pointer gesture.
              if (appState.isLoading || appState.newElement) return;
              const editable = elements.filter(
                (e) =>
                  e.id !== "ofb-frame" && e.id !== "ofb-source" && !e.isDeleted,
              );
              const currentFrame = elements.find(
                (e) => e.id === initial.frame.id,
              );
              const currentSource = elements.find((e) => e.id === "ofb-source");
              let needsUpdate =
                !currentFrame ||
                currentFrame.isDeleted ||
                !currentFrame.locked ||
                currentFrame.width !== initial.frame.width ||
                currentFrame.height !== initial.frame.height ||
                currentFrame.x !== 0 ||
                currentFrame.y !== 0 ||
                Boolean(
                  initial.background &&
                    (!currentSource ||
                      currentSource.isDeleted ||
                      !currentSource.locked ||
                      currentSource.x !== 0 ||
                      currentSource.y !== 0 ||
                      currentSource.width !== state.frame.width ||
                      currentSource.height !== state.frame.height),
                );
              const next = editable.map((e) => {
                if (e.customData?.role && e.frameId === initial.frame.id)
                  return e;
                needsUpdate = true;
                const role =
                  e.customData?.role ??
                  (mode.current &&
                  ["rectangle", "ellipse", "freedraw"].includes(e.type)
                    ? "mask"
                    : "instruction");
                return {
                  ...e,
                  frameId: initial.frame.id,
                  customData: { ...e.customData, role },
                };
              });
              if (needsUpdate)
                api.current?.updateScene({
                  elements: [
                    initial.frame,
                    ...(initial.background ? [initial.background] : []),
                    ...next,
                  ],
                  captureUpdate: CaptureUpdateAction.NEVER,
                });
              const fileIds = new Set(
                next
                  .filter((e) => e.type === "image")
                  .map((e) => (e as { fileId?: string }).fileId),
              );
              const scene = {
                elements: next,
                files: Object.fromEntries(
                  Object.entries(files).filter(([id]) => fileIds.has(id)),
                ),
              } as unknown as SketchScene;
              const serialized = JSON.stringify(scene);
              if (serialized !== last.current && !appState.isLoading) {
                last.current = serialized;
                onChange(scene);
              }
            }}
          >
            <MainMenu>
              <MainMenu.DefaultItems.Help />
              <MainMenu.DefaultItems.ClearCanvas />
            </MainMenu>
          </Excalidraw>
        </div>
      </div>
    );
  },
);
export default SketchCanvas;

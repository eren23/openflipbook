"use client";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import s from "./world-editor.module.css";

export default function IllustrationSurface({ target, width, height, children, status }: {
  target?: HTMLElement | null | undefined; width: number; height: number; children: ReactNode; status?: string;
}) {
  const surface = <div className={s.regionImage} style={{ position: "relative", aspectRatio: `${width} / ${height}`, flexShrink: 0, width: target ? `min(100cqw, calc((100cqh - ${status ? 80 : 40}px) * ${width / height}))` : `min(100%, ${320 * width / height}px)` }}>{children}</div>;
  return target ? createPortal(<div className={s.illustrationSurface}>{status && <p className={s.illustrationSourceStatus}>{status}</p>}{surface}</div>, target) : surface;
}

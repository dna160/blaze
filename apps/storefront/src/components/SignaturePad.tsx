"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

/**
 * PRD go-live §7.2 — sign the rental agreement with a finger or a mouse.
 *
 * Pointer events cover touch, pen and mouse in one path. The canvas backing
 * store is sized by devicePixelRatio so strokes stay sharp on phones, and
 * `touch-action: none` stops the page scrolling while a finger draws. The
 * PNG is exported on a transparent background so it sits cleanly in the PDF's
 * signature block.
 */

export interface SignaturePadHandle {
  /** PNG data URL, or null when nothing has been drawn. */
  toPng(): string | null;
  clear(): void;
}

const HEIGHT = 180;

export const SignaturePad = forwardRef<SignaturePadHandle, { onChange?: (hasInk: boolean) => void; disabled?: boolean }>(function SignaturePad(
  { onChange, disabled },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  const setInk = useCallback(
    (v: boolean) => {
      setHasInk(v);
      onChange?.(v);
    },
    [onChange],
  );

  // Size the backing store to the element × devicePixelRatio. Resizing a canvas
  // wipes it, so this only runs on mount and when the width really changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      if (canvas.width === Math.round(width * dpr)) return;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#0f172a";
      setInk(false);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [setInk]);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    last.current = p;
    // A tap leaves a dot, so an initial counts as ink.
    const ctx = e.currentTarget.getContext("2d");
    if (ctx) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = "#0f172a";
      ctx.fill();
    }
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    e.preventDefault();
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!hasInk) setInk(true);
  }

  function up(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!hasInk) setInk(true);
  }

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    setInk(false);
  }, [setInk]);

  useImperativeHandle(ref, () => ({
    toPng: () => (hasInk && canvasRef.current ? canvasRef.current.toDataURL("image/png") : null),
    clear,
  }));

  return (
    <div>
      <div className="relative rounded-lg border-2 border-dashed border-brand-600/30 bg-white">
        <canvas
          ref={canvasRef}
          style={{ height: HEIGHT, touchAction: "none" }}
          className={`block w-full ${disabled ? "cursor-not-allowed opacity-60" : "cursor-crosshair"}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={up}
          aria-label="Signature pad — draw your signature"
          role="img"
        />
        {!hasInk && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-brand-700/40">
            Tanda tangan di sini / Sign here
          </p>
        )}
        <div className="pointer-events-none absolute bottom-8 left-6 right-6 border-b border-brand-600/20" />
      </div>
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={clear} disabled={disabled || !hasInk} className="text-xs text-brand-700/60 underline disabled:opacity-40">
          Hapus / Clear
        </button>
      </div>
    </div>
  );
});

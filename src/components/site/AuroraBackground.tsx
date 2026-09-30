import { useEffect, useRef } from "react";

/**
 * Slow-moving ambient gradient behind the page. Two large blurred radial washes
 * drift on GPU-composited transforms only, so the animation stays off the main
 * thread. Disabled entirely when the user prefers reduced motion.
 */
export function AuroraBackground() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    let frame = 0;
    let t = 0;

    const step = () => {
      t += 0.0016;
      const x = Math.sin(t) * 6;
      const y = Math.cos(t * 0.8) * 5;

      el.style.setProperty("--drift-x", `${x.toFixed(2)}%`);
      el.style.setProperty("--drift-y", `${y.toFixed(2)}%`);

      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-zinc-950"
      style={
        {
          "--drift-x": "0%",
          "--drift-y": "0%",
        } as React.CSSProperties
      }
    >
      <div
        className="gpu absolute -left-[20%] -top-[25%] h-[70vh] w-[70vw] rounded-full opacity-45 blur-[120px]"
        style={{
          background:
            "radial-gradient(circle at 30% 30%, hsl(265 90% 60% / 0.55), transparent 65%)",
          transform: "translate3d(var(--drift-x), var(--drift-y), 0)",
        }}
      />
      <div
        className="gpu absolute -right-[15%] top-[10%] h-[60vh] w-[55vw] rounded-full opacity-40 blur-[130px]"
        style={{
          background:
            "radial-gradient(circle at 60% 40%, hsl(190 95% 55% / 0.5), transparent 65%)",
          transform: "translate3d(calc(var(--drift-x) * -1), calc(var(--drift-y) * 1.4), 0)",
        }}
      />
      <div
        className="gpu absolute bottom-[-20%] left-[25%] h-[55vh] w-[60vw] rounded-full opacity-30 blur-[140px]"
        style={{
          background:
            "radial-gradient(circle at 50% 50%, hsl(280 80% 55% / 0.45), transparent 70%)",
          transform: "translate3d(calc(var(--drift-x) * 0.6), calc(var(--drift-y) * -0.8), 0)",
        }}
      />

      {/* Fine ambient lines that sweep across the field. */}
      <div className="absolute inset-0 opacity-[0.14]">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="gpu absolute h-px w-1/3"
            style={{
              top: `${18 + i * 17}%`,
              left: 0,
              background:
                "linear-gradient(90deg, transparent, hsl(265 90% 75% / 0.8), transparent)",
              animation: `line-sweep ${11 + i * 3}s linear infinite`,
              animationDelay: `${i * 2.4}s`,
            }}
          />
        ))}
      </div>

      {/* Vignette keeps the type legible over the brightest part of the wash. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 0%, transparent 30%, hsl(240 10% 4% / 0.75) 100%)",
        }}
      />
    </div>
  );
}

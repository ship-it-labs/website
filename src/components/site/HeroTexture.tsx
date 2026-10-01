const DOT_POSITIONS = [
  { top: "18%", left: "22%", delay: "0s", duration: "5.2s" },
  { top: "34%", left: "62%", delay: "0.7s", duration: "6.1s" },
  { top: "58%", left: "38%", delay: "1.4s", duration: "5.6s" },
  { top: "72%", left: "74%", delay: "0.3s", duration: "6.6s" },
  { top: "46%", left: "84%", delay: "1.9s", duration: "5.8s" },
  { top: "82%", left: "16%", delay: "1.1s", duration: "6.3s" },
] as const;

/**
 * A small animated texture that sits beside the headline. It is decorative, so
 * it carries no information of its own: a drifting aurora wash, a grid, a
 * sheen highlight and a few breathing dots. Hidden from assistive technology
 * and skipped entirely when the reader has asked for reduced motion.
 */
export function HeroTexture() {
  return (
    <div
      aria-hidden="true"
      className="glass pointer-events-none relative overflow-hidden rounded-3xl"
    >
      {/* Drifting colour wash. The gradient is inset past every edge so the
          drift cannot pull a visible seam into view. */}
      <div
        className="absolute -inset-1/4"
        style={{
          background:
            "radial-gradient(38% 46% at 22% 26%, rgba(139,92,246,0.42) 0%, transparent 70%)," +
            "radial-gradient(34% 42% at 78% 34%, rgba(34,211,238,0.32) 0%, transparent 70%)," +
            "radial-gradient(46% 50% at 58% 88%, rgba(217,70,239,0.28) 0%, transparent 70%)",
          filter: "blur(28px)",
          animation: "texture-drift 18s ease-in-out infinite",
        }}
      />

      {/* Faint grid, masked so it fades out toward the edges. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.07) 1px, transparent 1px)," +
            "linear-gradient(to bottom, rgba(255,255,255,0.07) 1px, transparent 1px)",
          backgroundSize: "38px 38px",
          maskImage: "radial-gradient(72% 72% at 50% 45%, #000 0%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(72% 72% at 50% 45%, #000 0%, transparent 78%)",
        }}
      />

      {/* Light travelling across the glass. */}
      <div
        className="absolute inset-y-0 -left-1/3 w-1/3"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.14) 50%, transparent 100%)",
          animation: "sheen 7.5s ease-in-out infinite",
        }}
      />

      {/* Breathing dots. */}
      {DOT_POSITIONS.map((dot) => (
        <span
          key={`${dot.top}-${dot.left}`}
          className="absolute h-1.5 w-1.5 rounded-full bg-white"
          style={{
            top: dot.top,
            left: dot.left,
            opacity: 0.12,
            animation: `texture-dot ${dot.duration} ease-in-out ${dot.delay} infinite`,
          }}
        />
      ))}

      {/* Edge highlight so the panel reads as a solid surface. */}
      <div className="absolute inset-0 rounded-3xl ring-1 ring-inset ring-white/10" />
    </div>
  );
}

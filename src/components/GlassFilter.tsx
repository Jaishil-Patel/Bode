/*
 * The refraction filter behind the Glass theme.
 *
 * `backdrop-filter: blur()` frosts what is behind a panel, but frosting is not what makes something
 * look like glass — bending is. This displaces the backdrop by a smooth low-frequency noise field,
 * so the content behind a panel warps the way it would through something with thickness, most
 * visibly where the warp runs off the edges.
 *
 * Rendered once, at the app root, and referenced by `filter: url(#glass-distortion)` in themes.css.
 * It is defined in every theme rather than only in Glass: a `filter` pointing at a missing reference
 * makes the element it is on disappear entirely, so the definition must never be the thing that
 * comes and goes.
 */
export default function GlassFilter() {
  return (
    <svg aria-hidden className="pointer-events-none absolute h-0 w-0">
      <filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
        {/*
         * A very low base frequency is the whole point: at these values the noise is less a texture
         * than a slow gradient across the panel, so the displacement reads as one continuous lens
         * rather than as frosted static. The seed is arbitrary but fixed, so the warp is stable
         * between renders instead of shimmering.
         */}
        <feTurbulence type="fractalNoise" baseFrequency="0.001 0.005" numOctaves="1" seed="17" result="turbulence" />
        {/* Softening the map before it displaces anything is what keeps the warp fluid; without it
            the noise steps and the edges of the lens go ragged. */}
        <feGaussianBlur in="turbulence" stdDeviation="3" result="softMap" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="softMap"
          scale="90"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

export type HostId = 'claude' | 'cursor';

/**
 * Brand mark for a coding agent, drawn inline rather than shipped as an asset:
 * these sit next to a text label at 15px, so a bitmap would only add a fetch
 * and a blurry edge.
 *
 * Both strips look identical once the bars start moving — same colours (colour
 * is the project, not the host), same layout. The mark is what tells them
 * apart at a glance, so it carries each vendor's own colour instead of
 * inheriting the muted heading grey.
 */
export function HostMark({ host, size = 15 }: { host: HostId; size?: number }) {
  if (host === 'claude') {
    // The Claude burst: rays out of a common centre, uneven on purpose.
    const rays = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        className="host-mark host-mark-claude"
      >
        {rays.map((deg, i) => {
          const rad = (deg * Math.PI) / 180;
          // Alternating reach, so the burst reads as a star and not as a wheel.
          const len = i % 2 === 0 ? 9.5 : 6.5;
          return (
            <line
              key={deg}
              x1={12}
              y1={12}
              x2={12 + Math.cos(rad) * len}
              y2={12 + Math.sin(rad) * len}
              stroke="currentColor"
              strokeWidth={2.1}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
    );
  }

  // Cursor: the isometric cube, three faces at three tints of one colour.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="host-mark host-mark-cursor"
    >
      <path d="M12 2 22 7.5v9L12 22 2 16.5v-9z" fill="currentColor" opacity={0.28} />
      <path d="M12 2 22 7.5 12 13 2 7.5z" fill="currentColor" opacity={0.95} />
      <path d="M12 13 22 7.5v9L12 22z" fill="currentColor" opacity={0.62} />
    </svg>
  );
}

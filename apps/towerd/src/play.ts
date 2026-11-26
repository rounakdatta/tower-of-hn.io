// CLIENT_FLAGS: how the room plays, switched in towerd and carried to every client in head.json (`play`). A flag the
// server doesn't know is left out (and named in the boot log): a typo can't switch on something half-built.
export const KNOWN_PLAY = ['stream', 'cue', 'quick', 'crowd', 'timeline'] as const;

/** The flags to carry (known ones, in the order asked, once each), and any asked for that aren't known. */
export function playFlags(env: string | undefined): { on: string[]; unknown: string[] } {
  const asked = [...new Set((env ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const on = asked.filter((s) => (KNOWN_PLAY as readonly string[]).includes(s));
  return { on, unknown: asked.filter((s) => !on.includes(s)) };
}

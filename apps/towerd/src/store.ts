/**
 * Voiced audio on disk: kept exactly as long as a listener could still play it, never more than a fixed size, and
 * never written into the last of the node's disk.
 *
 * A clip is played only from a floor of the tower (the client opens nothing else, deep links included), so a
 * comment's audio is worth keeping while its story is on the tower, and for a grace period after: a story that slips
 * off the front page can come back within hours, and an edited comment's old version may still be mid-play. The rest
 * is a cache nobody can hit (on 24 Nov 2026, 78% of the audio stored), so it goes.
 */

/** One version of a voiced comment, c/<id>.<rev>: its files (sidecar, snapshots, clips), their bytes, the last time
 *  a floor could play it (0: not since this process started, and no floor on disk names it), and whether a floor on
 *  the tower plays it now. */
export type Version = { stem: string; files: string[]; bytes: number; reach: number; tower: boolean };

/** c/<id>.<rev>.<k>.ogg, c/<id>.<rev>.p<n>.json, c/<id>.<rev>.json -> c/<id>.<rev>; anything else -> null */
export function versionOf(name: string): string | null {
  const m = /^(\d+\.[0-9a-f]{8})\.(?:\d{1,3}\.ogg|p\d+\.json|json)$/.exec(name);
  return m ? `c/${m[1]}` : null;
}

/**
 * What goes this pass. A version nobody could play for longer than `grace` is marked, and deleted if it was marked
 * the pass before too: nothing just voiced, or not yet on a floor rebuilt after a restart, is caught in between. If
 * the rest is still over `maxBytes`, the versions unplayable longest go at once; what the tower plays now never does.
 * `full`: over the cap even so (towerd then voices nothing new until it isn't).
 */
export function sweep(versions: Version[], o: { now: number; grace: number; maxBytes: number; marked: Set<string> }) {
  const drop: Version[] = [], keep: Version[] = [], marked = new Set<string>();
  for (const v of versions) {
    if (v.tower || o.now - v.reach <= o.grace) keep.push(v);
    else if (o.marked.has(v.stem)) drop.push(v);
    else { marked.add(v.stem); keep.push(v); }
  }
  let bytes = keep.reduce((n, v) => n + v.bytes, 0);
  if (bytes > o.maxBytes) {
    for (const v of keep.filter((v) => !v.tower).sort((a, b) => a.reach - b.reach)) {
      if (bytes <= o.maxBytes) break;
      drop.push(v); marked.delete(v.stem); bytes -= v.bytes;
    }
  }
  return { drop, marked, bytes, full: bytes > o.maxBytes };
}

/** Lines of voiced.jsonl (read whole at start-up, so it must not only grow) whose sidecar is still there, in order.
 *  A torn line is never kept. */
export function liveLines(lines: string[], alive: (path: string) => boolean): string[] {
  return lines.filter((l) => { try { const p = JSON.parse(l).path; return typeof p === 'string' && alive(p); } catch { return false; } });
}

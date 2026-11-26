// A face, per pixel, from a few numbers: skin, cheeks, eyes with a highlight that blink, squint into smiling arcs or
// narrow under slanted lids; brows that rise, knit, worry or arch one at a time; a mouth that forms vowels, smiles,
// smirks and shows its teeth; and a flush when someone gets heated. Faces are small on a toy's round head, so every
// shape is drawn bold enough to read from across the table. Shared by everyone the room draws: the people at the
// tables (people.ts, a face that acts) and the audience (audience.ts, a face that listens).
import * as THREE from 'three/webgpu';
import { vec2, vec3, vec4, float, mix, smoothstep, length, min, max, clamp, step, fract, abs } from 'three/tsl';
import { uTime } from './world.ts';

// (TSL's types fight its own swizzles; the nodes come in as whatever their makers return, as they did inline)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
/** what a face is made of: the head's own normal (where on the head this pixel is); eye size, eye gap, brow
 *  thickness, mouth width; skin, hair (brows, beard); a phase (blinks out of step); bearded (0/1); and the expression
 *  as four rows: [open shape brow smile] [lid browIn browAsym smileAsym] [happy lidTilt blush teeth] [gaze gazeY flush
 *  blinkRate] */
export interface FaceIn {
  n: N; face: N; skin: N; hair: N; phase: N; beard: N; e0: N; e1: N; e2: N; e3: N;
}

export function faceColor({ n, face, skin, hair: hairC, phase, beard, e0, e1, e2, e3 }: FaceIn): THREE.Node<'vec3'> {
  const p = vec2(n.x, n.y);
  const open = e0.x, shape = e0.y, brow = e0.z, smile = e0.w;
  const lid = e1.x, browIn = e1.y, browAsym = e1.z, smileAsym = e1.w;
  const happy = e2.x, lidTilt = e2.y, blush = e2.z, teeth = e2.w;
  const gx = e3.x, gy = e3.y, flush = e3.z, blinkRate = e3.w;
  const front = smoothstep(0.25, 0.55, n.z);
  // eyes: in each eye's own frame, x measured toward the nose (so one formula serves both)
  const blink = step(0.982, fract(uTime.mul(float(0.23).mul(blinkRate.add(1))).add(phase.mul(7.3))));
  const gap = face.y.mul(0.27), er = face.x.mul(0.06);
  const eyeY = float(0.12).add(happy.mul(er).mul(0.22));                  // cheeks push smiling eyes up
  const eh = er.mul(clamp(lid.mul(float(1).sub(blink)), 0.07, 1.35)).mul(float(1).sub(happy.mul(0.97)));
  const xl = p.x.add(gap), xr = gap.sub(p.x);
  const dl = length(vec2(xl, p.y.sub(eyeY)).div(vec2(er, eh)));
  const dr = length(vec2(xr, p.y.sub(eyeY)).div(vec2(er, eh)));
  // anger: the upper lid slants down toward the nose and cuts the eye
  const cut = (x: ReturnType<typeof float>) => eyeY.add(eh.mul(float(1).sub(lidTilt.mul(0.75)))).sub(lidTilt.mul(er).mul(0.55).mul(x.div(er)));
  const underL = smoothstep(cut(xl).add(0.004), cut(xl).sub(0.004), p.y), underR = smoothstep(cut(xr).add(0.004), cut(xr).sub(0.004), p.y);
  const eyeL = smoothstep(1.06, 0.9, dl).mul(underL), eyeR = smoothstep(1.06, 0.9, dr).mul(underR);
  const eyes = max(eyeL, eyeR).mul(front);
  // a big dark iris inside a thin white reads on every skin tone, in any light; it looks a little ahead of the head
  const ix = gx.mul(er).mul(0.3), iy = gy.mul(eh).mul(0.26);
  const il = length(vec2(xl.sub(ix), p.y.sub(eyeY).sub(iy))).div(er.mul(0.76));
  const ir = length(vec2(xr.add(ix), p.y.sub(eyeY).sub(iy))).div(er.mul(0.76));
  const iris = smoothstep(1.08, 0.9, min(il, ir)).mul(eyes);
  const gl = length(vec2(xl.sub(er.mul(0.32)).sub(ix), p.y.sub(eyeY).sub(eh.mul(0.36)).sub(iy)));
  const gr = length(vec2(xr.add(er.mul(0.32)).add(ix), p.y.sub(eyeY).sub(eh.mul(0.36)).sub(iy)));
  const glint = smoothstep(er.mul(0.3), er.mul(0.16), min(gl, gr)).mul(eyes).mul(step(0.3, lid.mul(float(1).sub(blink)))).mul(float(1).sub(happy));
  // the lash line along the top of each eye: always a hint (definition), the whole arc when smiling or narrowed
  const arc = (d: ReturnType<typeof float>, x: ReturnType<typeof float>, under: ReturnType<typeof float>) =>
    smoothstep(0.2, 0.06, abs(d.sub(1))).mul(step(eyeY.sub(eh.mul(0.2)), p.y)).mul(smoothstep(1.15, 0.9, abs(x).div(er))).mul(max(under, happy));
  // laughing eyes close into arches (∩ ∩): the top of a lower, rounder ellipse, drawn as a thick line
  const arch = (x: ReturnType<typeof float>) => {
    const d = length(vec2(x.div(er), p.y.sub(eyeY.sub(er.mul(0.35))).div(er.mul(0.8))));
    return smoothstep(0.24, 0.1, abs(d.sub(1))).mul(step(eyeY.sub(er.mul(0.3)), p.y));
  };
  const arches = max(arch(xl), arch(xr)).mul(front).mul(smoothstep(0.45, 0.85, happy));
  const lash = max(max(arc(dl, xl, underL), arc(dr, xr, underR)).mul(front).mul(max(lidTilt.mul(0.9), 0.35)).mul(float(1).sub(happy)), arches);
  const lidLine = max(smoothstep(0.0045, 0.0015, abs(p.y.sub(cut(xl)))).mul(smoothstep(1.1, 0.8, abs(xl).div(er))),
    smoothstep(0.0045, 0.0015, abs(p.y.sub(cut(xr)))).mul(smoothstep(1.1, 0.8, abs(xr).div(er)))).mul(lidTilt).mul(front);
  // brows: up and down together, inner ends up (worry) or down (anger), one at a time (doubt), a slight arch
  const half = er.mul(1.1), thick = face.z.mul(0.013);
  const browY = eyeY.add(er.mul(1.7)).add(brow.mul(0.034)).sub(happy.mul(er).mul(0.1));
  const bl = xl.div(half), br = xr.div(half);
  const yl = browY.add(max(browAsym, 0).mul(0.03)).add(browIn.mul(0.036).mul(bl)).sub(bl.mul(bl).mul(0.006));
  const yr = browY.add(max(browAsym.negate(), 0).mul(0.03)).add(browIn.mul(0.036).mul(br)).sub(br.mul(br).mul(0.006));
  const browL = smoothstep(thick, thick.mul(0.55), abs(p.y.sub(yl))).mul(smoothstep(1.0, 0.85, abs(bl)));
  const browR = smoothstep(thick, thick.mul(0.55), abs(p.y.sub(yr))).mul(smoothstep(1.0, 0.85, abs(br)));
  const brows = max(browL, browR).mul(front);
  // mouth: narrows for round vowels, opens with the voice, curves with the smile, tilts in a smirk, shows teeth
  const mw = face.w.mul(0.1).mul(float(1).sub(max(shape, 0).mul(0.32)).add(max(float(0).sub(shape), 0).mul(0.12))).mul(teeth.mul(0.12).add(1));
  const mh = float(0.007).add(open.mul(0.085).mul(float(1).add(max(shape, 0).mul(0.3))));
  const xm = p.x.div(mw);
  const cy = float(-0.19).add(smile.mul(0.044).mul(xm.mul(xm))).sub(smile.mul(0.012)).add(smileAsym.mul(0.02).mul(xm));
  const dm = length(vec2(xm, p.y.sub(cy).div(mh)));
  const mouth = smoothstep(1.08, 0.92, dm).mul(front);
  const tooth = mouth.mul(smoothstep(cy.add(mh.mul(0.1)), cy.add(mh.mul(0.3)), p.y)).mul(teeth);
  const lip = smoothstep(1.35, 1.0, dm).mul(float(1).sub(mouth)).mul(front).mul(0.35);
  // cheeks: a little colour always, more when pleased or embarrassed, raised by a real smile
  const cheek = smoothstep(0.075, 0.0, length(vec2(abs(p.x).sub(0.17), p.y.add(0.075).sub(happy.mul(0.02))))).mul(front).mul(blush.mul(0.5).add(0.28));
  // beard: chin and jaw, never over the mouth
  const ring = smoothstep(0.96, 1.06, length(vec2(p.x.div(0.4), p.y.add(0.07).div(0.25))));
  const beardM = ring.mul(smoothstep(-0.02, -0.12, p.y)).mul(smoothstep(-0.25, 0.1, n.z)).mul(beard);
  let col: THREE.Node = mix(skin, skin.mul(vec3(1.16, 0.7, 0.66)), flush.mul(0.5).mul(smoothstep(-0.2, 0.4, n.z)));
  col = mix(col, vec3(0.95, 0.45, 0.42), cheek);
  col = mix(col, hairC.mul(0.85), beardM.mul(0.94));
  col = mix(col, skin.mul(0.62), lip);
  col = mix(col, vec3(0.3, 0.07, 0.08), mouth);
  col = mix(col, vec3(0.93, 0.9, 0.86), tooth);
  col = mix(col, hairC.mul(0.55).add(0.02), brows);
  col = mix(col, vec3(0.9, 0.87, 0.83), eyes);
  col = mix(col, vec3(0.05, 0.04, 0.045), iris);
  col = mix(col, vec3(1), glint);
  col = mix(col, vec3(0.06, 0.045, 0.05), max(lash, lidLine));
  return col as THREE.Node<'vec3'>;
}

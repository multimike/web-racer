/**
 * Entry of /src/lab/physics/extra-raycast/break.html — the standard physics
 * lab plus the raycast break-test maneuvers of this folder, WITHOUT editing
 * any shared harness file: the extra `ManeuverDef`s are appended to the lab's
 * exported MANEUVERS array, then the untouched lab page script is imported
 * (it reads the array when it starts).
 *
 * Same query parameters as /physics-lab.html. Always pass &suite=... (the
 * default suite=all would run the 16 standard maneuvers too). Names:
 *   xrSaw, xrDonut, xrBrakeLock, xrReverse, xrAirLanding, xrBoulder, xrSlope,
 *   xrWall, xrInverted, xrHitch, xrRespawn, xrOffroad, xrMisc, xrGameLoop   (abuse.ts)
 *   xhReaction, xhOvercorrect, xhDrift, xhSpin                  (human.ts)
 *   xpProbe  one open-loop run with a 20 Hz trace  (&probe=v:12,beta:25,thr:0.7,stick:0.5)
 *   xpGrid   open-loop drift map, throttle x stick position            (probe.ts)
 *   xbTrace  one obstacle strike with a per-step trace of what the model and
 *            what Havok did to the chassis  (&probe=sc:1,v:25 - see trace.ts)
 *   xdTrace  one scripted slide (imposed, from a circle, or from rest) with a
 *            trace of the slide assists  (&probe=init:0,v:15,beta:35&keys=0:1:0;0.25:1:-1 - see driftProbe.ts)
 * Headless: src/lab/physics/extra-raycast/breaklab.sh "<query>" out.json [timeout]
 */
import { MANEUVERS } from '../maneuvers';
import { ABUSE_MANEUVERS } from './abuse';
import { HUMAN_MANEUVERS } from './human';
import { xpGrid, xpProbe } from './probe';
import { xbTrace } from './trace';
import { xdTrace } from './driftProbe';

for (const def of [...ABUSE_MANEUVERS, ...HUMAN_MANEUVERS, xpProbe, xpGrid, xbTrace, xdTrace]) {
  if (!MANEUVERS.some((m) => m.name === def.name)) MANEUVERS.push(def);
}
void import('../../physicsLab');

/**
 * Entry of /src/lab/physics/extra-assist/break.html — the standard physics
 * lab plus the break-test maneuvers of this folder, WITHOUT editing any
 * shared harness file: the extra `ManeuverDef`s are appended to the lab's
 * exported MANEUVERS array, then the untouched lab page script is imported
 * (it reads the array when it starts).
 */
import { MANEUVERS } from '../maneuvers';
import { Sim } from '../sim';
import { ABUSE_MANEUVERS } from './abuse';
import { prng } from './helpers';
import { HUMAN_MANEUVERS } from './human';

/**
 * &jitter=<mode> — run ANY maneuver (the 16 standard ones included) with
 * uneven frame times, as a real render loop delivers them. Sim.step is
 * wrapped at run time (no shared file is edited): each step's dt is the
 * nominal &dt= times a factor from a fixed-seed PRNG.
 *   jitter=pm25    uniform 0.75 .. 1.25
 *   jitter=dropN   N % of the frames last twice as long (a dropped vsync),
 *                  e.g. drop5, drop20
 * Simulated time stays exact (tel.t). Maneuver code that converts step
 * COUNTS to seconds with the nominal dt reads up to N % short — treat
 * durations from such runs as a robustness screen, not as a measurement.
 */
const jitter = new URLSearchParams(location.search).get('jitter');
if (jitter) {
  const rand = prng(4242);
  const drop = jitter.startsWith('drop') ? Number(jitter.slice(4)) / 100 : 0;
  if (jitter !== 'pm25' && !(drop > 0 && drop <= 1)) throw new Error(`bad jitter '${jitter}'`);
  const proto = Sim.prototype as unknown as { step(this: { dt: number }): void };
  const original = proto.step;
  proto.step = function step(this: { dt: number }): void {
    const base = this.dt;
    this.dt = base * (drop > 0 ? (rand() < drop ? 2 : 1) : 0.75 + 0.5 * rand());
    try {
      original.call(this);
    } finally {
      this.dt = base;
    }
  };
}

for (const def of [...ABUSE_MANEUVERS, ...HUMAN_MANEUVERS]) {
  if (!MANEUVERS.some((m) => m.name === def.name)) MANEUVERS.push(def);
}
void import('../../physicsLab');

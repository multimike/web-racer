/**
 * Entry of /src/lab/physics/extra-hybrid/break.html — the standard physics
 * lab plus the break-test maneuvers of this folder, WITHOUT editing any
 * shared harness file: the extra `ManeuverDef`s are appended to the lab's
 * exported MANEUVERS array, then the untouched lab page script is imported
 * (it reads the array when it starts).
 */
import { MANEUVERS } from '../maneuvers';
import { ABUSE_MANEUVERS } from './abuse';
import { HUMAN_MANEUVERS } from './human';
import { hxDebug, hxGarbage } from './debug';

for (const def of [...ABUSE_MANEUVERS, ...HUMAN_MANEUVERS, hxDebug, hxGarbage]) {
  if (!MANEUVERS.some((m) => m.name === def.name)) MANEUVERS.push(def);
}
void import('../../physicsLab');

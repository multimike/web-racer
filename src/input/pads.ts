/**
 * The gamepads the game reads (DesktopGamepadInput, GameActions): EVERY
 * connected pad with the "standard" mapping (a DualShock 4 in Chrome,
 * Safari and Firefox), not just the first entry of `getGamepads()` — any
 * other HID device the browser lists first (a headset, a wheel without the
 * standard layout) would otherwise silently hide the DualShock. The readers
 * combine the pads by the STRONGEST signal: the axis furthest from rest,
 * the deepest trigger, a button pressed on any pad. With one standard pad
 * nothing changes. When no pad has the standard mapping, every connected
 * pad is used (the old behaviour: a lone pad the browser could not map).
 * The array is reused — do not keep it.
 */
const out: Gamepad[] = [];

export function connectedPads(): readonly Gamepad[] {
  out.length = 0;
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return out;
  const pads = navigator.getGamepads();
  let other = 0;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad || pad.connected === false) continue;
    if (pad.mapping === 'standard') out.push(pad);
    else other++;
  }
  if (out.length === 0 && other > 0) {
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (pad && pad.connected !== false) out.push(pad);
    }
  }
  return out;
}

# Web Racer

A toy-buggy racing game that runs in the browser. You race a small off-road
buggy against three computer-driven rivals around a hand-sized world of dirt
roads, cobbled villages and palm trees. Every world is generated from a seed
number, so there is always a new track to try.

**[▶ Play it in your browser](https://multimike.github.io/web-racer/)**

<p>
  <img src="docs/screenshot-chase.jpg" width="49%" alt="Chasing a rival through a cobbled bend">
  <img src="docs/screenshot-village.jpg" width="49%" alt="Two buggies side by side in the village, seen from above">
</p>

The game is made for a desktop browser with a keyboard or a gamepad. A
tabletop view for the Meta Quest 3 is in the works; today it can be previewed
on a flat screen with `?view=xr`.

## Controls

| | Keyboard | Gamepad |
|---|---|---|
| Steer | A / D or ← / → | Left stick |
| Throttle | W or ↑ | Right trigger |
| Brake, hold to reverse | S or ↓ | Left trigger |
| Put the car back on the road | R | Circle / B |
| Change camera | C | Triangle / Y |
| Restart the race | Enter | Options / Start |

Click the page or press a key once to switch the engine sound on.

## Options

Add options to the address, for example
[`?seed=42&car=comet-fox`](https://multimike.github.io/web-racer/?seed=42&car=comet-fox).

| Option | Values | What it does |
|---|---|---|
| `seed` | any whole number from 1 (default 16) | Picks the world and track. The same number always gives the same world. |
| `car` | `reef-rocket`, `neon-wasp`, `riot-ram`, `comet-fox` | Your car |
| `livery` | 0, 1, 2 … | Your car's paint |
| `difficulty` | `easy`, `normal`, `hard` | How quick the rivals are |
| `rivals` | 0 to 3 | Number of rivals |
| `laps` | 0 to 99 (default 3) | Race length; 0 is endless |
| `view` | `chase`, `high`, `xr` | Starting camera |

## Run it yourself

You need [Node.js](https://nodejs.org) 22.18 or newer.

```bash
npm install
npm run dev
```

Then open the address the dev server prints. `npm run build` puts a
ready-to-host copy in `dist/`.

## How it is made

Everything you see is built in code when the game loads: the cars, buildings,
trees, the ground textures and the track. There are no model or image files.
It is written in TypeScript with [Babylon.js](https://www.babylonjs.com) for
graphics and [Havok](https://www.havok.com) for physics. The pictures the look
is modelled on are in [`design-documents/`](design-documents/).

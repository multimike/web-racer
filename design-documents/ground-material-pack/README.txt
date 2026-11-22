GROUND MATERIAL PACK — v1.2

Six original stylized tileable PBR materials:
G01 Rally Dirt — warm compacted dirt.
G02 Sunlit Sand — golden-cream sand with wind-ripple microrelief.
G03 Meadow Grass — a short stylized grass carpet.
G04 Lavender Gravel — small lavender and cream aggregate matching the rocks.
G05 Worn Asphalt — cool slate asphalt for village/service areas.
G06 Village Cobblestone — irregular cream and lavender flagstones with no directional rows.

FILES PER MATERIAL
basecolor.png     2048 × 2048 RGB8, sRGB; no baked directional lighting.
normal_gl.png     2048 × 2048 RGB8, linear; tangent-space OpenGL +Y.
normal_dx.png     2048 × 2048 RGB8, linear; tangent-space DirectX -Y.
roughness.png     2048 × 2048 grayscale8, linear; white is rough.
height.png        2048 × 2048 grayscale16, linear; white is higher.
ao.png            2048 × 2048 grayscale8, linear; white is unoccluded.
orm.png           2048 × 2048 RGB8, linear; R=AO, G=roughness, B=metallic.
material.json     Exact file settings and proposed physical scale.
swatch.png        512px color preview, not a runtime material map.
repeat-2x2.png    Color repeat preview, not a runtime material map.

All materials have metallic=0. No separate metallic image is needed: ORM blue is identically zero.
Use either normal_gl OR normal_dx, not both. Their green channels are exact inverses.

SCALE AND RELIEF
Each tile covers 4 × 4 meters at its intended art scale.
Height black=0; white corresponds to:
Rally Dirt: 0.035 m
Sunlit Sand: 0.025 m
Meadow Grass: 0.025 m
Lavender Gravel: 0.055 m
Worn Asphalt: 0.006 m
Village Cobblestone: 0.040 m
These are artistic microrelief ranges, not surveyed terrain elevation.
Normals derive from the same height field using those scales and wrapping derivatives.
A displacement midpoint of 0.5 is a suggested starting point. A normal map alone does not change silhouette or collision. Avoid applying these height values directly to racing physics.

TILING
All surface fields and feature placement repeat in X and Y. No seam-repair filter or duplicated border texel is needed.
Use REPEAT wrap, mipmaps and anisotropic filtering.
Seam pixels do not have to equal opposite edge pixels: they are adjacent sample centers in a periodic field. The seam is tested like any other adjacent pixel step.
Tiling does not remove recognizable pattern repetition. For large areas, blend surface types using the terrain mask and add a very subtle macro tint. Do not rotate only one map within a PBR set.

PBR LIMITS
Roughness is authored, not physically measured.
AO is a local cavity approximation from height, not a ray-traced occlusion bake.
Grass represents short surface cover; use the separate vegetation models for blades that need a silhouette.
All maps align. Material parameters and colors can be tuned for the game's toon lighting.

PREVIEW
Open index.html through a local web server for the interactive Babylon.js preview.
For example, from this folder:
  python3 -m http.server 8766 --bind 127.0.0.1
Then open http://127.0.0.1:8766/
The preview loads local files only. No CDN or account is required.
Static swatches and tiled images can be opened directly without a server.
The plane is flat; the preview displays normal shading, not geometric displacement.

SOURCE AND VALIDATION
source/generate_materials.py generates every texture from original numerical periodic fields. Requires Python 3 and NumPy; no input images, Pillow, or SciPy.
Regenerate at another power-of-two resolution with:
  python3 source/generate_materials.py --size 1024
This replaces the maps in this pack; make a separate copy before generating another resolution.
source/preview.js is the Babylon.js viewer source.
validation.json records PNG round-trip, map alignment, normal normalization, packed-channel and seam statistics.
Base-color maps were also visually checked in 2×2 repeats.

DELIVERY
These are actual texture assets, not concept sheets. No ZIP archives.
The game's current terrain uses a custom shader; importing these maps does not automatically change the existing game.


VERSION 1.1
Replaced grid-interpolated macro color fields with isotropic periodic spectral noise across the pack. Reduced dirt and asphalt color contrast for softer, irregular variation. Added Village Cobblestone, with matching rounded relief, joint cavities and stone-to-stone roughness variation.

VERSION 1.2
Rebuilt Village Cobblestone as irregular interlocking flagstones, using random toroidal Voronoi cells. Varied stone sizes, softened uneven edges and recessed joints follow the layout of the supplied reference while retaining the stylized palette. Every PBR channel is regenerated from the same surface; the reference photograph is not embedded or used as a lit base-color map.

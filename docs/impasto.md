# Gouache and palette-knife rendering

This experimental branch ports the earlier Gouache effect into Lukis's Astro
interface and both GPU backends. It has not been deployed.

| Control   | Default | Effect                                                               |
| --------- | ------: | -------------------------------------------------------------------- |
| Paint     |    100% | Blends the finished painting with the original image.                |
| Stroke    |     1.4 | Sets the size of contour-following knife marks.                      |
| Thickness |     65% | Controls lighting on paint ridges. At zero, color marks remain flat. |

Four passes produce the image. A half-resolution structure tensor encodes stroke
direction. An anisotropic Kuwahara pass produces underpainting. Two scales of
procedural knife marks store color and height together. The final pass lights
those heights and adds canvas grain in thin paint and gaps.

The direction map is calculated once per image. Stroke changes rebuild the
underpainting and knife surface. Paint and Thickness changes reuse both caches.
All intermediate textures use RGBA8 with linear clamp-to-edge sampling. Neither
backend needs floating-point framebuffer extensions. Output remains opaque PNG,
with a 1600px maximum dimension. Replacement resources belong to the candidate
image until processing succeeds, so a failed replacement preserves the old export.

The fixed underpainting settings are flow 85%, detail protection 60%, softness
35%, pigment variation 30%, and color grouping 35%. Underpainting paper grain is
zero; the final lighting pass supplies canvas texture.

## Reference and verification

`test/fixtures/gouache-reference/` preserves the earlier standalone WebGL2
renderer and shader math. The only shader correction anchors final canvas grain
to pixel centers. Interpolated UV rounding otherwise selects different hash cells
at exact grain boundaries. The same correction is applied in the port. The
reference retains its original triangle-strip geometry and independent resource
management. It is a visual reference, not the production replacement mechanism.

`pnpm test:gpu` compares both backends with this reference, checks Paint and
Thickness cache reuse, and verifies that Thickness changes the exported image.
It retains the mean RGB error limit of 0.1 on the 0–255 scale and the limit of
0.01% of channels differing by more than two levels. Original-image output at
Paint 0% must match exactly. The earlier Papari reference remains tracked for
historical comparison.

On 7 September 2026, `pnpm check` passed all 68 tests, all three GPU runs,
and the static build. `pnpm test:browser` passed 47 cases with WebGPU and the
same 47 cases with WebGL2. For the 1448 by 1086 reference image, mean RGB error was
0.000321 with WebGPU and 0.000124 with either WebGL2 setting, on the 0–255 scale.
Paint 0%, transparent input, and failed-replacement exports matched exactly.
The built-in browser check confirmed flat and raised paint and visible save
controls in a 1280 by 720 window. These are local results on this Mac.

The underpainting derives from [Maxime Heckel's article](https://blog.maximeheckel.com/posts/on-crafting-painterly-shaders/)
and [Kyprianidis et al. (2010)](https://www.kyprianidis.com/p/tpcg2010/).
The WebGPU pass structure follows [vgpu's effect chaining](https://vgpu.sh/docs/guides/concepts-effects).

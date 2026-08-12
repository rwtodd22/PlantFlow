# PlantFlow browser branding

`favicon.svg` is the browser-tab icon used by PlantFlow.

To rebrand PlantFlow for another company:

1. Replace `public/branding/favicon.svg` with that company's square SVG icon.
2. Keep the filename `favicon.svg` and the SVG `viewBox` square (for example, `0 0 64 64`).
3. Export that artwork as `favicon-32.png` at 32×32 and `apple-touch-icon.png` at 180×180.
4. Update the version after `?v=` in `index.html` so browsers immediately request the new icons.
5. Optionally replace `public/favicon.svg` with the same SVG as a fallback for browsers that request the conventional root path.

Favor a simple mark, strong contrast, and very little text because favicons are commonly displayed at only 16×16 pixels.

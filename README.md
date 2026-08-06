# Overhead Scanner

A browser app for an overhead document camera: capture, deskew, clean up, OCR, and export
to searchable PDF. Everything runs locally — no uploads, no build step, no network at
runtime. Both OCR engines — PaddleOCR (PP-OCRv4) and Tesseract — are vendored in `vendor/`
along with their models.

Full spec in [REQUIREMENTS.md](REQUIREMENTS.md).

---

## Run it

```bash
cd ~/overhead-scanner
python3 -m http.server 8931
```

Then open **http://localhost:8931**.

A server is needed because `getUserMedia` requires a secure context, and because the OCR
worker loads from the same origin. `localhost` counts as secure. Opening `index.html`
directly works in Chrome for everything except OCR; Safari won't give you the camera at
all over `file://`.

Grant camera permission when asked, pick your device in the top bar, press **Start camera**.

---

## The workflow it's built around

1. Put the page under the camera. The green outline shows the page it has found.
2. Turn on **Auto** (or press <kbd>A</kbd>). Now every time you turn a page and take your
   hands out of frame, it shoots by itself. You never touch the keyboard.
3. Pages stack up in the tray on the left. Pick a filter once and hit **Apply to all pages**.
4. **Read all** in the OCR tab, then **Save PDF** with *Searchable* ticked.

## Choosing a filter

| | |
|---|---|
| **Auto** | The default. Start here. |
| **Black & white** | Text-only pages. Smallest files, best OCR, kills any lighting gradient. |
| **Colour doc** | Anything with photos, highlighter, or coloured print. |
| **Whiteboard** | Photographs of whiteboards — hard background removal, punchy pens. |
| **Ink boost** | Pencil, faded carbon, old faint print. |
| **Photo** | Barely touches the image. For when you want the actual photograph. |

Every filter is just a preset over the sliders below it — nudge anything and the filter
switches to *custom*. The circular arrow beside each slider resets that one control back to
the filter's value.

## Getting a clean scan

- **Light from two sides** if you can. One lamp leaves a gradient that *Shadow & gradient
  removal* then has to undo, and undoing it costs you some tonal range.
- **Any desk that isn't the colour of paper** makes edge detection close to perfect: a dark
  mat is ideal, but wood, a coloured mat, or a plain pale surface all work. White paper on a
  white desk is the one genuinely hard case — there the only cue is the shadow the paper
  casts, so keep the light a little off-axis rather than straight down.
- **Raise the exposure** (<kbd>.</kbd>) before blaming detection. An under-exposed frame
  crushes the paper/desk difference that everything downstream relies on.
- **Glossy pages**: raise the camera and tilt the lamp, rather than fighting the reflection
  in software.
- If the page isn't found, press **Detect** again, or edit the crop by hand — see below.
  When nothing is found the status bar says so and the full frame is kept; it never guesses.

## Editing the crop

The **Crop** section at the top of the Adjust tab (or the **Corners** button above the
image, or <kbd>C</kbd>) puts the stage into crop mode, showing the uncropped frame with the
current quadrilateral over it:

- **Drag a corner** to move it. A magnifier follows the pointer so you can land exactly on
  the paper edge.
- **Drag an edge** to slide that whole side without changing its angle — usually what you
  want, since detection tends to get the page's angle right and one edge slightly wrong.
- **Arrow keys** nudge the last corner you touched by a pixel; hold <kbd>Shift</kbd> for ten.
- **Trim edges** shrinks the crop by a percentage on all sides. Use it to shave off a paper
  shadow or a sliver of desk without moving anything by hand — it's reversible and leaves
  the stored corners untouched.
- **Whole frame** clears the crop; **Auto-detect** runs detection again at full resolution.

## Keyboard

<kbd>Space</kbd> capture · <kbd>A</kbd> auto-capture · <kbd>C</kbd> corners · <kbd>D</kbd>
detect · <kbd>B</kbd> hold to compare · <kbd>L</kbd>/<kbd>E</kbd> live/edit ·
<kbd>←</kbd><kbd>→</kbd> pages · <kbd>[</kbd><kbd>]</kbd> rotate · <kbd>1</kbd>–<kbd>8</kbd>
filters · <kbd>R</kbd> OCR this page · <kbd>,</kbd><kbd>.</kbd> camera exposure ·
<kbd>0</kbd> fit · <kbd>?</kbd> help

In crop mode the arrow keys nudge the last corner you touched instead of changing page.

---

## OCR engines

**PaddleOCR (PP-OCRv4)** is the default and is usually the more accurate of the two on
photographed pages. It is the standard two-stage PaddleOCR pipeline: a DBNet detector
produces a text-probability map, whose blobs are binarised, reduced to minimum-area
rectangles and expanded ("unclipped"), and each resulting line is warped flat and read by a
CRNN with greedy CTC decoding. Character timesteps are kept, so word boxes come out of the
CTC alignment rather than being guessed from the line — which is what makes the searchable
PDF's text layer line up. The models are vendored (~26 MB, loaded on first use and then
held in memory) and it runs single-threaded, because a plain local server can't send the
COOP/COEP headers WASM threads need.

**Tesseract** starts faster and uses less memory. It is the better choice for a quick read,
or if you need a language PaddleOCR's bundled character set doesn't cover.

The engine's own defaults are used for layout; the *Language* and *Page segmentation*
controls apply to Tesseract only and hide themselves when PaddleOCR is selected.

## Other languages

PaddleOCR's bundled character set covers Latin text and Chinese. For Tesseract, only English
is bundled. Pick another language in the OCR tab and it will be fetched from
the CDN once (needs network, then it's cached by the browser). To make one permanent and
offline, drop its `.traineddata.gz` into `vendor/tessdata/` and add its code to
`O.BUNDLED` in `js/ocr.js`:

```bash
curl -L -o vendor/tessdata/deu.traineddata.gz \
  https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_fast/deu.traineddata.gz
```

---

## Layout

```
index.html            markup and the control panels
css/styles.css        the whole UI
js/util.js            helpers — toasts, downloads, canvas, beep
js/geometry.js        page detection, homography, perspective warp
js/imaging.js         the processing pipeline: flattening, tone, filters, threshold
js/camera.js          device enumeration, streaming, capture, motion detection
js/ocr.js             engine dispatch + the Tesseract wrapper
js/paddle.js          PP-OCRv4: DB detection post-processing, CTC decoding
js/pdf.js             PDF writer with an invisible OCR text layer
js/store.js           IndexedDB session persistence
js/app.js             UI controller
vendor/               Tesseract, onnxruntime-web and the PP-OCRv4 models (all offline)
test/                 see below
```

Classic scripts, no modules and no bundler, deliberately: it means the folder runs as-is.

### Processing order

```
warp → rotate/flip/straighten → illumination flattening → white balance →
temperature/tint → tone curve → saturation/vibrance → denoise → sharpen →
filter mode (grey / adaptive threshold) → invert
```

The same function renders the preview and the export; only the input scale differs, so what
you see is what you get. The preview runs in two tiers: 1400 px on the long edge while a
control is being dragged, then a settled pass at the display's own pixel count once you stop
(up to 3200 px). Rendering at one fixed size and letting the browser scale it to fit is what
made a capture look softer on screen than the live view it came from. OCR gets 2400 px;
export is uncapped.

Nothing is rendered from a re-decoded JPEG. The capture canvas itself is kept in memory for
the pages you are working on, and the stored JPEG exists only so a reload can recover the
session — encoding and immediately decoding again cost a visible generation of quality on
exactly the sharp glyph edges a scanner is for (~42 dB PSNR after the sharpen stage).

Two pieces are worth knowing about if you touch the code:

- **Illumination flattening** estimates the paper level as a per-block *maximum* of
  luminance (which reads straight through text), blurs it hard because illumination is by
  definition low-frequency, and divides. Strength interpolates the gain geometrically
  (`gain^s`), not the output — blending the output linearly leaves a residual gradient
  proportional to `1−s`, so half strength would still show the lamp.
- **Page detection** is not one algorithm but several, scored against each other. A page can
  be brighter than the desk, darker than it, or the same brightness in a different colour,
  and no single segmentation covers all three. Four cheap ones run — luminance either
  polarity, distance from the desk colour, and distance from it in illumination-invariant
  chromaticity — each proposing a quadrilateral. Every candidate is then *refined* against
  the image gradient (walk each edge, look sideways for the true paper boundary, fit a line,
  intersect the four), which is what turns a rough mask into an accurate crop: segmentation
  only has to land within a few pixels. The winner is whichever quad's edges actually sit on
  real image edges, with paper on one side and desk on the other, all the way round, on all
  four sides. If nothing convinces, it returns `null` and the full frame stands — a wrong
  crop is worse than no crop.

  Two details do most of the work. Support alone can't identify a page, because a line of
  type and a wood grain line are also long, straight and strongly gradient; what separates a
  page boundary is that the material differs across it. And the interior is probed at two
  depths, because a text band *does* give a strong, perfectly consistent step — ink inside,
  paper outside — and only gives itself away a little deeper in, where the paper returns.

---

## Tests

```bash
node test/algorithms.test.js      # 54 assertions, no browser needed
node test/detection.test.js       # 16 desk setups; --ppm dumps each scene to /tmp
```

`algorithms.test.js` covers the homography and warp, illumination flattening, adaptive
thresholding, output sizing, and the PDF writer — including that every xref offset resolves
to its object.

`detection.test.js` is the bench for page finding. It synthesises the setups an overhead rig
actually meets — dark mat, wooden desk, pale desk, white-on-white, one side lamp, badly
under-exposed, rotated, clipped by the frame, a hand reaching in — and checks both that the
page is found and that it is found to within 2% of the frame. Three of the sixteen have no
page in them at all and exist to check that detection *declines* rather than inventing a
crop from wood grain or sensor noise. Add a scenario here before changing anything in
`detect()`; the failure modes are not obvious from the code.

```
http://localhost:8931/test/browser-test.html    # pipeline, in a real canvas — instant
http://localhost:8931/test/ocr-test.html        # OCR + searchable PDF — 10-30 s
```

`browser-test.html` runs the real pipeline against a synthetic angled, unevenly lit capture
using the browser's own canvas, so it also covers `drawImage` resampling, `fillText`, and
the rotate/flip stage. It renders every filter with timings, so you can see what each does.

`ocr-test.html` is the one to open when OCR misbehaves: it exercises `vendor/` loading, the
worker, recognition of known text, and the PDF text layer end to end.

```bash
node test/integration.js                        # drives the real UI, needs the server up
```

Drives `index.html` in headless Chrome over the DevTools protocol: imports an image through
the actual file input, then checks the tray, thumbnail, auto-detection, filter switching,
rotation, export sizing and deletion, and asserts nothing threw. Set `CHROME=` to point at
a different browser binary.

---

## Known limits

- Curved book spines aren't dewarped — a quadrilateral can't model a curl. Flatten the
  page, or use a glass platen.
- The camera's own controls (zoom, focus, exposure) appear only if the browser exposes
  them; many UVC cameras expose nothing, in which case use their driver utility.
- What you see and what you export are rendered from the pristine sensor frame, which is
  held in memory for the few pages you are working on. Session restore falls back to a
  JPEG (q0.96), so a page recovered after a reload is one generation from the sensor —
  export before closing if that matters.
- Chrome supports "Copy image"; Safari and Firefox may refuse the clipboard write.

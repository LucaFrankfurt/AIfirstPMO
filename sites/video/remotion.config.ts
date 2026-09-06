/**
 * How the spot is encoded, and why each of these is not the default.
 *
 * A marketing video is watched once, on a page that has already spent its
 * budget on the app itself — so the decisions here are all about a file that
 * plays everywhere without asking the viewer to wait for it.
 */
import { Config } from '@remotion/cli/config';

/*
 * PNG frames into the encoder, not JPEG.
 *
 * Remotion's default is JPEG and it is the right default for footage. This spot
 * is 1080p of flat colour, hairline borders and 16px captions — the exact
 * content a JPEG intermediate softens before H.264 ever sees it, so the loss is
 * taken twice. PNG costs about a third more render time and nothing at all in
 * the output file, because the encoder is what decides the size.
 */
Config.setVideoImageFormat('png');

/*
 * CRF 18 rather than Remotion's default 18-for-h264 — kept explicit because
 * this composition is almost entirely flat colour and large type, which is
 * exactly what a codec smears first. Anything above ~20 puts visible mosquito
 * noise around the headline strokes on a dark background.
 */
Config.setCrf(18);

/*
 * yuv420p and the `faststart` atom are what make the file play in an inline
 * <video> on iOS Safari and start before it has finished downloading. Without
 * the first, Safari shows a black rectangle; without the second, a viewer on a
 * slow connection waits for the whole thing.
 */
Config.setPixelFormat('yuv420p');
Config.setCodec('h264');

/*
 * No audio track at all, rather than Remotion's default silent one.
 *
 * The spot is silent by design (see README), and a silent AAC stream was
 * costing 317 kb/s — about 1.2 MB of an 8.8 MB file — to encode nothing. It
 * also made the container 30.06s long against a 30.00s video stream, which is
 * a discrepancy somebody would eventually have to explain.
 */
Config.setMuted(true);

Config.setOverwriteOutput(true);

/*
 * The same escape hatch every browser script in this repository has.
 *
 * Remotion downloads its own Chrome Headless Shell on the first render, which
 * is the right default and is wrong in exactly one place: a sandbox or a CI
 * runner whose egress does not reach `remotion.media` but which already has a
 * Chromium on disk. `scripts/responsive.mjs`, `contrast.mjs` and `a11y.mjs` all
 * read `CHROMIUM_PATH` for that reason; there is no argument for this one
 * spelling it differently.
 */
if (process.env.CHROMIUM_PATH) {
  Config.setBrowserExecutable(process.env.CHROMIUM_PATH);
}

/**
 * A slide, drawn.
 *
 * The band between the header and the footer is a centred column and that is
 * the whole layout: words, then — if the slide has one — a picture. Nothing
 * here is absolute except the band itself, so a slide that grows a line of copy
 * pushes its picture down rather than over it.
 *
 * `textAlign: 'center'` is set on the words and **not** on the band, which
 * looks fussy and is not. Half the widgets in `components/` position something
 * by hand in character widths; the first version of the vertical spot centred a
 * stack and the quick-add field's highlight rectangles landed five characters
 * off, because they measure from a left padding that centring had moved. The
 * cheap fix is to never let the property reach them.
 */
import React from 'react';
import { colour, font } from '../theme';
import { Headline, Kicker, Sub, Chip } from '../components/Type';
import { Wordmark } from '../components/Wordmark';
import { url } from '../product';
import { POST, SQUARE } from './sheet';
import { Sheet } from './Sheet';
import type { Slide } from './slide';

const Words: React.FC<{
  kicker: string;
  headline: string;
  sub?: string;
  size: { kicker: number; headline: number; sub: number };
}> = ({ kicker, headline, sub, size }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      gap: 24,
      width: POST.width - POST.margin * 2,
      /*
       * Room for two lines of headline whether or not there are two. Without
       * it a one-line headline pulls everything below it up by fifty pixels,
       * which is invisible on any single slide and obvious the moment somebody
       * swipes from the four-word one to the eight-word one.
       */
      minHeight: size.kicker + 24 + size.headline * 2.16,
    }}
  >
    <Kicker size={size.kicker}>{kicker}</Kicker>
    <Headline size={size.headline}>{headline}</Headline>
    {sub ? (
      <Sub size={size.sub} width={POST.width - POST.margin * 2 - 40}>
        {sub}
      </Sub>
    ) : null}
  </div>
);

/** A line of syntax, at the size the app's own monospace fields use. */
const Code: React.FC<{ children: string }> = ({ children }) => (
  <div
    style={{
      padding: '20px 30px',
      borderRadius: 12,
      background: colour.bgRaised,
      border: `1px solid ${colour.lineStrong}`,
      font: `500 25px/1.4 ${font.mono}`,
      /* JetBrains Mono draws `!=` as a single `≠`, which is handsome and wrong
       * for a card whose subject is the two characters somebody has to type. */
      fontVariantLigatures: 'none',
      color: colour.fg,
      textAlign: 'left',
      whiteSpace: 'pre-wrap',
    }}
  >
    {children}
  </div>
);

const Chips: React.FC<{ items: readonly string[]; mono?: boolean }> = ({ items, mono }) => (
  <div
    style={{
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: 14,
      maxWidth: POST.width - POST.margin * 2,
    }}
  >
    {items.map((item) => (
      <Chip key={item} mono={mono}>
        {item}
      </Chip>
    ))}
  </div>
);

/** The band, and the one rule about it: centred, and it never touches the rows. */
const Band: React.FC<{
  top?: number;
  bottom?: number;
  gap?: number;
  justify?: 'center' | 'flex-start';
  children: React.ReactNode;
}> = ({ top = POST.top, bottom = POST.bottom, gap = POST.gap, justify = 'center', children }) => (
  <div
    style={{
      position: 'absolute',
      left: POST.margin,
      right: POST.margin,
      top,
      bottom: POST.height - bottom,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: justify,
      gap,
    }}
  >
    {children}
  </div>
);

export const SlideView: React.FC<{
  slide: Slide;
  index: number;
  count: number;
  series?: boolean;
}> = ({ slide, index, count, series = true }) => {
  const last = !series || index === count - 1;

  if (slide.kind === 'cover') {
    return (
      /*
       * Composed inside the square the profile grid crops to, and carrying no
       * wordmark of its own — the header already has one, and two lockups on
       * one sheet is the mistake `Corner` exists to avoid in the spots.
       */
      <Sheet box={POST} index={index} count={count} counter={series} lit swipe={!last}>
        <Band top={SQUARE.top + 40} bottom={SQUARE.bottom - 40} gap={52}>
          <Words
            kicker={slide.kicker}
            headline={slide.headline}
            sub={slide.sub}
            size={{ kicker: 24, headline: 72, sub: 29 }}
          />
          {slide.chips ? <Chips items={slide.chips} mono={slide.mono} /> : null}
        </Band>
      </Sheet>
    );
  }

  if (slide.kind === 'close') {
    return (
      <Sheet
        box={POST}
        index={index}
        count={count}
        counter={series}
        lit
        swipe={false}
        lockup={false}
        address={false}
      >
        <Band gap={54}>
          <Wordmark size={74} />
          <Words
            kicker={slide.kicker}
            headline={slide.headline}
            sub={slide.sub}
            size={{ kicker: 22, headline: 54, sub: 26 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
            {slide.code ? <Code>{slide.code}</Code> : null}
            <div style={{ display: 'flex', gap: 14 }}>
              <Chip mono>{url.demo}</Chip>
              <Chip mono tone="accent">
                {url.repo}
              </Chip>
            </div>
          </div>
        </Band>
      </Sheet>
    );
  }

  /*
   * Every point slide puts its words at the ceiling of the band and centres
   * whatever else it has in the room that is left. Not for the look: it is so
   * the kicker lands on the same line on every slide of the set. A carousel
   * whose headline slides up and down as the copy gets longer makes the
   * reader's eye hunt for it once per swipe, and they stop swiping.
   *
   * Two earlier versions were worse in instructive ways. Centring the whole
   * column moved the headline by fifty pixels between a one-line sub and a
   * two-line one. Pinning the picture to the floor instead fixed the headline
   * and opened a four-hundred-pixel hole in the middle of any slide whose
   * widget was short.
   */
  const rest = slide.code || slide.chips || slide.visual;

  return (
    <Sheet box={POST} index={index} count={count} counter={series} swipe={!last}>
      <Band justify={rest ? 'flex-start' : 'center'}>
        <Words
          kicker={slide.kicker}
          headline={slide.headline}
          sub={slide.sub}
          size={{ kicker: POST.kicker, headline: POST.headline, sub: POST.sub }}
        />
        {rest ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 34,
              width: POST.width - POST.margin * 2,
            }}
          >
            {slide.code ? <Code>{slide.code}</Code> : null}
            {slide.chips ? <Chips items={slide.chips} mono={slide.mono} /> : null}
            {slide.visual ? (
              <div
                style={{ position: 'relative', width: '100%', height: slide.visual.height }}
              >
                {slide.visual.node}
              </div>
            ) : null}
          </div>
        ) : null}
      </Band>
    </Sheet>
  );
};

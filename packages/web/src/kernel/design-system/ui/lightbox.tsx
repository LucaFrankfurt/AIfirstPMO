/** A picture at the size it was uploaded, and the delegated click that opens one. */
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/i18n';
import { Button, buttonVariants } from './button';
import { cn } from '../cn';
import { Icon } from './icon';

/**
 * A picture at the size it was uploaded, over everything else.
 *
 * Opened by clicking any image in rendered markdown. Escape and a click on the
 * backdrop both close it, because both are what people try.
 */
export function Lightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return createPortal(
    <div className="lightbox" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <img src={src} alt={alt ?? ''} />
      <Button variant="ghost" size="icon" className="lightbox-close" onClick={onClose} aria-label={t('action.close')}>
        <Icon name="close" />
      </Button>
      <a className={cn(buttonVariants({ size: 'sm' }), 'lightbox-open')} href={src} target="_blank" rel="noreferrer">{t('common.openOriginal')}</a>
    </div>,
    document.body,
  );
}

/**
 * Click-to-enlarge for every image inside a subtree.
 *
 * A delegated listener rather than a prop on each image, because the markdown
 * renderer produces plain HTML and has no components to hand one to.
 */
export function useLightbox(): { open: (event: ReactMouseEvent) => void; lightbox: ReactNode } {
  const [shown, setShown] = useState<{ src: string; alt?: string } | null>(null);
  return {
    open: (event: ReactMouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName !== 'IMG') return;
      const image = target as HTMLImageElement;
      // An image inside a link is the link's business.
      if (image.closest('a')) return;
      setShown({ src: image.currentSrc || image.src, alt: image.alt });
    },
    lightbox: shown ? <Lightbox src={shown.src} alt={shown.alt} onClose={() => setShown(null)} /> : null,
  };
}

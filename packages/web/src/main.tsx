import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { I18nProvider, detectLocale, loadLocale } from './kernel/i18n/i18n';
import { SessionProvider } from './kernel/identity/session';
import { TooltipProvider } from './kernel/design-system/ui/tooltip';
import { installEffects } from './wiring';
import './styles/app.css';

// Apply the stored theme before first paint to avoid a flash of the wrong one.
const theme = localStorage.getItem('kolibri.theme');
if (theme && theme !== 'system') document.documentElement.setAttribute('data-theme', theme);

// And the catalogue for the same reason. Only English ships in the bundle, so a
// German reader would otherwise get one frame of English before their words
// arrive — the language equivalent of the theme flash above. This waits for a
// file that is already being fetched alongside the app, and if it never arrives
// the app still renders, in English.
await loadLocale(detectLocale());

// Before the app can open a stream. See `wiring.ts`.
installEffects();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <SessionProvider>
          {/* One provider so tooltips share a delay: the first one waits, the
              rest appear at once while the pointer keeps moving along a row of
              icons. Separate providers would make every icon wait again. */}
          <TooltipProvider>
            <App />
          </TooltipProvider>
        </SessionProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { I18nProvider } from './lib/i18n';
import { SessionProvider } from './session';
import { TooltipProvider } from './components/ui/tooltip';
import './styles/app.css';

// Apply the stored theme before first paint to avoid a flash of the wrong one.
const theme = localStorage.getItem('kolibri.theme');
if (theme && theme !== 'system') document.documentElement.setAttribute('data-theme', theme);

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

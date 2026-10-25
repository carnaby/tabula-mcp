import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TokenGate } from './pages/TokenGate';
import { registerPwa } from './pwa';
import { applyTheme, ConfirmProvider, ToastProvider } from './ui';
import './app.css';

applyTheme();
registerPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <TokenGate>
          <App />
        </TokenGate>
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);

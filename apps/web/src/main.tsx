import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SignInGate } from './pages/SignIn';
import { registerPwa } from './pwa';
import { applyTheme, ConfirmProvider, ToastProvider } from './ui';
import './app.css';

applyTheme();
registerPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <SignInGate>
          <App />
        </SignInGate>
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);

import './polyfills.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// FRG Hold & Earn is PASTE-ONLY: there is no wallet connect, no
// WalletConnect, no signing anywhere in this app — pasting an
// address registers it and shows its view. Any version of this app
// that asks to connect or sign is a fake.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

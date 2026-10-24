import './polyfills.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChainProvider } from '@cosmos-kit/react';
import { wallets as keplrWallets } from '@cosmos-kit/keplr';
import { wallets as stationWallets } from '@cosmos-kit/station';
import { wallets as terraClassicWcWallets } from './wallets.js';
import { terraClassicChain, terraClassicAssets } from './chainDef.js';
import { GasPrice } from '@cosmjs/stargate';
import App from './App.jsx';
// REQUIRED: the Cosmos Kit wallet modal stylesheet. Without it the icons
// render at unconstrained (giant) sizes and the modal is unstyled.
import '@interchain-ui/react/styles';
import './styles.css';

// WalletConnect (Reown) project ID — the user's own public client ID
// (it ships in the browser bundle). Required for every WalletConnect
// wallet (Keplr Mobile, Galaxy Station) to initialize its sign client.
const WC_PROJECT_ID = '7e363f1ed5d676ecc4ae2d40c5b83fbf';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ChainProvider
      chains={[terraClassicChain]}
      assetLists={[terraClassicAssets]}
      wallets={[...keplrWallets, ...stationWallets, ...terraClassicWcWallets]}
      walletConnectOptions={{
        signClient: {
          projectId: WC_PROJECT_ID,
          metadata: {
            name: 'FRG Hold & Earn',
            description: 'Hold FRG in your own wallet, earn rewards on Luna Classic',
            url: 'https://frg-hold-earn-production.up.railway.app/',
            icons: [],
            redirect: {
              native: 'https://frg-hold-earn-production.up.railway.app/',
              universal: 'https://frg-hold-earn-production.up.railway.app/',
            },
          },
        },
      }}
      signerOptions={{
        signingCosmwasm: () => ({ gasPrice: GasPrice.fromString('0.15uluna') }),
      }}
      modalTheme={{ defaultTheme: 'dark' }}
    >
      <App />
    </ChainProvider>
  </React.StrictMode>
);

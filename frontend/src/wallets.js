// Custom WalletConnect wallet for a Terra Classic community wallet that
// is not listed in the WalletConnect explorer registry (so no upstream
// Cosmos Kit package exists for it):
//
//   - Galaxy Station — the Terra Classic community Station fork
//     (https://station.terraclassic.community). In its in-app browser it
//     injects window.station, which the @cosmos-kit/station extension entry
//     already covers; this entry adds the standard Cosmos WalletConnect
//     pairing flow (QR / copy-link / mobile deep link) for desktop and
//     other mobile browsers.
//
// Built exactly like @cosmos-kit/keplr-mobile / station-mobile: a WCWallet
// (from @cosmos-kit/walletconnect) whose chain wallets are ChainWC
// instances backed by the generic WCClient, which speaks the standard
// Cosmos namespace (cosmos_getAccounts / cosmos_signAmino /
// cosmos_signDirect). Because the wallet is not in the WC explorer
// registry, no registry `projectId` / deep-link listing exists — the
// mobile app links below are wired by hand (see formatNativeUrl).
//
// NOTE: LUNCDash was removed 2026-10-23 — it speaks only the legacy
// WalletConnect v1 bridge protocol, which Cosmos Kit cannot use; a dead
// connect button is worse than none. Revisit only with a custom v1
// connector.
import { ChainWC, WCClient, WCWallet } from '@cosmos-kit/walletconnect';

// Galaxy Station has no WalletConnect Explorer listing (no listing ID),
// so WCClient's Explorer lookup leaves wcCloudInfo undefined and
// initAppUrl() throws before it can fall back to the registry `mobile`
// links above — leaving redirect permanently false and the modal stuck
// on the QR view. Seed an empty wcCloudInfo so the fallback is reached
// (the same pattern @cosmos-kit/keplr-mobile uses with its custom
// client subclass).
class GalaxyClient extends WCClient {
  async initWCCloudInfo() {
    this.wcCloudInfo = { mobile: {} };
  }
}

export const galaxyStationInfo = {
  name: 'galaxy-station',
  prettyName: 'Galaxy Station',
  logo: 'https://station.terraclassic.community/favicon.svg',
  mode: 'wallet-connect',
  mobileDisabled: false,
  rejectMessage: {
    source: 'Request rejected',
  },
  downloads: [
    {
      link: 'https://station.terraclassic.community',
    },
  ],
  supportedChains: ['terraclassic'],
  walletconnect: {
    name: 'Galaxy Station',
    // Galaxy Station returns base64-encoded pubkeys; with the client
    // default ('hex') account decoding after approval would be wrong.
    encoding: 'base64',
    mobile: {
      // Real app links, proven in the FRG Fight Club build — NOT the
      // project website. Android goes through the Hexxagon intent link;
      // iOS only answers to its native scheme (the HTTPS site just loads
      // the web dashboard and strands the user).
      native: {
        ios: 'galaxystation:',
        android: 'https://station.hexxagon.io/wcV2',
      },
    },
    // Composes the pairing deep link from the native app URL + the
    // WalletConnect URI, modeled on @cosmos-kit/keplr-mobile:
    //   iOS:     galaxystation://wcV2?<encoded wc uri>
    //   Android: https://station.hexxagon.io/wcV2?<encoded wc uri>
    //            #Intent;package=io.hexxagon.station;scheme=galaxystation;end;
    formatNativeUrl: (appUrl, wcUri, os, _name) => {
      const encodedWcUrl = encodeURIComponent(wcUri);
      switch (os) {
        case 'ios':
          return `galaxystation://wcV2?${encodedWcUrl}`;
        case 'android':
          return `${appUrl}?${encodedWcUrl}#Intent;package=io.hexxagon.station;scheme=galaxystation;end;`;
        default:
          return `galaxystation://wcV2?${encodedWcUrl}`;
      }
    },
  },
};

export class ChainGalaxyStation extends ChainWC {
  constructor(walletInfo, chainInfo) {
    super(walletInfo, chainInfo, GalaxyClient);
  }
}

export class GalaxyStationWallet extends WCWallet {
  constructor(walletInfo) {
    super(walletInfo, ChainGalaxyStation, GalaxyClient);
  }
}

const galaxyStation = new GalaxyStationWallet(galaxyStationInfo);

export const wallets = [galaxyStation];

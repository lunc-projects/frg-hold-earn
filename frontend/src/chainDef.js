// Custom Terra Classic (columbus-5) chain definition for Cosmos Kit.
// Columbus-5 is not in the upstream chain-registry package used by
// Cosmos Kit, so the app ships its own minimal Chain + AssetList.
// (Same pattern as the FRG staking app.)
import { LCD_URL, RPC_URL } from './config.js';

export const terraClassicChain = {
  $schema: '../chain.schema.json',
  chain_name: 'terraclassic',
  status: 'live',
  network_type: 'mainnet',
  pretty_name: 'Terra Classic',
  chain_id: 'columbus-5',
  bech32_prefix: 'terra',
  daemon_name: 'terrad',
  node_home: '$HOME/.terra',
  slip44: 330,
  fees: {
    fee_tokens: [
      { denom: 'uluna', fixed_min_gas_price: 0.15, low_gas_price: 0.15, average_gas_price: 0.15, high_gas_price: 0.15 },
    ],
  },
  staking: { staking_tokens: [{ denom: 'uluna' }] },
  codebase: { git_repo: 'https://github.com/classic-terra/core', recommended_version: 'v4.1.1', compatible_versions: ['v4.1.1'] },
  apis: {
    rpc: [{ address: RPC_URL, provider: 'PublicNode' }],
    rest: [{ address: LCD_URL, provider: 'PublicNode' }],
    grpc: [],
  },
  explorers: [{ kind: 'Terra Finder', url: 'https://finder.terraclassic.community/mainnet', tx_page: 'https://finder.terraclassic.community/mainnet/tx/${txHash}' }],
};

export const terraClassicAssets = {
  $schema: '../assetlist.schema.json',
  chain_name: 'terraclassic',
  assets: [
    {
      description: 'The native staking and gas token of Terra Classic.',
      denom_units: [
        { denom: 'uluna', exponent: 0 },
        { denom: 'luna', exponent: 6 },
      ],
      base: 'uluna',
      name: 'Terra Luna Classic',
      display: 'luna',
      symbol: 'LUNC',
      logo_URIs: { png: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/terraclassic/images/lunc.png' },
      coingecko_id: 'terra-luna',
    },
  ],
};

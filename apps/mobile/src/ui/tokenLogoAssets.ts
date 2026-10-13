/**
 * The bundled token logos (SEN-214). Metro bundles only the images it can see
 * imported by a literal path, so every logo has its own line;
 * `tokenLogos.test.ts` checks this map against `TOKEN_LOGOS` and the files on
 * disk.
 */
import type { ImageSourcePropType } from 'react-native';

import ausd from '../../assets/tokens/ausd.png';
import avax from '../../assets/tokens/avax.png';
import btc from '../../assets/tokens/btc.png';
import cbbtc from '../../assets/tokens/cbbtc.png';
import doge from '../../assets/tokens/doge.png';
import eth from '../../assets/tokens/eth.png';
import lit from '../../assets/tokens/lit.png';
import mon from '../../assets/tokens/mon.png';
import near from '../../assets/tokens/near.png';
import pump from '../../assets/tokens/pump.png';
import sol from '../../assets/tokens/sol.png';
import usdc from '../../assets/tokens/usdc.png';
import usdt from '../../assets/tokens/usdt.png';
import wbtc from '../../assets/tokens/wbtc.png';
import xaut from '../../assets/tokens/xaut.png';
import zec from '../../assets/tokens/zec.png';

import type { TokenLogo } from './tokenLogos';

export const TOKEN_LOGO_ASSETS: Record<TokenLogo, ImageSourcePropType> = {
  ausd,
  avax,
  btc,
  cbbtc,
  doge,
  eth,
  lit,
  mon,
  near,
  pump,
  sol,
  usdc,
  usdt,
  wbtc,
  xaut,
  zec,
};

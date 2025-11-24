import { ipWhitelist } from './js/utilities/ipWhitelist.js';

export const handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({ ipWhitelist })
  };
};

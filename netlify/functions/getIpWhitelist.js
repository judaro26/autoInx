const { ipWhitelist } = require('./js/utilities/ipWhitelist.js');

exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({ ipWhitelist })
  };
};

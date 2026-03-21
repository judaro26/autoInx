exports.handler = async (event) => {
  console.log('🟢 ebaySyncOrders handler reached');
  console.log('httpMethod:', event?.httpMethod);
  console.log('ENV CHECK - PROJECT_ID:', process.env.FIREBASE_PROJECT_ID ? '✅ set' : '❌ missing');
  console.log('ENV CHECK - EBAY_CLIENT_ID:', process.env.EBAY_CLIENT_ID ? '✅ set' : '❌ missing');
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, message: 'test handler reached' })
  };
};

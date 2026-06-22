const { MongoClient } = require('mongodb');
require('dotenv').config();
(async () => {
  const url = process.env.MONGODB_URL || process.env.MONGODB_URI;
  if (!url) {
    console.error('No MongoDB URL configured');
    process.exit(1);
  }
  const client = new MongoClient(url, { useUnifiedTopology: true });
  await client.connect();
  const dbName = process.env.MONGODB_DB_NAME || 'BuscorTeriffs';
  const db = client.db(dbName);
  const col = db.collection('cards');
  const doc = await col.findOne({}, { projection: { Alias_No: 1, aliasNo: 1, alias: 1, AliasNo: 1, isActive: 1, _id: 0 } });
  console.log('sample card doc:', JSON.stringify(doc, null, 2));
  const count = await col.countDocuments();
  console.log('cards count:', count);
  await client.close();
})();

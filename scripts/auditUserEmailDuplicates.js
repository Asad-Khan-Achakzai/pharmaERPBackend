/**
 * Detect duplicate emails across users (blocks migrating to a global unique email index).
 *
 * Run: node scripts/auditUserEmailDuplicates.js
 * Exit 0: no duplicate emails
 * Exit 1: duplicate groups found (do NOT apply new index until resolved manually)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

const run = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    // eslint-disable-next-line no-console
    console.error('MONGODB_URI (or MONGO_URI) is not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  // eslint-disable-next-line no-console
  console.log('Connected. Auditing user emails (including soft-deleted if present in collection)…');

  const dups = await User.collection
    .aggregate([
      { $group: { _id: { $toLower: '$email' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } }
    ])
    .toArray();

  if (dups.length === 0) {
    // eslint-disable-next-line no-console
    console.log('OK: No duplicate emails found. You can drop the old compound index and sync indexes, e.g.');
    // eslint-disable-next-line no-console
    console.log('  db.users.dropIndex("companyId_1_email_1")');
    await mongoose.disconnect();
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.error(`Found ${dups.length} email(s) with more than one user document (after lowercasing):`);
  for (const d of dups) {
    // eslint-disable-next-line no-console
    console.error(`  email="${d._id}"  count=${d.count}  ids=${d.ids.map((id) => id.toString()).join(', ')}`);
  }
  // eslint-disable-next-line no-console
  console.error('\nResolve duplicates manually before deploying the global unique index on { email: 1 }.');

  await mongoose.disconnect();
  process.exit(1);
};

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

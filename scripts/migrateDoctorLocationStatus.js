/**
 * Idempotent migration: set locationStatus = UNVERIFIED for doctors missing the field.
 * Does NOT populate latitude/longitude.
 *
 * Usage: node scripts/migrateDoctorLocationStatus.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../src/config/env');
const Doctor = require('../src/models/Doctor');

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const res = await Doctor.updateMany(
    {
      $or: [{ locationStatus: { $exists: false } }, { locationStatus: null }]
    },
    { $set: { locationStatus: 'UNVERIFIED' } }
  );
  console.log(`Updated ${res.modifiedCount} doctor(s) to locationStatus=UNVERIFIED`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

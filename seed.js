#!/usr/bin/env node
/** Back-compat wrapper for `node seed.js` — same as `node scripts/seed/index.js`. */
require('dotenv').config();
const { run } = require('./scripts/seed/index.js');
run().catch((e) => {
  console.error(e);
  process.exit(1);
});

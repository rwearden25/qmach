#!/usr/bin/env node
// Usage: npm run hash-password -- <password>
//        node scripts/hash-password.js <password>
//
// Prints a bcrypt hash suitable for dropping into the `password` field of
// a QMACH_USERS entry. Run this locally (or anywhere with Node), paste the
// output — never store plaintext passwords in Railway env vars.

const bcrypt = require('bcryptjs');

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: node scripts/hash-password.js <password>');
  console.error('Example QMACH_USERS value after hashing:');
  console.error('  [{"id":"ross","password":"$2a$10$...","name":"Ross"}]');
  process.exit(1);
}

const rounds = 10;
const hash = bcrypt.hashSync(pw, rounds);
console.log(hash);
